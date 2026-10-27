/* Tracked parlays: one shared store (the builder, Hub My Bets and Hub My Stats all use it), saved under
   the same key the old Parlay Builder used, so parlays tracked before the rebuild carry over.

   Legs settle automatically: syncParlayResults() reads each sport's board log (graded by that sport's
   Board Log "Settle") and its tracked bets (graded by My Bets "Settle finished"), matching each leg by
   its board-log id, the tracked bet it came from, or the same game / player / market / line / side.
   A result you set by hand on a leg is never overwritten. */
import { useSyncExternalStore } from "react";
import { getBets } from "../core/betStore";
import { americanToDecimal } from "./model";

const LS_KEY = "parlay_builder_tracked_v1";
const load = () => { try { const v = JSON.parse(localStorage.getItem(LS_KEY)); return Array.isArray(v) ? v : []; } catch { return []; } };
let parlays = load();
const listeners = new Set();

export const getParlays = () => parlays;
export function setParlays(next) {
  const v = typeof next === "function" ? next(parlays) : next;
  if (v === parlays) return;
  parlays = v;
  try { localStorage.setItem(LS_KEY, JSON.stringify(v)); } catch { /* storage unavailable */ }
  for (const fn of listeners) fn();
}
export function subscribeParlays(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function useParlays() { return useSyncExternalStore(subscribeParlays, getParlays); }

/* ---------------- grading ---------------- */
// book rules: void and push legs drop out (the parlay pays at the remaining legs' price); any loss loses it
export function gradeParlayLegs(legs) {
  if (!legs.length) return { status: "open" };
  const active = legs.filter((l) => l.result && l.result !== "void" && l.result !== "push");
  if (active.some((l) => l.result === "lost")) return { status: "lost" };
  if (legs.some((l) => !l.result)) return { status: "open" };
  if (active.length === 0) return { status: "push" };
  return { status: "won" };
}
export function parlayProfitUnits(status, legs, units = 1) {
  if (status === "lost") return -units;
  if (status !== "won") return 0;
  const dec = legs.filter((l) => l.result === "won").reduce((p, l) => p * (l.odds != null ? americanToDecimal(l.odds) : 1), 1);
  return units * (dec - 1);
}
export const unitsOf = (p) => (p.units != null && p.units !== "" && !isNaN(p.units) ? Number(p.units) : 1);
// the slate a parlay belongs to: its latest leg's date (falls back to the day it was built)
export const parlayDate = (p) => p.legs.map((l) => l.date).filter(Boolean).sort().pop() || String(p.builtAt || "").slice(0, 10);

/* ---------------- tracking / editing ---------------- */
export const legSetKey = (legs) => legs.map((l) => l.poolId || l.matchKey).sort().join("|");
export function trackParlay(c, units = 1) {
  const rec = {
    id: `plb_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, builtAt: new Date().toISOString(), units,
    legs: c.legs.map((l) => ({ ...l, result: null, actualStat: null, settled: false })),
    builtDecimal: c.decimal, builtAmerican: c.american, builtModelP: c.modelP, builtFairP: c.fairP, builtEdge: c.edge, builtEV: c.ev,
    sgp: c.sgp, status: "open",
  };
  setParlays((p) => [rec, ...p]);
  return rec;
}
export const removeParlay = (id) => setParlays((p) => p.filter((x) => x.id !== id));
export const setParlayUnits = (id, units) => setParlays((p) => p.map((x) => (x.id === id ? { ...x, units: units === "" ? "" : Math.max(0, Number(units)) } : x)));
// a leg result set by hand (null clears it, letting automatic settlement fill it again)
export function setLegResult(id, idx, result) {
  setParlays((p) => p.map((x) => {
    if (x.id !== id) return x;
    const legs = x.legs.map((l, i) => (i === idx ? { ...l, result, settled: !!result, manual: !!result } : l));
    return { ...x, legs, status: gradeParlayLegs(legs).status };
  }));
}

/* ---------------- automatic leg settlement ---------------- */
// sports: the hub's sport list ({ id, sport }). -> number of legs newly graded
export async function syncParlayResults(sports) {
  const open = parlays.filter((p) => p.legs.some((l) => !l.result));
  if (!open.length) return 0;
  const need = new Set(open.flatMap((p) => p.legs.filter((l) => !l.result).map((l) => l.sport)));
  const lookups = {};
  for (const s of sports) {
    if (!need.has(s.id)) continue;
    const byLog = new Map(), byMatch = new Map(), byBet = new Map();
    try {
      await s.sport.storage.boardLogReady;
      for (const r of s.sport.storage.loadBoardLog()) {
        if (!r.settled || !r.result) continue;
        const v = { result: r.result, actual: r.actualStat };
        byLog.set(r.logId, v);
        byMatch.set(`${s.id}|${r.gamePk}|${r.playerId || ""}|${r.type}|${r.line}|${r.side}`, v);
      }
    } catch { /* board log unavailable: tracked bets below can still settle legs */ }
    for (const b of getBets(s.sport)) {
      if (b.status === "open") continue;
      const v = { result: b.status, actual: b.actual };
      byBet.set(b.key, v);
      byMatch.set(`${s.id}|${b.gamePk}|${b.playerId || ""}|${b.type}|${b.line}|${b.side}`, v);
    }
    lookups[s.id] = { byLog, byMatch, byBet };
  }
  let graded = 0;
  setParlays((all) => all.map((p) => {
    let changed = false;
    const legs = p.legs.map((l) => {
      if (l.result) return l;
      const lk = lookups[l.sport];
      if (!lk) return l;
      const hit = (l.logId && lk.byLog.get(l.logId)) || (l.betKey && lk.byBet.get(l.betKey)) || lk.byMatch.get(l.matchKey);
      if (!hit) return l;
      changed = true; graded++;
      return { ...l, result: hit.result, actualStat: hit.actual ?? null, settled: true };
    });
    return changed ? { ...p, legs, status: gradeParlayLegs(legs).status } : p;
  }));
  return graded;
}

/* ---------------- stats (same shape as core/bets betStats) ---------------- */
export function parlayStats(list, { start = "", end = "" } = {}) {
  let settled = list.filter((p) => p.status === "won" || p.status === "lost" || p.status === "push");
  if (start) settled = settled.filter((p) => parlayDate(p) >= start);
  if (end) settled = settled.filter((p) => parlayDate(p) <= end);
  const agg = (arr) => {
    const w = arr.filter((p) => p.status === "won").length, l = arr.filter((p) => p.status === "lost").length, ps = arr.filter((p) => p.status === "push").length;
    const net = arr.reduce((s, p) => s + parlayProfitUnits(p.status, p.legs, unitsOf(p)), 0);
    const staked = arr.filter((p) => p.status !== "push").reduce((s, p) => s + unitsOf(p), 0);
    const flatNet = arr.reduce((s, p) => s + parlayProfitUnits(p.status, p.legs, 1), 0);
    const flatRisked = w + l;
    return { n: arr.length, w, l, ps, v: 0, winPct: flatRisked ? w / flatRisked : null, net, staked, roi: staked ? net / staked : null, flatNet, flatRoi: flatRisked ? flatNet / flatRisked : null };
  };
  const byType = {}, typeOrder = [];
  for (const n of [...new Set(settled.map((p) => p.legs.length))].sort((a, b) => a - b)) { const k = `${n}-leg`; byType[k] = agg(settled.filter((p) => p.legs.length === n)); typeOrder.push(k); }
  return { overall: agg(settled), byType, typeOrder, openCount: list.filter((p) => p.status === "open").length };
}

/* ---------------- CSV ---------------- */
export function parlaysCsv(list) {
  const esc = (v) => { if (v == null) return ""; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const fo = (o) => (o == null || isNaN(o) ? "" : o > 0 ? `+${o}` : `${o}`);
  const lines = [["built_at", "slate_date", "legs", "sgp", "combined_odds", "combined_model_pct", "combined_fair_pct", "edge_pct", "ev_pct", "units", "status", "profit_units", "leg_detail"].join(",")];
  for (const p of list) {
    const legDetail = p.legs.map((l) => `${String(l.sport).toUpperCase()}:${l.name || l.game} ${l.type} ${l.line} ${l.side} (${fo(l.odds)}) [${l.result || "open"}]`).join(" | ");
    lines.push([esc(p.builtAt), parlayDate(p), p.legs.length, p.sgp ? "yes" : "no", fo(p.builtAmerican),
      (p.builtModelP * 100).toFixed(1), (p.builtFairP * 100).toFixed(1), (p.builtEdge * 100).toFixed(1), (p.builtEV * 100).toFixed(1),
      unitsOf(p), p.status, parlayProfitUnits(p.status, p.legs, unitsOf(p)).toFixed(2), esc(legDetail)].join(","));
  }
  return lines.join("\n");
}
