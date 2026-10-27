/* Tracked-bet logic shared by the sport pages and the hub: settlement, line refresh (CLV), the My Bets
   filters and sorts, stats, CSV export and backup / restore. Moved out of the SportApp shell
   unchanged so every page runs the same code. Each function takes the sport adapter (or its parts)
   it needs instead of reading the shell's state. */
import { evPerUnit, impliedProb, profitUnits, suggestedUnits } from "./math";

const amToB = (o) => (o > 0 ? o / 100 : 100 / -o);

/* ---------------- My Bets list: derived fields, filters, sorts ---------------- */
// edge / EV / CLV recomputed live from the bet's (editable) odds
export function deriveBet(b, i) {
  const odds = Number(b.odds);
  const modelP = b.modelP, imp = isNaN(odds) ? null : impliedProb(odds);
  const fairRef = b.novig != null ? b.novig : imp;
  const edge = (modelP != null && fairRef != null) ? modelP - fairRef : null;
  const ev = (modelP != null && !isNaN(odds)) ? evPerUnit(modelP, odds) : null;
  const units = b.units != null ? b.units : 1;        // back-compat for older bets
  const suggested = b.suggested != null ? b.suggested : suggestedUnits(modelP, odds);
  // CLV: positive = market moved toward your side since you bet (your side's price shortened) = you beat the line
  const clv = (b.currentOdds != null && !isNaN(odds)) ? impliedProb(b.currentOdds) - impliedProb(odds) : null;
  return { ...b, imp, edge, ev, units, suggested, clv, _i: i };
}

export const EMPTY_BET_FILTERS = {
  status: "all", sort: "recent", date: "all", games: [], types: [], books: [], side: "all",
  minModel: "", minEdge: "", maxEdge: "", minOdds: "", maxOdds: "", minDelta: "", maxDelta: "", dirAligned: false, search: "",
};
export function betFiltersActive(f) {
  return f.status !== "all" || f.games.length > 0 || f.types.length > 0 || f.books.length > 0 || f.side !== "all" || f.date !== "all" || f.minModel !== "" || f.minEdge !== "" || f.maxEdge !== "" || f.minOdds !== "" || f.maxOdds !== "" || f.minDelta !== "" || f.maxDelta !== "" || f.dirAligned || f.search !== "";
}

// matchesQuery: the sport's search matcher (config.matchesQuery)
export function filterSortBets(bets, f, matchesQuery) {
  let arr = bets.map(deriveBet);
  if (f.status === "settled") arr = arr.filter((b) => b.status !== "open");
  else if (f.status !== "all") arr = arr.filter((b) => b.status === f.status);
  if (f.date !== "all") arr = arr.filter((b) => b.date === f.date);
  if (f.games.length) arr = arr.filter((b) => f.games.includes(b.game));
  if (f.types.length) arr = arr.filter((b) => f.types.includes(b.type));
  if (f.books.length) arr = arr.filter((b) => f.books.includes(b.book));
  if (f.side !== "all") arr = arr.filter((b) => b.side === f.side);
  if (f.search.trim()) arr = arr.filter((b) => matchesQuery(b, f.search));
  const bmM = parseFloat(f.minModel);
  if (!isNaN(bmM)) arr = arr.filter((b) => b.modelP != null && b.modelP * 100 >= bmM);
  const bmE = parseFloat(f.minEdge);
  if (!isNaN(bmE)) arr = arr.filter((b) => b.edge != null && b.edge * 100 >= bmE);
  const bxE = parseFloat(f.maxEdge);
  if (!isNaN(bxE)) arr = arr.filter((b) => b.edge != null && b.edge * 100 <= bxE);
  const minOB = f.minOdds === "" || isNaN(Number(f.minOdds)) ? null : amToB(Number(f.minOdds));
  const maxOB = f.maxOdds === "" || isNaN(Number(f.maxOdds)) ? null : amToB(Number(f.maxOdds));
  if (minOB != null || maxOB != null) arr = arr.filter((b) => { const bb = amToB(Number(b.odds)); if (isNaN(bb)) return false; if (minOB != null && bb < minOB) return false; if (maxOB != null && bb > maxOB) return false; return true; });
  const getBetDelta = (b) => (b.proj ?? 0) - parseFloat(b.line ?? 0);
  const bmD = parseFloat(f.minDelta);
  const bxD = parseFloat(f.maxDelta);
  if (!isNaN(bmD)) arr = arr.filter((b) => getBetDelta(b) >= bmD);
  if (!isNaN(bxD)) arr = arr.filter((b) => getBetDelta(b) <= bxD);
  if (f.dirAligned) arr = arr.filter((b) => { const d = getBetDelta(b); return b.side === "over" ? d > 0 : d < 0; });
  const cmp = {
    recent: (a, b) => a._i - b._i,
    game: (a, b) => String(a.game || "").localeCompare(String(b.game || "")) || a._i - b._i,
    model_desc: (a, b) => (b.modelP ?? -9) - (a.modelP ?? -9), model_asc: (a, b) => (a.modelP ?? 9) - (b.modelP ?? 9),
    ev_desc: (a, b) => (b.ev ?? -9) - (a.ev ?? -9), ev_asc: (a, b) => (a.ev ?? 9) - (b.ev ?? 9),
    edge_desc: (a, b) => (b.edge ?? -9) - (a.edge ?? -9), edge_asc: (a, b) => (a.edge ?? 9) - (b.edge ?? 9),
    clv_desc: (a, b) => (b.clv ?? -9) - (a.clv ?? -9), clv_asc: (a, b) => (a.clv ?? 9) - (b.clv ?? 9),
    delta_desc: (a, b) => getBetDelta(b) - getBetDelta(a), delta_asc: (a, b) => getBetDelta(a) - getBetDelta(b),
  }[f.sort] || ((a, b) => a._i - b._i);
  return arr.sort(cmp);
}

// option lists for the My Bets filter controls
export function betFacets(bets, dateFilter) {
  const uniq = (arr, fn) => [...new Set(arr.map(fn).filter(Boolean))].sort();
  // game list scoped to the selected date so TEX@LAA from 8/9 doesn't appear when filtering to 8/11
  const gameBase = dateFilter !== "all" ? bets.filter((b) => b.date === dateFilter) : bets;
  return {
    dates: uniq(bets, (b) => b.date).reverse(),
    games: uniq(gameBase, (b) => b.game),
    types: uniq(bets, (b) => b.type),
    books: uniq(bets, (b) => b.book),
    sides: uniq(bets, (b) => b.side),
  };
}

/* ---------------- stats ---------------- */
// typeOrder: the sport's STAT_ORDER (per-market breakdown order)
export function betStats(bets, { start = "", end = "" } = {}, typeOrder = []) {
  let settled = bets.filter((b) => b.status === "won" || b.status === "lost" || b.status === "push" || b.status === "void");
  if (start) settled = settled.filter((b) => b.date && b.date >= start);
  if (end) settled = settled.filter((b) => b.date && b.date <= end);
  const unitsOf = (b) => (b.units != null && !isNaN(b.units) ? Number(b.units) : 1);
  const agg = (arr) => {
    const w = arr.filter((b) => b.status === "won").length, l = arr.filter((b) => b.status === "lost").length, ps = arr.filter((b) => b.status === "push").length, v = arr.filter((b) => b.status === "void").length;
    // stake-weighted (uses each bet's units). push + void are no-action: 0 profit, not staked.
    const net = arr.reduce((s, b) => s + profitUnits(b.status, Number(b.odds), unitsOf(b)), 0);
    const staked = arr.filter((b) => b.status !== "push" && b.status !== "void").reduce((s, b) => s + unitsOf(b), 0);
    // flat 1u baseline (for comparison)
    const flatNet = arr.reduce((s, b) => s + profitUnits(b.status, Number(b.odds), 1), 0);
    const flatRisked = w + l;
    return {
      n: arr.length, w, l, ps, v, winPct: flatRisked ? w / flatRisked : null,
      net, staked, roi: staked ? net / staked : null,
      flatNet, flatRoi: flatRisked ? flatNet / flatRisked : null,
    };
  };
  const byType = {}; for (const t of typeOrder) { const a = settled.filter((b) => b.type === t); if (a.length) byType[t] = agg(a); }
  return { overall: agg(settled), byType, openCount: bets.filter((b) => b.status === "open").length };
}

/* ---------------- CSV export (bets + stats summary) ---------------- */
const esc = (v) => { if (v == null) return ""; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function betsCsv(bets, stats, typeOrder = []) {
  const pctOr = (x) => (x == null ? "" : (x * 100).toFixed(1));
  const o = stats.overall;
  const lines = [];
  lines.push("SUMMARY");
  lines.push(["metric", "value"].join(","));
  lines.push(["settled", o.n].join(","));
  lines.push(["record", `${o.w}-${o.l}${o.ps ? `-${o.ps}` : ""}`].join(","));
  lines.push(["win_pct", o.winPct != null ? (o.winPct * 100).toFixed(1) + "%" : ""].join(","));
  lines.push(["net_units_staked", o.net.toFixed(2)].join(","));
  lines.push(["roi_staked_pct", o.roi != null ? (o.roi * 100).toFixed(1) + "%" : ""].join(","));
  lines.push(["net_units_flat1u", o.flatNet.toFixed(2)].join(","));
  lines.push(["roi_flat1u_pct", o.flatRoi != null ? (o.flatRoi * 100).toFixed(1) + "%" : ""].join(","));
  lines.push(["open", stats.openCount].join(","));
  lines.push("");
  lines.push("BY TYPE");
  lines.push(["type", "won", "lost", "push", "win_pct", "net_staked", "net_flat1u"].join(","));
  for (const t of typeOrder) { const s = stats.byType[t]; if (!s) continue; lines.push([esc(t), s.w, s.l, s.ps, s.winPct != null ? (s.winPct * 100).toFixed(1) : "", s.net.toFixed(2), s.flatNet.toFixed(2)].join(",")); }
  lines.push("");
  lines.push("BETS");
  lines.push(["date", "game", "name", "type", "line", "side", "odds", "book", "model_pct", "proj", "novig_pct", "edge_pct", "ev_pct", "units", "suggested", "status", "actual", "profit_units", "current_odds", "clv_pts"].join(","));
  // export EVERY tracked bet (open + settled), independent of the My Bets view filters
  const allBets = [...bets].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  for (const b of allBets) {
    const odds = Number(b.odds);
    const imp = isNaN(odds) ? null : impliedProb(odds);
    const fairRef = b.novig != null ? b.novig : imp;
    const edge = (b.modelP != null && fairRef != null) ? b.modelP - fairRef : null;
    const ev = (b.modelP != null && !isNaN(odds)) ? evPerUnit(b.modelP, odds) : null;
    const units = b.units != null ? b.units : 1;
    const profit = (b.status === "won" || b.status === "lost") ? profitUnits(b.status, odds, units).toFixed(2) : "";
    const clv = (b.currentOdds != null && !isNaN(odds)) ? ((impliedProb(b.currentOdds) - impliedProb(odds)) * 100).toFixed(1) : "";
    lines.push([
      esc(b.date), esc(b.game), esc(b.name), esc(b.type), esc(b.line), esc(b.side), esc(b.odds), esc(b.book),
      b.modelP != null ? (b.modelP * 100).toFixed(1) : "", b.proj != null ? Number(b.proj).toFixed(2) : "",
      b.novig != null ? (b.novig * 100).toFixed(1) : "", pctOr(edge), pctOr(ev),
      units, b.suggested != null ? b.suggested : "", esc(b.status), esc(b.actual), profit,
      b.currentOdds != null ? b.currentOdds : "", clv,
    ].join(","));
  }
  return lines.join("\n");
}

// save text as a file in the browser
export function downloadText(text, filename, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------------- backup / restore ---------------- */
// lossless backup of the bet log so it survives a host/browser change (localStorage does not)
export function betsBackupJson(bets, app) {
  return JSON.stringify({ app, v: 1, exported: new Date().toISOString(), bets }, null, 2);
}
// -> the backup's bets, or null when the text isn't a bet backup (throws on invalid JSON)
export function parseBetsBackup(text) {
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.bets) ? parsed.bets : null);
}
// bets from a backup that aren't already tracked (matched by key)
export function newFromBackup(current, incoming) {
  const have = new Set(current.map((b) => b.key));
  return incoming.filter((b) => b && b.key != null && !have.has(b.key));
}
export function mergeRestored(current, toAdd) {
  const k = new Set(current.map((b) => b.key));
  return [...current, ...toAdd.filter((b) => !k.has(b.key))];
}

/* ---------------- settlement ---------------- */
// fetch final results for every game with an open bet: { results, games } (games = how many fetched)
export async function fetchOpenBetResults(sport, bets) {
  const openByGame = {};
  for (const b of bets) if (b.status === "open") (openByGame[b.gamePk] = openByGame[b.gamePk] || []).push(b);
  const pks = Object.keys(openByGame);
  const results = {};
  for (const pk of pks) { results[pk] = await sport.api.fetchGameResult(pk); }
  if (pks.length && sport.augmentResults) await sport.augmentResults(bets.filter((b) => b.status === "open"), results);
  return { results, games: pks.length };
}
// grade open bets against fetched results -> { next, graded }
export function gradeOpenBets(sport, bets, results) {
  let graded = 0;
  const next = bets.map((b) => {
    if (b.status !== "open") return b;
    const res = results[b.gamePk];
    if (res && res.canceled) { graded++; return { ...b, status: "void", actual: "CANCELED" }; }   // postponed / canceled game: no action
    if (!res || !res.final) return b;
    if (sport.config.isLineType(b.type)) {
      const { status, actual } = sport.gradeLineResult(b.type, b.side, parseFloat(b.line), res);
      if (!status) return b; graded++; return { ...b, status, actual };
    }
    const r = sport.gradeTrackedProp(b, res);
    if (r == null) return b;
    graded++; return { ...b, status: r.status, actual: r.actual };
  });
  return { next, graded };
}

/* ---------------- line refresh (current price / CLV) ---------------- */
// open: the open bets to refresh (with a book). getEvents(): the sport's odds events list.
// findGame(pk): the slate game for a bet's gamePk, or null. onCredits(n): remaining odds credits.
// -> { updates: key -> patch, matched, missed, games, frozen }
export async function refreshBetLines(sport, open, { getEvents, findGame, onCredits }) {
  const { matchEvent, fetchEventOdds, parseEventOdds, parseGameOdds, matchCurrentOdds } = sport.api;
  const byGame = {};
  for (const b of open) { (byGame[b.gamePk] = byGame[b.gamePk] || []).push(b); }
  const events = await getEvents();
  const updates = {}; let matched = 0, missed = 0, games_ = 0, frozen = 0;
  const at = new Date().toISOString();
  for (const pkStr in byGame) {
    const bets = byGame[pkStr];
    const g = findGame(pkStr);
    const ev = g ? matchEvent(events, g) : null;
    if (!ev) { for (const b of bets) { updates[b.key] = { oddsCheckedAt: at, currentOdds: null, lineMissing: true }; missed++; } continue; }
    // has first pitch passed? prefer the book's commence_time; fall back to slate status
    const started = ev.commence_time ? (Date.parse(ev.commence_time) <= Date.now()) : (g && (g.status === "LIVE" || g.status === "FINAL"));
    // pregame bets freeze at the closing line once the game starts (live re-prices aren't comparable). live bets keep updating.
    for (const b of bets) { if (!b.live && started && b.currentOdds != null && !b.closing) { updates[b.key] = { closing: true, oddsCheckedAt: at }; frozen++; } }
    const toPull = bets.filter((b) => b.live || !started);
    if (!toPull.length) continue; // nothing to fetch for this game (all pregame bets are frozen) -> saves credits
    // ONE fetch per game covering every book we track on it. Up to 10 books = 1 region cost, so this halves credits vs per-book calls.
    const books = [...new Set(toPull.map((b) => b.book))];
    const res = await fetchEventOdds(ev.id, books.join(",")); games_++;
    if (res.remaining != null) onCredits(res.remaining);
    const parsed = {};
    for (const bk of books) parsed[bk] = { rows: parseEventOdds(res.data, bk), gl: parseGameOdds(res.data, bk, g) };
    for (const b of toPull) {
      const p = parsed[b.book];
      const cur = p ? matchCurrentOdds(b, p.rows, p.gl) : null;
      if (cur != null) { updates[b.key] = { currentOdds: cur, oddsCheckedAt: at, lineMissing: false, closing: false }; matched++; }
      else { updates[b.key] = { oddsCheckedAt: at, currentOdds: null, lineMissing: true }; missed++; }
    }
  }
  return { updates, matched, missed, games: games_, frozen };
}
