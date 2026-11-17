/* Pieces shared by the hub pages. */
import React from "react";
import { betStats } from "../core/bets";
import { profitUnits } from "../core/math";
import { MenuBtn, fDay } from "../ui/kit";
import { parlayDate, parlayProfitUnits, unitsOf } from "../parlay/store";
import { HUB_SPORTS } from "./sports";

// the page's top bar: title on the left, the page's actions on the right
export function HubTop({ title, children = null }) {
  return <header className="top"><MenuBtn /><h1>{title}</h1><span className="grow" />{children}</header>;
}
// sport selector options for the hub pages (parlays optional)
export const SPORT_SEG = [["all", "All sports"], ...HUB_SPORTS.map((s) => [s.id, s.label])];
export const BET_SEG = [...SPORT_SEG, ["parlays", "Parlays"]];
export const isSettled = (b) => b.status === "won" || b.status === "lost" || b.status === "push" || b.status === "void";
export const betUnits = (b) => (b.units != null && b.units !== "" && !isNaN(b.units) ? Number(b.units) : 1);
export const betNet = (b) => profitUnits(b.status, Number(b.odds), betUnits(b)) || 0;

/* Running totals by slate date for the units chart: your stakes against a flat 1 unit on every bet.
   bets: settled tracked bets. parlays: settled tracked parlays (optional). */
export function dailySeries(bets, parlays = []) {
  const days = {};
  const add = (d, net, flat) => { if (!d) return; const x = (days[d] = days[d] || { net: 0, flat: 0 }); x.net += net; x.flat += flat; };
  for (const b of bets) if (isSettled(b)) add(b.date, betNet(b), profitUnits(b.status, Number(b.odds), 1) || 0);
  for (const p of parlays) if (p.status !== "open") add(parlayDate(p), parlayProfitUnits(p.status, p.legs, unitsOf(p)), parlayProfitUnits(p.status, p.legs, 1));
  let a = 0, f = 0; const labels = [], staked = [], flat = [];
  for (const d of Object.keys(days).sort()) { a += days[d].net; f += days[d].flat; labels.push(fDay(d).replace(/^\w+, /, "")); staked.push(+a.toFixed(2)); flat.push(+f.toFixed(2)); }
  return { labels, staked, flat };
}

/* Stats across every sport: the overall line over all bets, plus each sport's own stats and its
   per-market rows labeled "NBA · Points" etc. (NBA and NHL both have a Points market, so markets are
   never merged across sports). typeOrder lists those labels in sport, then market, order. */
export function combinedStats(all, range) {
  const everything = HUB_SPORTS.flatMap((s) => all[s.id]);
  const base = betStats(everything, range, []);
  const bySport = {}, byType = {}, typeOrder = [];
  for (const s of HUB_SPORTS) {
    const st = betStats(all[s.id], range, s.sport.config.STAT_ORDER);
    bySport[s.id] = st;
    for (const t of s.sport.config.STAT_ORDER) if (st.byType[t]) { const k = `${s.label} · ${t}`; byType[k] = st.byType[t]; typeOrder.push(k); }
  }
  return { ...base, byType, typeOrder, bySport };
}

// add parlay results into an overall stats line (same fields as betStats' overall)
export function mergeOverall(a, b) {
  const s = { n: a.n + b.n, w: a.w + b.w, l: a.l + b.l, ps: a.ps + b.ps, v: a.v + b.v, net: a.net + b.net, staked: a.staked + b.staked, flatNet: a.flatNet + b.flatNet };
  const flatRisked = s.w + s.l;
  return { ...s, winPct: flatRisked ? s.w / flatRisked : null, roi: s.staked ? s.net / s.staked : null, flatRoi: flatRisked ? s.flatNet / flatRisked : null };
}
