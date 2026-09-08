import React, { useMemo, useState } from "react";

/* ============================================================================
   Parlay Builder — shared, cross-sport tab (lives in Root.tsx alongside
   MLB/NFL/NBA Edge Finder). This tool does NOT run its own projection model.
   It ingests the "Board Log" CSV export that already exists in every sport
   app (Stats tab → "Export CSV" on the board log), which already carries
   each candidate's model probability, de-vigged fair probability, edge, and
   EV — computed by that sport's own engine. This tool's job is purely to:
     1. pool candidates from one or more pasted CSVs (any mix of sports),
     2. filter/rank them,
     3. combine legs into parlays and grade the *combination* in the same
        EV/edge language as a single bet,
     4. track built parlays, and settle them by re-matching against a
        freshly re-exported (already-settled) Board Log CSV — i.e. it
        reuses each sport app's own "Settle Full Board Log" results rather
        than re-implementing live score-fetching for three different APIs.

   Important honesty note (surfaced in the UI too): combined probability for
   a parlay is computed assuming leg independence (P = Π p_i). That's the
   standard textbook parlay math, but it understates true joint probability
   when legs come from the SAME game (correlated outcomes) — e.g. a team's
   Over + their star's Points Over tend to hit or miss together. Same-Game
   Parlay (SGP) legs are flagged in the UI for exactly this reason; treat
   their EV/edge numbers as optimistic.
============================================================================ */

/* ---------------------- shared math (self-contained; mirrors App.tsx) ---------------------- */
const impliedProb = (o) => (o < 0 ? -o / (-o + 100) : 100 / (o + 100));
const americanToDecimal = (o) => (o > 0 ? 1 + o / 100 : 1 + 100 / -o);
function decimalToAmerican(d) {
  const b = d - 1;
  if (b <= 0) return 0;
  return b >= 1 ? Math.round(b * 100) : Math.round(-100 / b);
}
function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}
function fmtPct(x, d = 1) { return x == null ? "—" : `${(x * 100).toFixed(d)}%`; }
function fmtOdds(o) { if (o == null || isNaN(o)) return "—"; return o > 0 ? `+${o}` : `${o}`; }
const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };

const SPORTS = [
  { key: "mlb", label: "⚾ MLB" },
  { key: "nfl", label: "🏈 NFL" },
  { key: "nba", label: "🏀 NBA" },
];
// Risk scale used to be a hard MINIMUM COMBINED WIN PROBABILITY floor. That breaks down as soon
// as a parlay has more than 1-2 legs: combined probability is a PRODUCT of each leg's individual
// probability, so even a great 3-leg combo of genuine +EV longshots (say ~11% each) multiplies
// down to ~0.1% combined — nowhere close to even the loosest floor — and got silently thrown
// away despite being exactly the kind of longshot parlay a "Longshot" risk setting should surface.
// EV, unlike probability, does NOT collapse toward zero as legs multiply (a real edge on each leg
// compounds into a real, often LARGER, combined edge), so it's the correct universal floor: any
// combo with combined EV <= 0 is excluded (never recommend a -EV parlay) regardless of risk level.
// Risk level instead controls how the (always +EV) survivors are RANKED — never what's excluded.
const RISK_LEVELS = [
  { level: 1, label: "Very Safe", sort: "prob", hint: "ranks by highest combined win probability" },
  { level: 2, label: "Safe", sort: "prob", hint: "ranks by highest combined win probability" },
  { level: 3, label: "Balanced", sort: "ev", hint: "ranks by highest combined EV" },
  { level: 4, label: "Aggressive", sort: "payout", hint: "ranks by highest combined payout" },
  { level: 5, label: "Longshot", sort: "payout", hint: "ranks by highest combined payout" },
];

/* ---------------------- CSV parsing (Board Log export format) ---------------------- */
function parseCsvRows(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (q) { if (c === '"' && n === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else { if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ""; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ""; } else if (c !== '\r') cell += c; }
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => r.some((x) => x !== "")).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}
function normalizeLeg(row, sport) {
  const gamePk = row.gamePk || "";
  const odds = numOrNull(row.odds);
  const novig = numOrNull(row.novig);
  const modelP = numOrNull(row.calibratedP) ?? numOrNull(row.rawModelP);
  const edge = numOrNull(row.edge) ?? (modelP != null && novig != null ? modelP - novig : null);
  const ev = numOrNull(row.ev);
  const settled = String(row.settled).toLowerCase() === "true";
  const result = (row.result || "").toLowerCase() || null; // won / lost / push / void / ""
  const matchKey = `${sport}|${gamePk}|${row.playerId || ""}|${row.type}|${row.line}|${row.side}`;
  return {
    // keyed by "the same bet" (sport+game+player+market+line+side), NOT by logId — the board
    // log re-logs every candidate on every board refresh, so the same bet can appear dozens of
    // times with different logIds/timestamps. Pooling on matchKey collapses those snapshots.
    poolId: matchKey,
    logId: row.logId || "",
    loggedAt: row.loggedAt || "",
    sport,
    dateLabel: row.date || (row.week ? `Wk ${row.week}` : ""),
    game: row.game || "",
    gamePk,
    gameKey: `${sport}:${gamePk}`,
    // groups the two sides (and any alternate lines) of the SAME market together, so the "best
    // side only" pool filter can collapse over-vs-under duplicates down to whichever one the
    // model actually favors.
    marketKey: `${sport}|${gamePk}|${row.playerId || ""}|${row.type}|${row.line}`,
    playerId: row.playerId || "",
    name: row.name || "",
    type: row.type || "",
    line: row.line || "",
    side: row.side || "",
    odds,
    novig,
    modelP,
    edge,
    ev,
    proj: numOrNull(row.proj),
    settled,
    actualStat: row.actualStat || null,
    result,
    matchKey,
  };
}

/* ---------------------- parlay combination math ---------------------- */
function combineLegs(legs) {
  let dec = 1, modelP = 1, fairP = 1;
  for (const l of legs) {
    dec *= l.odds != null ? americanToDecimal(l.odds) : 1;
    modelP *= l.modelP != null ? l.modelP : (l.novig != null ? l.novig : (l.odds != null ? impliedProb(l.odds) : 0.5));
    fairP *= l.novig != null ? l.novig : (l.odds != null ? impliedProb(l.odds) : 0.5);
  }
  const american = decimalToAmerican(dec);
  const ev = modelP * (dec - 1) - (1 - modelP);
  const edge = modelP - fairP;
  const sgp = new Set(legs.map((l) => l.gameKey)).size < legs.length;
  return { decimal: dec, american, modelP, fairP, ev, edge, sgp };
}
// Standard book grading: void AND push legs are removed from the parlay (it collapses to the
// remaining legs' combined price). Any remaining loss loses the whole thing.
function gradeParlayLegs(legs) {
  if (!legs.length) return { status: "open" };
  const active = legs.filter((l) => l.result && l.result !== "void" && l.result !== "push");
  const stillOpen = legs.filter((l) => !l.result);
  if (active.some((l) => l.result === "lost")) return { status: "lost" };
  if (stillOpen.length > 0) return { status: "open" };
  // everything settled at this point
  if (active.length === 0) return { status: "push" }; // whole parlay voided out
  if (active.every((l) => l.result === "won")) return { status: "won", activeLegs: active };
  return { status: "open" };
}
function parlayProfitUnits(status, legs, units = 1) {
  if (status === "lost") return -units;
  if (status === "push") return 0;
  if (status !== "won") return 0;
  const active = legs.filter((l) => l.result === "won");
  const dec = active.reduce((p, l) => p * (l.odds != null ? americanToDecimal(l.odds) : 1), 1);
  return units * (dec - 1);
}

/* ---------------------- combinatorial generator (bounded) ---------------------- */
function generateCombos(pool, minLegs, maxLegs, allowSGP, maxPerGame, budgetMs = 1800, capResults = 250000) {
  const n = pool.length;
  const out = [];
  const start = Date.now();
  let explored = 0;
  const gameCounts = new Map();
  function backtrack(startIdx, chosen) {
    if (out.length >= capResults) return;
    if (explored % 4096 === 0 && Date.now() - start > budgetMs) return;
    if (chosen.length >= minLegs) out.push(chosen.slice());
    if (chosen.length === maxLegs) return;
    for (let i = startIdx; i < n; i++) {
      explored++;
      if (out.length >= capResults) return;
      if (explored % 4096 === 0 && Date.now() - start > budgetMs) return;
      const gk = pool[i].gameKey;
      const cnt = gameCounts.get(gk) || 0;
      if (!allowSGP && cnt >= 1) continue;
      if (allowSGP && cnt >= maxPerGame) continue;
      gameCounts.set(gk, cnt + 1);
      chosen.push(i);
      backtrack(i + 1, chosen);
      chosen.pop();
      gameCounts.set(gk, cnt);
    }
  }
  backtrack(0, []);
  return out;
}

/* ---------------------- persistence ---------------------- */
const LS_TRACKED = "parlay_builder_tracked_v1";
function loadTracked() { try { return JSON.parse(localStorage.getItem(LS_TRACKED)) || []; } catch { return []; } }
function saveTracked(arr) { try { localStorage.setItem(LS_TRACKED, JSON.stringify(arr)); } catch { /* storage unavailable */ } }

/* ---------------------- tiny UI primitives ---------------------- */
function Chip({ active, onClick, children, tone = "slate" }) {
  const tones = {
    slate: active ? "bg-slate-100 text-slate-900 border-slate-100" : "bg-slate-900 text-slate-300 border-slate-700 hover:border-slate-500",
    emerald: active ? "bg-emerald-500 text-slate-950 border-emerald-500" : "bg-slate-900 text-slate-300 border-slate-700 hover:border-emerald-600",
  };
  return <button onClick={onClick} className={`text-[11px] font-semibold rounded-full px-2.5 py-1 border ${tones[tone]}`}>{children}</button>;
}
function ResultBadge({ result }) {
  if (!result) return <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">open</span>;
  const map = {
    won: "bg-emerald-600 text-white", lost: "bg-rose-600 text-white",
    push: "bg-amber-500 text-slate-950", void: "bg-slate-600 text-slate-100",
  };
  return <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${map[result] || "bg-slate-700 text-slate-200"}`}>{result}</span>;
}
// A single leg rendered "bet-slip" style — one row: sport tag, player/game + market/line/side,
// odds right-aligned, with an optional trailing slot for a result badge / settle buttons.
function LegRow({ leg, index, right }) {
  return (
    <div className={`flex items-center gap-2.5 px-2.5 py-1.5 ${index > 0 ? "border-t border-slate-800" : ""} bg-slate-900/60`}>
      <span className="text-[9px] font-bold text-slate-500 w-8 shrink-0">{leg.sport.toUpperCase()}</span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold text-slate-100 truncate">{leg.name || leg.game}</div>
        <div className="text-[11px] text-slate-500 truncate">{leg.game && leg.name ? `${leg.game} · ` : ""}{leg.type} {leg.line} <span className="uppercase text-slate-400">{leg.side}</span></div>
      </div>
      <span className="text-sm font-bold shrink-0" style={mono}>{fmtOdds(leg.odds)}</span>
      {right}
    </div>
  );
}

/* ============================================================================ */
export default function ParlayBuilder() {
  const [subTab, setSubTab] = useState("build"); // build | tracked | stats

  /* ---- CSV intake blocks ---- */
  const [blocks, setBlocks] = useState([{ id: 1, sport: "mlb", text: "" }]);
  const [pool, setPool] = useState([]); // normalized legs, deduped by poolId
  const [poolMsg, setPoolMsg] = useState("");

  function addBlock() { setBlocks((b) => [...b, { id: (b[b.length - 1]?.id || 0) + 1, sport: "mlb", text: "" }]); }
  function removeBlock(id) { setBlocks((b) => (b.length > 1 ? b.filter((x) => x.id !== id) : b)); }
  function updateBlock(id, patch) { setBlocks((b) => b.map((x) => (x.id === id ? { ...x, ...patch } : x))); }

  function addAllToPool() {
    // The board log re-logs every candidate on every board refresh, so the same exact bet
    // (same market + line + side) can show up dozens/hundreds of times with different logIds
    // as the day goes on. Collapse those to one row per bet, keeping the most recently logged
    // snapshot (freshest odds/model read) — merge into the existing pool so re-adding another
    // CSV later updates rather than duplicates.
    const merged = new Map(pool.map((l) => [l.poolId, l]));
    let parsedRows = 0, blank = 0;
    for (const blk of blocks) {
      if (!blk.text.trim()) continue;
      const rows = parseCsvRows(blk.text);
      for (const r of rows) {
        if (!r.type && !r.name) { blank++; continue; }
        parsedRows++;
        const leg = normalizeLeg(r, blk.sport);
        const existing = merged.get(leg.poolId);
        if (!existing || String(leg.loggedAt || "") >= String(existing.loggedAt || "")) merged.set(leg.poolId, leg);
      }
    }
    const next = [...merged.values()];
    const collapsed = parsedRows - next.length + pool.length;
    setPool(next);
    setPoolMsg(`Parsed ${parsedRows} row(s) → ${next.length} unique bet(s) in the pool${collapsed > 0 ? ` (collapsed ${collapsed} repeated board-refresh snapshot(s) of the same bet, kept the most recent each)` : ""}${blank ? `; ${blank} blank row(s) skipped` : ""}.`);
  }
  function clearPool() { if (window.confirm("Clear the entire candidate pool?")) { setPool([]); setSelectedIds(new Set()); setPoolMsg(""); } }

  /* ---- pool filters ---- */
  const [fSports, setFSports] = useState(new Set(["mlb", "nfl", "nba"]));
  const [fTypes, setFTypes] = useState(new Set());
  const [fMinEdge, setFMinEdge] = useState("");
  const [fMinEV, setFMinEV] = useState("");
  const [fSearch, setFSearch] = useState("");
  const [fOnlyOpen, setFOnlyOpen] = useState(true);
  // The board log carries BOTH sides of every market (over and under, or every alt line) as
  // separate rows, since it logs everything the board ever showed. Only one side of a given
  // market is ever worth putting in a parlay — the one the model actually favors — so by
  // default collapse each (game, player, market, line) group down to its single highest-EV
  // side. Turn off to line-shop / eyeball both sides yourself.
  const [fBestSide, setFBestSide] = useState(true);
  // Explicit side control (e.g. exclude "under" entirely) — this is the general fix for markets
  // like Home Run where the "under" side is almost never worth taking: rather than hardcoding
  // that special case, let the user turn any side off pool-wide. Set of EXCLUDED sides; empty =
  // nothing excluded (all sides shown), matching the chips' default "all on" appearance.
  const [fSideExclude, setFSideExclude] = useState(new Set());

  const allTypes = useMemo(() => [...new Set(pool.map((l) => l.type).filter(Boolean))].sort(), [pool]);
  const allSides = useMemo(() => [...new Set(pool.map((l) => l.side).filter(Boolean))].sort(), [pool]);

  const filteredPool = useMemo(() => {
    const minEdge = fMinEdge === "" ? null : Number(fMinEdge) / 100;
    const minEV = fMinEV === "" ? null : Number(fMinEV) / 100;
    const q = fSearch.trim().toLowerCase();
    let rows = pool
      .filter((l) => fSports.has(l.sport))
      .filter((l) => fTypes.size === 0 || fTypes.has(l.type))
      .filter((l) => !fSideExclude.has(l.side))
      .filter((l) => (fOnlyOpen ? !l.settled : true))
      .filter((l) => (minEdge == null || (l.edge != null && l.edge >= minEdge)))
      .filter((l) => (minEV == null || (l.ev != null && l.ev >= minEV)))
      .filter((l) => !q || l.name.toLowerCase().includes(q) || l.game.toLowerCase().includes(q));
    if (fBestSide) {
      const best = new Map(); // marketKey -> best-EV row for that (game, player, market, line)
      for (const l of rows) {
        const cur = best.get(l.marketKey);
        const score = l.ev != null ? l.ev : (l.edge != null ? l.edge : -Infinity);
        const curScore = cur ? (cur.ev != null ? cur.ev : (cur.edge != null ? cur.edge : -Infinity)) : -Infinity;
        if (!cur || score > curScore) best.set(l.marketKey, l);
      }
      rows = [...best.values()];
    }
    return rows.sort((a, b) => (b.edge ?? -99) - (a.edge ?? -99));
  }, [pool, fSports, fTypes, fSideExclude, fMinEdge, fMinEV, fSearch, fOnlyOpen, fBestSide]);

  function toggleSet(setFn, val) { setFn((prev) => { const n = new Set(prev); if (n.has(val)) n.delete(val); else n.add(val); return n; }); }

  /* ---- manual selection (build a custom parlay by hand) ---- */
  const [selectedIds, setSelectedIds] = useState(new Set());
  function toggleSelect(poolId) { toggleSet(setSelectedIds, poolId); }
  const selectedLegs = useMemo(() => filteredPool.filter((l) => selectedIds.has(l.poolId)).length
    ? pool.filter((l) => selectedIds.has(l.poolId)) : [], [pool, selectedIds, filteredPool]);
  const selectedCombined = selectedLegs.length >= 2 ? combineLegs(selectedLegs) : null;

  /* ---- generator options ---- */
  const [poolCap, setPoolCap] = useState(25);
  const [minLegs, setMinLegs] = useState(3);
  const [maxLegs, setMaxLegs] = useState(4);
  const [riskLevel, setRiskLevel] = useState(3);
  const [allowSGP, setAllowSGP] = useState(false);
  const [maxPerGame, setMaxPerGame] = useState(2);
  const [numResults, setNumResults] = useState(10);
  // Off by default: without this, the top-EV combos almost always share their strongest 1-2
  // legs (the same standout edge shows up in nearly every high-scoring combination), so the
  // "top 10" list was really just 1-2 real ideas wearing different extra legs. Off = greedily
  // skip any candidate that reuses a leg already used by a higher-ranked parlay in this batch,
  // so the results shown are actually independent picks. On = pure top-N by EV, duplicates allowed.
  const [allowDuplicateLegs, setAllowDuplicateLegs] = useState(false);
  const [generated, setGenerated] = useState([]);
  const [genMsg, setGenMsg] = useState("");

  function generate() {
    const capped = filteredPool.slice(0, Math.max(2, Number(poolCap) || 25));
    if (capped.length < Number(minLegs)) {
      setGenMsg(`Not enough legs in the filtered pool (have ${capped.length}, need at least ${minLegs}). Loosen the pool filters above, or raise "pool size (top edge)".`);
      setGenerated([]); return;
    }
    const combos = generateCombos(capped, Number(minLegs), Number(maxLegs), allowSGP, Number(maxPerGame) || 2);
    if (combos.length === 0) {
      setGenMsg(`No valid ${minLegs}${maxLegs !== minLegs ? `–${maxLegs}` : ""}-leg combination exists among these ${capped.length} pooled legs${allowSGP ? ` once "max legs / game" (${maxPerGame || 2}) is applied` : " without allowing same-game legs"}. Try: raising pool size, lowering legs:min, or turning on "allow same-game legs (SGP)".`);
      setGenerated([]); return;
    }
    const scored = combos.map((idxs) => {
      const legs = idxs.map((i) => capped[i]);
      const c = combineLegs(legs);
      return { legs, ...c };
    }).filter((c) => c.ev > 0); // the only hard bar: never surface a net negative-EV parlay
    if (scored.length === 0) {
      setGenMsg(`Explored ${combos.length.toLocaleString()} combination(s) from ${capped.length} pooled legs, but none were net positive-EV once combined — each leg's edge didn't survive being multiplied together (this happens when legs' edges are thin or partly offsetting). Try raising "min edge %"/"min EV %" on the pool filters so only stronger legs feed the generator, or reduce legs:max.`);
      setGenerated([]); return;
    }
    const mode = RISK_LEVELS[riskLevel - 1].sort;
    scored.sort((a, b) => {
      if (mode === "prob") return (b.modelP - a.modelP) || (b.ev - a.ev);
      if (mode === "payout") return (b.decimal - a.decimal) || (b.ev - a.ev);
      return (b.ev - a.ev) || (b.edge - a.edge);
    });
    const wantN = Number(numResults) || 10;
    let results;
    if (allowDuplicateLegs) {
      results = scored.slice(0, wantN);
    } else {
      results = [];
      const usedLegs = new Set();
      for (const c of scored) {
        if (results.length >= wantN) break;
        const keys = c.legs.map((l) => l.poolId);
        if (keys.some((k) => usedLegs.has(k))) continue;
        results.push(c);
        for (const k of keys) usedLegs.add(k);
      }
      if (results.length === 0) results = scored.slice(0, wantN); // every +EV combo overlapped — fall back rather than show nothing
    }
    setGenerated(results);
    setGenMsg(`Explored ${combos.length.toLocaleString()} combination(s) from ${capped.length} pooled legs, ${scored.length.toLocaleString()} net +EV — showing ${results.length}${allowDuplicateLegs ? "" : " leg-independent"} parlay(s), ${RISK_LEVELS[riskLevel - 1].hint} (risk: ${RISK_LEVELS[riskLevel - 1].label}).`);
  }

  /* ---- tracked parlays ---- */
  const [tracked, setTracked] = useState(() => loadTracked());
  function persistTracked(next) { setTracked(next); saveTracked(next); }
  function trackParlay(candidate) {
    const rec = {
      id: `plb_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      builtAt: new Date().toISOString(),
      units: 1,
      legs: candidate.legs.map((l) => ({ ...l })),
      builtDecimal: candidate.decimal, builtAmerican: candidate.american,
      builtModelP: candidate.modelP, builtFairP: candidate.fairP, builtEdge: candidate.edge, builtEV: candidate.ev,
      sgp: candidate.sgp,
      status: "open",
    };
    persistTracked([rec, ...tracked]);
  }
  function untrackParlay(id) { if (window.confirm("Remove this tracked parlay? This cannot be undone.")) persistTracked(tracked.filter((p) => p.id !== id)); }
  function clearTracked() { if (window.confirm("Clear ALL tracked parlays? Export a CSV first if you want a copy.")) persistTracked([]); }
  function setLegManual(parlayId, legIdx, result) {
    persistTracked(tracked.map((p) => {
      if (p.id !== parlayId) return p;
      const legs = p.legs.map((l, i) => (i === legIdx ? { ...l, result, settled: true } : l));
      return { ...p, legs, status: gradeParlayLegs(legs).status };
    }));
  }

  /* ---- re-check / settle via freshly re-pasted (already-settled) CSV ---- */
  const [recheckText, setRecheckText] = useState("");
  const [recheckSport, setRecheckSport] = useState("mlb");
  const [recheckMsg, setRecheckMsg] = useState("");
  function recheckResults() {
    if (!recheckText.trim()) { setRecheckMsg("Paste an updated Board Log CSV first (run \"Settle full board log\" in that sport's app, then Export CSV)."); return; }
    const rows = parseCsvRows(recheckText).map((r) => normalizeLeg(r, recheckSport));
    const byLogId = new Map(), byMatchKey = new Map();
    for (const r of rows) { if (r.logId) byLogId.set(`${recheckSport}:${r.logId}`, r); byMatchKey.set(r.matchKey, r); }
    let legsUpdated = 0, parlaysAffected = 0;
    const next = tracked.map((p) => {
      let changed = false;
      const legs = p.legs.map((l) => {
        if (l.result) return l; // already settled (or manually overridden) — don't clobber
        const src = (l.logId && byLogId.get(`${l.sport}:${l.logId}`)) || byMatchKey.get(l.matchKey);
        if (!src || !src.settled || !src.result) return l;
        changed = true; legsUpdated++;
        return { ...l, result: src.result, actualStat: src.actualStat, settled: true };
      });
      if (!changed) return p;
      parlaysAffected++;
      return { ...p, legs, status: gradeParlayLegs(legs).status };
    });
    persistTracked(next);
    setRecheckMsg(`Matched and updated ${legsUpdated} leg(s) across ${parlaysAffected} parlay(s). Legs with no match in this CSV (different sport/date, or that game hasn't been settled in its own app yet) were left as-is.`);
  }

  /* ---- stats ---- */
  const stats = useMemo(() => {
    const settled = tracked.filter((p) => p.status === "won" || p.status === "lost" || p.status === "push");
    let w = 0, l = 0, ps = 0, net = 0;
    for (const p of settled) {
      if (p.status === "won") w++; else if (p.status === "lost") l++; else ps++;
      net += parlayProfitUnits(p.status, p.legs, p.units || 1);
    }
    const n = w + l; // pushes excluded from win% denominator, standard convention
    return { total: tracked.length, open: tracked.filter((p) => p.status === "open").length, w, l, ps, net, winPct: n ? w / n : null, roi: settled.length ? net / settled.length : null };
  }, [tracked]);

  function exportTrackedCSV() {
    const esc = (v) => { if (v == null) return ""; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [["built_at", "legs", "leg_count", "sgp", "combined_odds", "combined_model_pct", "combined_fair_pct", "edge_pct", "ev_pct", "status", "profit_units", "leg_detail"].join(",")];
    for (const p of tracked) {
      const legDetail = p.legs.map((l) => `${l.sport}:${l.name || l.game} ${l.type} ${l.line} ${l.side} (${fmtOdds(l.odds)}) [${l.result || "open"}]`).join(" | ");
      lines.push([
        esc(p.builtAt), p.legs.length, p.legs.length, p.sgp ? "yes" : "no",
        fmtOdds(p.builtAmerican), (p.builtModelP * 100).toFixed(1), (p.builtFairP * 100).toFixed(1),
        (p.builtEdge * 100).toFixed(1), (p.builtEV * 100).toFixed(1),
        p.status, parlayProfitUnits(p.status, p.legs, p.units || 1).toFixed(2), esc(legDetail),
      ].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `parlay-builder-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ============================================================================ render */
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <div className="max-w-5xl mx-auto px-4 pb-28">
        <header className="pt-6 pb-3 sticky top-0 bg-slate-950 z-20 border-b border-slate-800">
          <div className="flex items-end justify-between flex-wrap gap-3">
            <div>
              <h1 className="text-2xl font-black tracking-tight">🧩 PARLAY <span className="text-emerald-400">BUILDER</span></h1>
              <p className="text-[11px] text-slate-500 mt-0.5" style={mono}>cross-sport · board-log pooling · combined EV/edge</p>
            </div>
          </div>
          <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
            <div className="flex gap-1 flex-wrap">
              {[["build", "Build"], ["tracked", `Tracked${tracked.length ? ` (${tracked.length})` : ""}`], ["stats", "Stats"]].map(([k, label]) => (
                <button key={k} onClick={() => setSubTab(k)} className={`px-3.5 py-1.5 rounded-lg text-sm font-semibold ${subTab === k ? "bg-slate-800 text-emerald-400" : "text-slate-400 hover:text-slate-200"}`}>{label}</button>
              ))}
            </div>
          </div>
        </header>

        <div className="text-[11px] text-slate-500 mt-3 mb-4 leading-relaxed">
          Combines legs from the Board Log CSV each sport's Stats tab exports (candidates already carry that engine's model %, de-vigged fair %, edge, and EV — this tool doesn't invent new numbers, it combines existing ones). Combined win probability assumes legs are independent; same-game legs (flagged <span className="text-amber-400 font-bold">SGP</span>) are correlated in reality, so treat their combined EV as optimistic.
        </div>

        {subTab === "build" && (
        <div className="space-y-5">
          {/* ---- CSV intake ---- */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-lg p-3">
            <div className="text-sm font-bold mb-2">1. Paste Board Log CSV(s)</div>
            <div className="space-y-3">
              {blocks.map((blk) => (
                <div key={blk.id} className="flex gap-2 items-start">
                  <select value={blk.sport} onChange={(e) => updateBlock(blk.id, { sport: e.target.value })} className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs">
                    {SPORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                  <textarea value={blk.text} onChange={(e) => updateBlock(blk.id, { text: e.target.value })} placeholder="Paste the exported board-log CSV text here (header row included)…" className="flex-1 h-20 bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-[11px]" style={mono} />
                  {blocks.length > 1 && <button onClick={() => removeBlock(blk.id)} className="text-xs text-slate-500 hover:text-rose-400 px-1.5 py-1.5">✕</button>}
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 mt-2">
              <button onClick={addBlock} className="text-xs border border-slate-700 rounded px-2.5 py-1.5 text-slate-300 hover:border-slate-500">+ Add another CSV</button>
              <button onClick={addAllToPool} className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-lg px-3 py-1.5">Parse → Add to pool</button>
              {pool.length > 0 && <button onClick={clearPool} className="text-xs text-slate-500 hover:text-rose-400 border border-slate-700 rounded px-2.5 py-1.5">clear pool ({pool.length})</button>}
              {poolMsg && <span className="text-[11px] text-slate-400">{poolMsg}</span>}
            </div>
          </div>

          {/* ---- pool + filters ---- */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-lg p-3">
            <div className="text-sm font-bold mb-2">2. Candidate pool ({filteredPool.length} of {pool.length})</div>
            <div className="flex flex-wrap gap-1.5 items-center mb-2">
              {SPORTS.map((s) => <Chip key={s.key} active={fSports.has(s.key)} onClick={() => toggleSet(setFSports, s.key)} tone="emerald">{s.label}</Chip>)}
              <span className="w-px h-4 bg-slate-700 mx-1" />
              {allTypes.map((t) => <Chip key={t} active={fTypes.has(t)} onClick={() => toggleSet(setFTypes, t)}>{t}</Chip>)}
            </div>
            {allSides.length > 0 && (
              <div className="flex flex-wrap gap-1.5 items-center mb-2">
                <span className="text-[11px] text-slate-500">side:</span>
                {allSides.map((s) => <Chip key={s} active={!fSideExclude.has(s)} onClick={() => toggleSet(setFSideExclude, s)} tone="emerald">{s}</Chip>)}
                <span className="text-[10px] text-slate-500">— click a side to turn it off pool-wide (e.g. exclude Home Run unders)</span>
              </div>
            )}
            <div className="flex flex-wrap items-end gap-3 mb-2">
              <label className="text-xs text-slate-400 flex flex-col gap-1">min edge %
                <input value={fMinEdge} onChange={(e) => setFMinEdge(e.target.value)} placeholder="any" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
              </label>
              <label className="text-xs text-slate-400 flex flex-col gap-1">min EV %
                <input value={fMinEV} onChange={(e) => setFMinEV(e.target.value)} placeholder="any" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
              </label>
              <label className="text-xs text-slate-400 flex flex-col gap-1">search
                <input value={fSearch} onChange={(e) => setFSearch(e.target.value)} placeholder="player or game" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-40 text-slate-100" />
              </label>
              <label className="text-xs text-slate-400 flex items-center gap-1.5 pb-1.5">
                <input type="checkbox" checked={fOnlyOpen} onChange={(e) => setFOnlyOpen(e.target.checked)} /> only unsettled legs
              </label>
              <label className="text-xs text-slate-400 flex items-center gap-1.5 pb-1.5" title="The board log carries both sides of every market (over/under, alt lines) as separate rows. This keeps only the single highest-EV side per game+player+market+line.">
                <input type="checkbox" checked={fBestSide} onChange={(e) => setFBestSide(e.target.checked)} /> best side only (collapse over/under)
              </label>
            </div>
            <div className="overflow-x-auto max-h-80 overflow-y-auto border border-slate-800 rounded">
              <table className="w-full text-xs" style={mono}>
                <thead className="sticky top-0 bg-slate-950">
                  <tr className="text-slate-500 text-left">
                    <th className="p-1.5"> </th>
                    <th className="p-1.5">sport</th><th className="p-1.5">date</th><th className="p-1.5">game</th>
                    <th className="p-1.5">player/side</th><th className="p-1.5">type</th><th className="p-1.5">line</th>
                    <th className="p-1.5">odds</th><th className="p-1.5">model%</th><th className="p-1.5">edge%</th><th className="p-1.5">ev%</th><th className="p-1.5">status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPool.slice(0, 400).map((l) => (
                    <tr key={l.poolId} className="border-t border-slate-900 hover:bg-slate-900/60">
                      <td className="p-1.5"><input type="checkbox" checked={selectedIds.has(l.poolId)} onChange={() => toggleSelect(l.poolId)} /></td>
                      <td className="p-1.5">{l.sport.toUpperCase()}</td>
                      <td className="p-1.5">{l.dateLabel}</td>
                      <td className="p-1.5 max-w-[9rem] truncate" title={l.game}>{l.game}</td>
                      <td className="p-1.5 max-w-[8rem] truncate" title={l.name}>{l.name} <span className="text-slate-500">{l.side}</span></td>
                      <td className="p-1.5">{l.type}</td>
                      <td className="p-1.5">{l.line}</td>
                      <td className="p-1.5">{fmtOdds(l.odds)}</td>
                      <td className="p-1.5">{fmtPct(l.modelP)}</td>
                      <td className={`p-1.5 ${l.edge != null && l.edge > 0 ? "text-emerald-400" : ""}`}>{fmtPct(l.edge)}</td>
                      <td className={`p-1.5 ${l.ev != null && l.ev > 0 ? "text-emerald-400" : ""}`}>{fmtPct(l.ev)}</td>
                      <td className="p-1.5"><ResultBadge result={l.result} settled={l.settled} /></td>
                    </tr>
                  ))}
                  {filteredPool.length === 0 && <tr><td colSpan={11} className="p-4 text-center text-slate-500">No legs match the current filters. Paste a board-log CSV above and click "Parse → Add to pool".</td></tr>}
                </tbody>
              </table>
              {filteredPool.length > 400 && <div className="text-[10px] text-slate-500 p-1.5">showing first 400 of {filteredPool.length} — narrow filters to see more precisely</div>}
            </div>

            {selectedLegs.length >= 2 && selectedCombined && (
              <div className="mt-3 p-2.5 rounded-lg bg-slate-950 border border-emerald-800 flex flex-wrap items-center gap-3 text-sm">
                <span className="font-bold">{selectedLegs.length}-leg custom parlay</span>
                <span style={mono}>{fmtOdds(selectedCombined.american)}</span>
                <span className="text-slate-400">model {fmtPct(selectedCombined.modelP)}</span>
                <span className={selectedCombined.edge > 0 ? "text-emerald-400" : "text-rose-400"}>edge {fmtPct(selectedCombined.edge)}</span>
                <span className={selectedCombined.ev > 0 ? "text-emerald-400" : "text-rose-400"}>EV {fmtPct(selectedCombined.ev)}</span>
                {selectedCombined.sgp && <span className="text-amber-400 font-bold text-xs">SGP</span>}
                <button onClick={() => { trackParlay({ legs: selectedLegs, ...selectedCombined }); setSelectedIds(new Set()); }} className="ml-auto bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-lg px-3 py-1.5">Track this parlay (1u)</button>
                <button onClick={() => setSelectedIds(new Set())} className="text-xs text-slate-400 hover:text-rose-300">clear selection</button>
              </div>
            )}
          </div>

          {/* ---- auto-generator ---- */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-lg p-3">
            <div className="text-sm font-bold mb-2">3. Auto-build &amp; rank by strength</div>
            <div className="flex flex-wrap items-end gap-3 mb-3">
              <label className="text-xs text-slate-400 flex flex-col gap-1" title="How many of the filtered pool's legs (sorted best-edge-first) get fed into the combination search. The search space explodes with pool size, so this caps it to just the top-edge legs — raise it to consider weaker legs too, at the cost of a slower/coarser search; lower it to search faster among only your very best legs.">pool size (top edge) ⓘ
                <input type="number" min={2} max={60} value={poolCap} onChange={(e) => setPoolCap(e.target.value)} onWheel={(e) => e.currentTarget.blur()} className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20" />
              </label>
              <label className="text-xs text-slate-400 flex flex-col gap-1">legs: min
                <input type="number" min={2} max={10} value={minLegs} onChange={(e) => setMinLegs(e.target.value)} onWheel={(e) => e.currentTarget.blur()} className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-16" />
              </label>
              <label className="text-xs text-slate-400 flex flex-col gap-1">legs: max
                <input type="number" min={2} max={10} value={maxLegs} onChange={(e) => setMaxLegs(e.target.value)} onWheel={(e) => e.currentTarget.blur()} className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-16" />
              </label>
              <label className="text-xs text-slate-400 flex flex-col gap-1 w-48" title="Every result is already required to be net positive-EV — risk scale never throws results away, it only changes which +EV combos rank highest: Safe surfaces the highest win-probability combos, Longshot surfaces the highest-payout combos, Balanced ranks by raw EV.">risk scale: <span className="text-slate-200 font-bold">{RISK_LEVELS[riskLevel - 1].label}</span> <span className="text-slate-600 normal-case font-normal">({RISK_LEVELS[riskLevel - 1].hint})</span>
                <input type="range" min={1} max={5} value={riskLevel} onChange={(e) => setRiskLevel(Number(e.target.value))} />
              </label>
              <label className="text-xs text-slate-400 flex items-center gap-1.5 pb-1.5">
                <input type="checkbox" checked={allowSGP} onChange={(e) => setAllowSGP(e.target.checked)} /> allow same-game legs (SGP)
              </label>
              {allowSGP && (
                <label className="text-xs text-slate-400 flex flex-col gap-1">max legs / game
                  <input type="number" min={2} max={6} value={maxPerGame} onChange={(e) => setMaxPerGame(e.target.value)} onWheel={(e) => e.currentTarget.blur()} className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-16" />
                </label>
              )}
              <label className="text-xs text-slate-400 flex flex-col gap-1"># results
                <input type="number" min={1} max={30} value={numResults} onChange={(e) => setNumResults(e.target.value)} onWheel={(e) => e.currentTarget.blur()} className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-16" />
              </label>
              <label className="text-xs text-slate-400 flex items-center gap-1.5 pb-1.5" title="Off (default): skip any candidate that reuses a leg already used by a higher-ranked parlay in this batch, so the results are independent picks, not the same 1-2 strong legs repackaged. On: pure top-N by EV, duplicates allowed.">
                <input type="checkbox" checked={allowDuplicateLegs} onChange={(e) => setAllowDuplicateLegs(e.target.checked)} /> allow duplicate legs across parlays
              </label>
              <button onClick={generate} className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm rounded-lg px-3 py-1.5">Generate parlays</button>
            </div>
            {genMsg && <div className="text-[11px] text-slate-500 mb-2">{genMsg}</div>}

            <div className="space-y-2">
              {generated.map((c, i) => (
                <div key={i} className="p-2.5 rounded-lg bg-slate-950 border border-slate-800">
                  <div className="flex flex-wrap items-center gap-3 text-sm mb-1.5">
                    <span className="font-bold text-slate-400">#{i + 1}</span>
                    <span className="font-bold">{c.legs.length} legs</span>
                    <span style={mono}>{fmtOdds(c.american)}</span>
                    <span className="text-slate-400">model {fmtPct(c.modelP)}</span>
                    <span className={c.edge > 0 ? "text-emerald-400" : "text-rose-400"}>edge {fmtPct(c.edge)}</span>
                    <span className={`font-bold ${c.ev > 0 ? "text-emerald-400" : "text-rose-400"}`}>EV {fmtPct(c.ev)}</span>
                    {c.sgp && <span className="text-amber-400 font-bold text-xs">SGP</span>}
                    <button onClick={() => trackParlay(c)} className="ml-auto bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-lg px-3 py-1.5">Track (1u)</button>
                  </div>
                  <div className="rounded-lg border border-slate-800 overflow-hidden">
                    {c.legs.map((l, j) => <LegRow key={j} leg={l} index={j} />)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {subTab === "tracked" && (
        <div className="space-y-4">
          <div className="bg-slate-900/40 border border-slate-800 rounded-lg p-3">
            <div className="text-sm font-bold mb-2">Re-check results</div>
            <div className="text-[11px] text-slate-500 mb-2">Re-run "Settle full board log" in the relevant sport's app, re-export its Board Log CSV, and paste it here — legs are matched by log ID (or game/player/type/line/side as a fallback) and graded from that app's own settlement, not re-computed here.</div>
            <div className="flex gap-2 items-start mb-2">
              <select value={recheckSport} onChange={(e) => setRecheckSport(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs">
                {SPORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
              <textarea value={recheckText} onChange={(e) => setRecheckText(e.target.value)} placeholder="Paste updated (settled) board-log CSV…" className="flex-1 h-20 bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-[11px]" style={mono} />
            </div>
            <button onClick={recheckResults} className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-lg px-3 py-1.5">Match &amp; settle</button>
            {recheckMsg && <div className="text-[11px] text-slate-400 mt-2">{recheckMsg}</div>}
          </div>

          <div className="flex items-center justify-between">
            <div className="text-sm font-bold">Tracked parlays ({tracked.length})</div>
            <div className="flex gap-2">
              <button onClick={exportTrackedCSV} disabled={!tracked.length} className="bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white font-bold text-xs rounded-lg px-3 py-1.5">Download CSV</button>
              <button onClick={clearTracked} disabled={!tracked.length} className="text-xs text-slate-500 hover:text-rose-400 border border-slate-700 rounded px-2.5 py-1.5 disabled:opacity-40">clear all</button>
            </div>
          </div>

          <div className="space-y-2">
            {tracked.map((p) => {
              const profit = parlayProfitUnits(p.status, p.legs, p.units || 1);
              return (
                <div key={p.id} className="p-2.5 rounded-lg bg-slate-950 border border-slate-800">
                  <div className="flex flex-wrap items-center gap-3 text-sm mb-1.5">
                    <ResultBadge result={p.status === "open" ? null : p.status} />
                    <span className="font-bold">{p.legs.length} legs</span>
                    <span style={mono}>{fmtOdds(p.builtAmerican)}</span>
                    <span className="text-slate-400">model {fmtPct(p.builtModelP)}</span>
                    <span className={p.builtEdge > 0 ? "text-emerald-400" : "text-rose-400"}>edge {fmtPct(p.builtEdge)}</span>
                    <span className={p.builtEV > 0 ? "text-emerald-400" : "text-rose-400"}>EV {fmtPct(p.builtEV)}</span>
                    {p.sgp && <span className="text-amber-400 font-bold text-xs">SGP</span>}
                    {p.status !== "open" && <span className={`font-bold ${profit > 0 ? "text-emerald-400" : profit < 0 ? "text-rose-400" : "text-slate-400"}`}>{profit >= 0 ? "+" : ""}{profit.toFixed(2)}u</span>}
                    <span className="text-[10px] text-slate-500 ml-auto">{new Date(p.builtAt).toLocaleString()}</span>
                    <button onClick={() => untrackParlay(p.id)} className="text-xs text-slate-500 hover:text-rose-400">✕</button>
                  </div>
                  <div className="rounded-lg border border-slate-800 overflow-hidden">
                    {p.legs.map((l, j) => (
                      <LegRow key={j} leg={l} index={j} right={
                        <div className="flex items-center gap-1.5 shrink-0">
                          <ResultBadge result={l.result} />
                          {!l.result && (
                            <div className="flex gap-1">
                              {["won", "lost", "push", "void"].map((r) => (
                                <button key={r} onClick={() => setLegManual(p.id, j, r)} className="text-[9px] px-1.5 py-0.5 rounded border border-slate-700 hover:border-slate-400 text-slate-300">{r}</button>
                              ))}
                            </div>
                          )}
                        </div>
                      } />
                    ))}
                  </div>
                </div>
              );
            })}
            {tracked.length === 0 && <div className="text-sm text-slate-500 text-center py-8">No tracked parlays yet — build one in the Build tab.</div>}
          </div>
        </div>
      )}

      {subTab === "stats" && (
        <div className="bg-slate-900/40 border border-slate-800 rounded-lg p-4 max-w-md">
          <div className="text-sm font-bold mb-3">Parlay Builder stats</div>
          <div className="grid grid-cols-2 gap-y-2 text-sm" style={mono}>
            <div className="text-slate-400">tracked</div><div className="text-right">{stats.total}</div>
            <div className="text-slate-400">open</div><div className="text-right">{stats.open}</div>
            <div className="text-slate-400">record (W-L-P)</div><div className="text-right">{stats.w}-{stats.l}-{stats.ps}</div>
            <div className="text-slate-400">win %</div><div className="text-right">{stats.winPct != null ? (stats.winPct * 100).toFixed(1) + "%" : "—"}</div>
            <div className="text-slate-400">net units (1u/parlay)</div><div className={`text-right font-bold ${stats.net > 0 ? "text-emerald-400" : stats.net < 0 ? "text-rose-400" : ""}`}>{stats.net >= 0 ? "+" : ""}{stats.net.toFixed(2)}u</div>
            <div className="text-slate-400">ROI / parlay</div><div className="text-right">{stats.roi != null ? (stats.roi * 100).toFixed(1) + "%" : "—"}</div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
