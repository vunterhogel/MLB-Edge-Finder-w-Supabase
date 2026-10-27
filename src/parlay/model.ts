/* Parlay math, the leg pool, and the auto-build search. No UI.

   Legs come straight from each sport's saved data (no CSVs):
     - board log: every unsettled board-log row (all four sports), the same rows the old CSV export held
     - My Bets:   every open tracked bet
   Combined probability assumes the legs are independent (P = product of each leg's p). That's standard
   parlay math, but it overstates the edge for same-game legs, which are correlated in reality; those
   parlays are flagged SGP so their EV reads as optimistic. */
import { deriveBet } from "../core/bets";

/* ---------------- odds helpers ---------------- */
export const impliedProb = (o) => (o < 0 ? -o / (-o + 100) : 100 / (o + 100));
export const americanToDecimal = (o) => (o > 0 ? 1 + o / 100 : 1 + 100 / -o);
export function decimalToAmerican(d) {
  const b = d - 1;
  if (b <= 0) return 0;
  return b >= 1 ? Math.round(b * 100) : Math.round(-100 / b);
}
export const fmtOdds = (o) => (o == null || isNaN(o) ? "—" : o > 0 ? `+${o}` : `${o}`);
export const fmtPct = (x, d = 1) => (x == null || isNaN(x) ? "—" : `${(x * 100).toFixed(d)}%`);
const num = (v) => (v == null || v === "" || isNaN(Number(v)) ? null : Number(v));

/* ---------------- legs ---------------- */
// one shape for every leg, whichever source it came from. matchKey = "the same bet" across sources.
function makeLeg(sport, x) {
  const matchKey = `${sport}|${x.gamePk}|${x.playerId || ""}|${x.type}|${x.line}|${x.side}`;
  return {
    poolId: matchKey, matchKey, sport,
    logId: x.logId || "", betKey: x.betKey || null, loggedAt: x.loggedAt || "", source: x.source,
    date: x.date || "", dateLabel: x.date || "",
    game: x.game || "", gamePk: String(x.gamePk ?? ""), gameKey: `${sport}:${x.gamePk}`, gameTimeIso: x.gameTimeIso || null,
    marketKey: `${sport}|${x.gamePk}|${x.playerId || ""}|${x.type}|${x.line}`, market: `${sport}|${x.type}`,
    playerId: String(x.playerId ?? ""), name: x.name || "", type: x.type || "", line: String(x.line ?? ""), side: x.side || "",
    odds: num(x.odds), novig: num(x.novig), modelP: num(x.modelP), edge: num(x.edge), ev: num(x.ev), proj: num(x.proj),
    book: x.book || null, live: !!x.live, isLine: !!x.isLine,
    settled: !!x.settled, result: x.result || null, actualStat: x.actualStat ?? null,
  };
}

// every unsettled board-log row of one sport -> legs
export function boardLogLegs(sport, rows) {
  const isLine = sport.config.isLineType;
  return (rows || []).filter((r) => !r.settled).map((r) => makeLeg(sport.id, {
    ...r, source: "board", modelP: r.calibratedP ?? r.rawModelP,
    edge: r.edge ?? (r.calibratedP != null && r.novig != null ? r.calibratedP - r.novig : null), isLine: isLine(r.type),
  }));
}
// every open tracked bet of one sport -> legs (odds as you entered them; edge / EV recomputed from them)
export function myBetLegs(sport, bets) {
  const isLine = sport.config.isLineType;
  return (bets || []).map(deriveBet).filter((b) => b.status === "open").map((b) => makeLeg(sport.id, {
    ...b, source: "mybets", betKey: b.key, logId: `${b.date}|${b.key}`, isLine: isLine(b.type),
  }));
}
// the board log logs a bet once per day per (game, player, market, line, side); the same bet can still
// appear on several slate dates. Keep one leg per bet: the most recently logged.
export function dedupeLegs(legs) {
  const m = new Map();
  for (const l of legs) { const cur = m.get(l.poolId); if (!cur || String(l.loggedAt || l.date) >= String(cur.loggedAt || cur.date)) m.set(l.poolId, l); }
  const out = [...m.values()];
  // a leg without a kickoff time borrows it from another leg of the same game
  const kick = new Map();
  for (const l of out) if (l.gameTimeIso && !kick.has(l.gameKey)) kick.set(l.gameKey, l.gameTimeIso);
  return out.map((l) => (l.gameTimeIso || !kick.has(l.gameKey) ? l : { ...l, gameTimeIso: kick.get(l.gameKey) }));
}
export const started = (l) => { const t = l.gameTimeIso ? Date.parse(l.gameTimeIso) : NaN; return isNaN(t) ? null : t <= Date.now(); };

/* ---------------- leg filters ---------------- */
export const EMPTY_POOL_FILTERS = {
  sports: [], markets: [], cls: "all", sides: [], date: "all", kickoff: "upcoming", search: "",
  minOdds: "", maxOdds: "", minModel: "", minEdge: "", minEV: "", bestSide: true, live: "include", sort: "edge",
};
const amToB = (o) => (o > 0 ? o / 100 : 100 / -o); // odds -> payout per unit, monotonic in "longness"
export function filterPool(legs, f, excluded) {
  const q = f.search.trim().toLowerCase();
  const minOB = num(f.minOdds) == null ? null : amToB(num(f.minOdds));
  const maxOB = num(f.maxOdds) == null ? null : amToB(num(f.maxOdds));
  let rows = legs.filter((l) => {
    if (excluded && excluded.has(l.poolId)) return false;
    if (f.sports.length && !f.sports.includes(l.sport)) return false;
    if (f.markets.length && !f.markets.includes(l.market)) return false;
    if (f.cls === "props" && l.isLine) return false;
    if (f.cls === "lines" && !l.isLine) return false;
    if (f.sides.length && !f.sides.includes(l.side)) return false;
    if (f.date !== "all" && l.date !== f.date) return false;
    if (f.live === "exclude" && l.live) return false;
    if (f.live === "only" && !l.live) return false;
    if (f.kickoff !== "any") { const s = started(l); if (s != null && (f.kickoff === "upcoming" ? s : !s)) return false; } // unknown kickoff stays in
    if (q && !(`${l.name} ${l.game} ${l.type}`.toLowerCase().includes(q))) return false;
    if (minOB != null || maxOB != null) { if (l.odds == null) return false; const b = amToB(l.odds); if (minOB != null && b < minOB) return false; if (maxOB != null && b > maxOB) return false; }
    if (num(f.minModel) != null && !(l.modelP != null && l.modelP * 100 >= num(f.minModel))) return false;
    if (num(f.minEdge) != null && !(l.edge != null && l.edge * 100 >= num(f.minEdge))) return false;
    if (num(f.minEV) != null && !(l.ev != null && l.ev * 100 >= num(f.minEV))) return false;
    return true;
  });
  // both sides of a market are separate rows; keep only the side the model likes most (by EV)
  if (f.bestSide) {
    const best = new Map();
    const score = (l) => (l.ev != null ? l.ev : l.edge != null ? l.edge : -Infinity);
    for (const l of rows) { const cur = best.get(l.marketKey); if (!cur || score(l) > score(cur)) best.set(l.marketKey, l); }
    rows = [...best.values()];
  }
  return rows.sort(LEG_SORTS[f.sort] || LEG_SORTS.edge);
}
export const LEG_SORTS = {
  edge: (a, b) => (b.edge ?? -99) - (a.edge ?? -99),
  ev: (a, b) => (b.ev ?? -99) - (a.ev ?? -99),
  model: (a, b) => (b.modelP ?? -99) - (a.modelP ?? -99),
  odds_long: (a, b) => (b.odds != null ? americanToDecimal(b.odds) : 0) - (a.odds != null ? americanToDecimal(a.odds) : 0),
  odds_short: (a, b) => (a.odds != null ? americanToDecimal(a.odds) : 99) - (b.odds != null ? americanToDecimal(b.odds) : 99),
  kickoff: (a, b) => String(a.gameTimeIso || "9").localeCompare(String(b.gameTimeIso || "9")),
};

/* ---------------- combining ---------------- */
export function combineLegs(legs) {
  let dec = 1, modelP = 1, fairP = 1, decSum = 0;
  for (const l of legs) {
    const d = l.odds != null ? americanToDecimal(l.odds) : 1;
    dec *= d; decSum += d;
    modelP *= l.modelP != null ? l.modelP : (l.novig != null ? l.novig : (l.odds != null ? impliedProb(l.odds) : 0.5));
    fairP *= l.novig != null ? l.novig : (l.odds != null ? impliedProb(l.odds) : 0.5);
  }
  const american = decimalToAmerican(dec);
  const ev = modelP * (dec - 1) - (1 - modelP);
  const edge = modelP - fairP;
  const sgp = new Set(legs.map((l) => l.gameKey)).size < legs.length;
  const avgDecimal = legs.length ? decSum / legs.length : 1;
  return { decimal: dec, american, modelP, fairP, ev, edge, sgp, avgDecimal, avgAmerican: decimalToAmerican(avgDecimal), sports: [...new Set(legs.map((l) => l.sport))] };
}

/* ---------------- auto-build search ---------------- */
function nCk(n, k) { if (k < 0 || k > n) return 0; k = Math.min(k, n - k); let r = 1; for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1); return r; }

export const RANK_BY = { ev: "EV", prob: "Win probability", payout: "Payout", edge: "Edge" };
export const DEFAULT_BUILD = {
  minLegs: "3", maxLegs: "4", minTotalOdds: "", maxTotalOdds: "", minAvgOdds: "", maxAvgOdds: "",
  minModel: "", minEV: "0", minEdge: "", sgp: false, maxPerGame: "2", maxPerSport: "", maxPerMarket: "", minSports: "1",
  poolCap: "25", rankBy: "ev", results: "10", allowDup: false,
};

/* pool: filtered legs (best first). pinned: legs every parlay must include. opts: DEFAULT_BUILD shape.
   -> { results, report } where report counts what each constraint removed, so an empty result says why. */
export function buildParlays(pool, pinned, opts, budgetMs = 1800) {
  const o = {
    minLegs: Math.max(2, num(opts.minLegs) || 2), maxLegs: Math.max(2, num(opts.maxLegs) || 2),
    perGame: opts.sgp ? Math.max(1, num(opts.maxPerGame) || 2) : 1,
    perSport: num(opts.maxPerSport), perMarket: num(opts.maxPerMarket), minSports: Math.max(1, num(opts.minSports) || 1),
    cap: Math.max(2, num(opts.poolCap) || 25), want: Math.max(1, num(opts.results) || 10),
  };
  if (o.maxLegs < o.minLegs) o.maxLegs = o.minLegs;
  const report = { pool: 0, explored: 0, exact: true, failed: {}, passed: 0 };
  if (pinned.length > o.maxLegs) return { results: [], report: { ...report, error: `You pinned ${pinned.length} legs but the max is ${o.maxLegs} legs.` } };
  const pinnedIds = new Set(pinned.map((l) => l.poolId));
  const free = pool.filter((l) => !pinnedIds.has(l.poolId)).slice(0, o.cap);
  report.pool = free.length;
  const kMin = Math.max(0, o.minLegs - pinned.length), kMax = o.maxLegs - pinned.length;
  if (free.length < kMin) return { results: [], report: { ...report, error: `Not enough legs: ${free.length} in the pool${pinned.length ? ` besides your ${pinned.length} pinned` : ""}, need ${kMin}. Loosen the leg filters or raise the pool size.` } };

  // per-game / per-sport / per-market counts, starting from the pinned legs
  const base = { game: new Map(), sport: new Map(), market: new Map() };
  const bump = (c, l, d) => { c.game.set(l.gameKey, (c.game.get(l.gameKey) || 0) + d); c.sport.set(l.sport, (c.sport.get(l.sport) || 0) + d); c.market.set(l.market, (c.market.get(l.market) || 0) + d); };
  for (const l of pinned) bump(base, l, 1);
  const fits = (c, l) => (c.game.get(l.gameKey) || 0) < o.perGame && (o.perSport == null || (c.sport.get(l.sport) || 0) < o.perSport) && (o.perMarket == null || (c.market.get(l.market) || 0) < o.perMarket);
  const pinnedOk = [...base.game.values()].every((n) => n <= o.perGame) && (o.perSport == null || [...base.sport.values()].every((n) => n <= o.perSport)) && (o.perMarket == null || [...base.market.values()].every((n) => n <= o.perMarket));
  if (!pinnedOk) return { results: [], report: { ...report, error: "Your pinned legs already break the per-game / per-sport / per-market limits." } };
  const clone = () => ({ game: new Map(base.game), sport: new Map(base.sport), market: new Map(base.market) });

  let total = 0; for (let k = kMin; k <= kMax; k++) total += nCk(free.length, k);
  const combos = [];
  const start = Date.now();
  if (total <= 250000) {
    // exact: every combination
    const c = clone(); let n = 0;
    const walk = (from, chosen) => {
      if (++n % 4096 === 0 && Date.now() - start > budgetMs) return;
      if (chosen.length >= kMin) combos.push(chosen.slice());
      if (chosen.length === kMax) return;
      for (let i = from; i < free.length; i++) {
        if (!fits(c, free[i])) continue;
        bump(c, free[i], 1); chosen.push(i); walk(i + 1, chosen); chosen.pop(); bump(c, free[i], -1);
      }
    };
    walk(0, []);
  } else {
    // sample: random draws spread over the whole pool (an exact search would never get past the top legs)
    report.exact = false;
    const seen = new Set(); let attempts = 0;
    while (combos.length < 60000 && attempts < 3000000) {
      attempts++;
      if (attempts % 512 === 0 && Date.now() - start > budgetMs) break;
      const k = kMin + Math.floor(Math.random() * (kMax - kMin + 1));
      const order = Array.from({ length: free.length }, (_, i) => i);
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      const c = clone(); const idx = [];
      for (const i of order) { if (idx.length >= k) break; if (!fits(c, free[i])) continue; idx.push(i); bump(c, free[i], 1); }
      if (idx.length < k) continue;
      idx.sort((a, b) => a - b);
      const key = idx.join(",");
      if (seen.has(key)) continue;
      seen.add(key); combos.push(idx);
    }
  }
  report.explored = combos.length;

  const dec = (a) => (num(a) == null ? null : americanToDecimal(num(a)));
  const [tLo, tHi, aLo, aHi] = [dec(opts.minTotalOdds), dec(opts.maxTotalOdds), dec(opts.minAvgOdds), dec(opts.maxAvgOdds)];
  const checks = [
    ["total odds", (c) => (tLo == null || c.decimal >= tLo) && (tHi == null || c.decimal <= tHi)],
    ["average leg odds", (c) => (aLo == null || c.avgDecimal >= aLo) && (aHi == null || c.avgDecimal <= aHi)],
    ["sports mixed", (c) => c.sports.length >= o.minSports],
    ["min win %", (c) => num(opts.minModel) == null || c.modelP * 100 >= num(opts.minModel)],
    ["min edge", (c) => num(opts.minEdge) == null || c.edge * 100 >= num(opts.minEdge)],
    // min EV 0 (the default) = strictly +EV, the old builder's floor; any other value = at least that %
    ["min EV", (c) => { const m = num(opts.minEV); return m == null || (m === 0 ? c.ev > 0 : c.ev * 100 >= m); }],
  ];
  const scored = [];
  for (const idxs of combos) {
    const legs = [...pinned, ...idxs.map((i) => free[i])];
    if (legs.length < o.minLegs) continue;
    const c = { legs, ...combineLegs(legs) };
    const bad = checks.find(([, ok]) => !ok(c));
    if (bad) { report.failed[bad[0]] = (report.failed[bad[0]] || 0) + 1; continue; }
    scored.push(c);
  }
  report.passed = scored.length;
  const by = opts.rankBy;
  scored.sort((a, b) => (by === "prob" ? (b.modelP - a.modelP) || (b.ev - a.ev) : by === "payout" ? (b.decimal - a.decimal) || (b.ev - a.ev) : by === "edge" ? (b.edge - a.edge) || (b.ev - a.ev) : (b.ev - a.ev) || (b.edge - a.edge)));
  let results;
  if (opts.allowDup) results = scored.slice(0, o.want);
  else {
    // no two results share a leg (pinned legs aside, they're in every one): independent picks, not
    // the same strong leg repackaged. Fewer than asked is shown rather than padding with overlaps.
    results = []; const used = new Set();
    for (const c of scored) {
      if (results.length >= o.want) break;
      const keys = c.legs.filter((l) => !pinnedIds.has(l.poolId)).map((l) => l.poolId);
      if (keys.some((k) => used.has(k))) continue;
      results.push(c); for (const k of keys) used.add(k);
    }
  }
  return { results, report };
}
