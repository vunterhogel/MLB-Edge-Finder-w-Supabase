/* NBA data layer (moved from the old NBAApp.tsx onto the shared shell).
   ESPN for schedule / rosters / depth / logs / box scores; The Odds API via odds-proxy for prices. */
import { espnSite, fetchGamelog, fetchSummary, jget, num, numOrNull } from "../../core/espn";
import { normName, oddsProxyFetch, sideOf } from "../../core/odds";
import { evPerUnit, impliedProb, probToAmerican } from "../../core/math";
import { ALL_PLAYER_PROPS, GAME_MARKETS, MARKET_TO_TYPE, ODDS_SPORT, TEAMS, TYPE_TO_MARKET, isYesNoType } from "./config";
import { calibrateToMarket, jointGameProbs, marginProb } from "./engine";

const SPORT_PATH = "basketball/nba";
export const ESPN_SITE = espnSite(SPORT_PATH);
const ESPN_CORE = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba";
export function refId(ref) {
  if (!ref) return null;
  const matches = [...String(ref).matchAll(/\/(\d+)(?=[/?]|$)/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}
/* NBA "season year" = the year the season ends (Oct 2026 start -> 2027) */
export function nbaSeasonFor(dateStr) { const [y, m] = String(dateStr).split("-").map(Number); return m >= 7 ? y + 1 : y; }
// remembers which team a player is on, so Player Analysis can find his game on the slate
export const playerTeam = {};

export function classify(comp) {
  const st = comp && comp.status && comp.status.type;
  if (!st) return "SCHEDULED";
  if (st.completed) return "FINAL";
  if (st.state === "in") return "LIVE";
  return "SCHEDULED";
}
export function mapGame(ev) {
  const comp = ev.competitions && ev.competitions[0];
  const home = (comp.competitors || []).find((c) => c.homeAway === "home") || {};
  const away = (comp.competitors || []).find((c) => c.homeAway === "away") || {};
  const rec = (c) => { const r = (c.records || []).find((x) => x.type === "total" || !x.type); return r ? r.summary : ""; };
  const homeId = home.team && +home.team.id, awayId = away.team && +away.team.id;
  return {
    pk: String(ev.id), homeId, awayId,
    home: (home.team && home.team.abbreviation) || "HOME", away: (away.team && away.team.abbreviation) || "AWAY",
    homeName: (home.team && home.team.displayName) || "", awayName: (away.team && away.team.displayName) || "",
    homeRec: rec(home), awayRec: rec(away),
    time: ev.date ? new Date(ev.date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "TBD",
    gameTimeIso: ev.date || null, // raw scheduled tip-off timestamp — carried through to board log rows so the Parlay Builder can tell upcoming games from live/started ones
    dateLabel: ev.date ? new Date(ev.date).toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" }) : "",
    venue: (comp.venue && comp.venue.fullName) || "",
    status: classify(comp),
    homeScore: home.score != null ? +home.score : null, awayScore: away.score != null ? +away.score : null,
    period: comp.status && comp.status.period, clock: comp.status && comp.status.displayClock,
    manual: false,
  };
}
export async function fetchSchedule(date) {
  const d = await jget(`${ESPN_SITE}/scoreboard?dates=${String(date).replace(/-/g, "")}`);
  return (d.events || []).map(mapGame);
}
/* ---- team schedule (for rest/back-to-back computation, doc §4) ---- */
export async function fetchTeamSchedule(teamId, year) {
  try {
    const d = await jget(`${ESPN_SITE}/teams/${teamId}/schedule?season=${year}`);
    return (d.events || []).map((ev) => ({ date: ev.date ? new Date(ev.date) : null, completed: !!(ev.competitions && ev.competitions[0] && ev.competitions[0].status && ev.competitions[0].status.type && ev.competitions[0].status.type.completed) })).filter((e) => e.date).sort((a, b) => a.date - b.date);
  } catch { return []; }
}
export function computeRest(sched, gameDate) {
  if (!sched.length) return { daysRest: 2, backToBack: false };
  const t = gameDate.getTime();
  let prev = null;
  for (const g of sched) { if (g.date.getTime() < t) prev = g; else break; }
  if (!prev) return { daysRest: 2, backToBack: false };
  const days = Math.round((t - prev.date.getTime()) / 86400000);
  return { daysRest: days, backToBack: days <= 1 };
}

/* ---- roster (embeds injuries — one call per team gets both) ---- */
export async function fetchRoster(teamId) {
  const d = await jget(`${ESPN_SITE}/teams/${teamId}/roster`);
  const out = [];
  const list = Array.isArray(d.athletes) && d.athletes.length && d.athletes[0].items ? d.athletes.flatMap((g) => g.items || []) : (d.athletes || []);
  for (const a of list) {
    const inj = (a.injuries && a.injuries[0]) || null;
    out.push({
      id: a.id, name: a.fullName || a.displayName || "",
      pos: (a.position && (a.position.abbreviation || a.position.name)) || "",
      jersey: a.jersey || "",
      injuryStatus: inj ? String(inj.status || "").toUpperCase().replace(/\s+/g, "_") : null,
    });
  }
  return out;
}
/* ---- universal player search (the NBA equivalent of MLB/NFL's player search) ---- */
export function espnIdForTeamName(fullName) {
  if (!fullName) return null;
  const s = fullName.trim();
  for (const id in TEAMS) if (s.endsWith(TEAMS[id].name)) return +id;
  return null;
}
export async function searchPlayers(query) {
  const q = String(query || "").trim();
  if (!q) return [];
  try {
    const d = await jget(`https://site.api.espn.com/apis/search/v2?query=${encodeURIComponent(q)}&limit=20&type=player`);
    const contents = (d.results && d.results[0] && d.results[0].contents) || [];
    return contents
      .filter((p) => p.defaultLeagueSlug === "nba")
      .map((p) => {
        const m = String(p.uid || "").match(/a:(\d+)/);
        const id = m ? m[1] : refId(p.link && p.link.web);
        const teamName = p.subtitle || "";
        return { id, name: p.displayName || "", teamName, teamId: espnIdForTeamName(teamName) };
      })
      .filter((p) => p.id);
  } catch { return []; }
}
export async function fetchDepthChart(teamId, year) {
  try {
    const d = await jget(`${ESPN_CORE}/seasons/${year}/teams/${teamId}/depthcharts`);
    const out = {};
    for (const unit of d.items || []) {
      for (const posKey in unit.positions || {}) {
        const grp = unit.positions[posKey];
        for (const a of grp.athletes || []) {
          const id = refId(a.athlete && a.athlete.$ref);
          if (!id) continue;
          if (!out[id] || (a.rank || 99) < out[id].rank) out[id] = { pos: posKey.toUpperCase(), rank: a.rank || 99 };
        }
      }
    }
    return out;
  } catch { return {}; }
}
export const TREND_STAT_KEY = {
  "Points": "pts", "Rebounds": "reb", "Assists": "ast", "Three-Pointers Made": "fg3m",
  "Steals": "stl", "Blocks": "blk", "Turnovers": "tov",
};
export const TREND_PROPS = ALL_PLAYER_PROPS; // every NBA prop type is trend-eligible — no position gating like NFL's
export function trendValueForGame(row, type) {
  if (type === "Pts+Reb+Ast") return (row.pts || 0) + (row.reb || 0) + (row.ast || 0);
  if (type === "Pts+Reb") return (row.pts || 0) + (row.reb || 0);
  if (type === "Pts+Ast") return (row.pts || 0) + (row.ast || 0);
  if (type === "Reb+Ast") return (row.reb || 0) + (row.ast || 0);
  if (type === "Blocks+Steals") return (row.blk || 0) + (row.stl || 0);
  if (type === "Double-Double" || type === "Triple-Double") {
    const catsAt10 = [row.pts || 0, row.reb || 0, row.ast || 0, row.stl || 0, row.blk || 0].filter((v) => v >= 10).length;
    return catsAt10 >= (type === "Triple-Double" ? 3 : 2) ? 1 : 0;
  }
  const key = TREND_STAT_KEY[type];
  if (!key) return null;
  const v = row[key];
  return v != null ? v : 0;
}
export function hitRateFromGames(games, type, line, side) {
  if (!games || !games.length) return { n: 0, hits: 0, pct: null };
  let hits = 0, counted = 0;
  for (const row of games) {
    const v = trendValueForGame(row, type);
    if (v == null) continue;
    counted++;
    if (side === "under" ? v < line : v > line) hits++;
  }
  return { n: counted, hits, pct: counted ? hits / counted : null };
}
// Builds one Trends card for a player+prop from their already-fetched gamelog (`gl` — current
// season rows, or current+prior merged by trendGamelogFor() when the current season is thin).
// Sources the line from a matching Board entry when one exists (real odds, zero additional Odds
// API cost); otherwise synthesizes a model-free round-number threshold from the player's recent
// average. Double-Double/Triple-Double always use a fixed 0.5 "over" (=yes) line when synthesized,
// matching how this app already treats them as yes/no bets (isYesNoType) rather than real lines.
export function buildTrendCard(p, type, gl, g, isHome, boardEntriesForGame, recentN) {
  if (!gl || !gl.games || !gl.games.length) return null;
  const oppAbbr = isHome ? g.away : g.home;
  const matches = boardEntriesForGame.filter((e) => String(e.playerId) === String(p.id) && e.type === type);
  const chosen = matches.find((e) => e.side === "over") || matches.find((e) => e.side === "under") || null;
  let line, side, sourced, odds = null, boardEntryId = null;
  if (chosen) {
    line = parseFloat(chosen.line); side = chosen.side; sourced = "book"; odds = chosen.odds; boardEntryId = chosen.id;
  } else if (type === "Double-Double" || type === "Triple-Double") {
    line = 0.5; side = "over"; sourced = "model";
  } else {
    const recentVals = gl.games.slice(0, recentN).map((row) => trendValueForGame(row, type)).filter((v) => v != null);
    if (!recentVals.length) return null;
    const avg = recentVals.reduce((a, b) => a + b, 0) / recentVals.length;
    let synth = Math.floor(avg) + 0.5; if (synth > avg) synth -= 1;
    line = Math.max(0.5, synth); side = "over"; sourced = "model";
  }
  const recentGames = gl.games.slice(0, recentN);
  const recentForm = hitRateFromGames(recentGames, type, line, side);
  const h2hGames = gl.games.filter((row) => row.opp === oppAbbr);
  const vsOpp = hitRateFromGames(h2hGames, type, line, side);
  const wantAtVs = isHome ? "vs" : "@";
  const venueGames = gl.games.filter((row) => row.atVs === wantAtVs);
  const homeAway = hitRateFromGames(venueGames, type, line, side);
  if (!recentForm.n && !vsOpp.n && !homeAway.n) return null;
  return {
    id: `${g.pk}-${p.id}-${type}-${line}-${side}`, gamePk: g.pk, game: `${g.away}@${g.home}`,
    playerId: p.id, name: p.name, type, line, side, sourced, odds, boardEntryId,
    recentForm, vsOpp, homeAway, opp: oppAbbr, isHome,
  };
}
export function pickCat(categories, wantNames) {
  const out = {};
  for (const cat of categories || []) {
    for (const s of cat.stats || []) {
      const nm = String(s.name || "").toLowerCase();
      for (const want of wantNames) if (nm === want.toLowerCase() && out[want] == null) out[want] = numOrNull(s.value);
    }
  }
  return out;
}
export async function fetchTeamStats(teamId) {
  try {
    const d = await jget(`${ESPN_SITE}/teams/${teamId}/statistics`);
    const categories = (d.results && d.results.stats && d.results.stats.categories) || (d.splits && d.splits.categories) || d.categories || [];
    const off = pickCat(categories, ["avgPoints", "pace", "possessions", "offensiveRating", "avgRebounds", "avgAssists"]);
    const def = pickCat(categories, ["avgPointsAllowed", "defensiveRating", "opponentAvgPoints"]);
    return { off, def, raw: categories.length > 0 };
  } catch { return { off: {}, def: {}, raw: false }; }
}
export async function fetchStandings(year) {
  try {
    const d = await jget(`${ESPN_SITE.replace("/apis/site/v2", "/apis/v2")}/standings?season=${year}`);
    const out = {};
    const walk = (node) => {
      if (node && node.standings && node.standings.entries) {
        for (const e of node.standings.entries) {
          const id = e.team && +e.team.id; if (!id) continue;
          const stat = (name) => { const s = (e.stats || []).find((x) => x.name === name); return s ? numOrNull(s.value) : null; };
          const w = stat("wins") || 0, l = stat("losses") || 0;
          const g = Math.max(w + l, 1);
          out[id] = { pf: stat("pointsFor"), pa: stat("pointsAgainst"), g, ppgFor: (stat("pointsFor") || 0) / g, ppgAgainst: (stat("pointsAgainst") || 0) / g };
        }
      }
      for (const c of (node && node.children) || []) walk(c);
    };
    walk(d);
    return out;
  } catch { return {}; }
}

export async function fetchOddsEvents(sportKey) {
  const r = await oddsProxyFetch(`/sports/${sportKey}/events`, "dateFormat=iso");
  const remaining = r.headers.get("x-requests-remaining");
  if (!r.ok) throw new Error(`events ${r.status}`);
  const data = await r.json();
  return { events: data || [], remaining: remaining != null ? +remaining : null };
}
export async function fetchEventOdds(sportKey, eventId, book) {
  const markets = [...Object.values(TYPE_TO_MARKET), ...GAME_MARKETS].join(",");
  const r = await oddsProxyFetch(`/sports/${sportKey}/events/${eventId}/odds`, `regions=us&markets=${markets}&oddsFormat=american&bookmakers=${book}`);
  const remaining = r.headers.get("x-requests-remaining");
  if (!r.ok) throw new Error(`odds ${r.status}`);
  const data = await r.json();
  return { data, remaining: remaining != null ? +remaining : null };
}
// Match by NICKNAME (e.g. "clippers", "lakers"), not full display-name substring. ESPN's
// displayName and The Odds API's home_team/away_team don't always agree on the CITY half for
// NBA specifically — "LA Clippers" vs "Los Angeles Clippers" is the classic case (both teams
// share the "LA"/"Los Angeles" market with the Lakers, so this isn't a hypothetical edge case).
// A full-string "includes" match silently fails there even though the game is obviously the
// same one; anchoring on the nickname (which both sources always agree on) is robust to any
// city-name formatting difference. Falls back to the old full-name substring match if a team
// id doesn't resolve to our TEAMS table for some reason.
export function nickOf(teamId, fallbackFullName) {
  const t = TEAMS[teamId];
  return normName(t ? t.name : fallbackFullName);
}
export function matchEvent(events, g) {
  const hNick = nickOf(g.homeId, g.homeName), aNick = nickOf(g.awayId, g.awayName);
  const byNick = (events || []).find((e) => hNick && aNick && normName(e.home_team).endsWith(hNick) && normName(e.away_team).endsWith(aNick));
  if (byNick) return byNick;
  const hn = normName(g.homeName), an = normName(g.awayName);
  return (events || []).find((e) => normName(e.home_team).includes(hn) && normName(e.away_team).includes(an));
}
export function parseEventOdds(data, bookKey) {
  const bm = (data.bookmakers || []).find((b) => b.key === bookKey);   // no fallback: a price is always labeled with the book it came from
  if (!bm) return [];
  const rows = [];
  for (const mk of bm.markets || []) {
    const type = MARKET_TO_TYPE[mk.key]; if (!type) continue;
    const byKey = {};
    for (const o of mk.outcomes || []) {
      let side = sideOf(o.name), player = o.description;
      if (!side && sideOf(o.description)) { side = sideOf(o.description); player = o.name; }
      if (!side) continue;
      const pt = (o.point == null ? 0.5 : o.point);
      const k = `${player || ""}|${pt}`;
      byKey[k] = byKey[k] || { type, player, point: pt, over: null, under: null };
      if (side === "over") byKey[k].over = o.price; else byKey[k].under = o.price;
    }
    for (const k in byKey) rows.push(byKey[k]);
  }
  return rows;
}
export function parseGameOdds(data, bookKey, g) {
  const bm = (data.bookmakers || []).find((b) => b.key === bookKey);   // no fallback: a price is always labeled with the book it came from
  if (!bm) return {};
  // nickname-anchored match, same reasoning as matchEvent above — an outcome named "LA
  // Clippers" needs to resolve to our home/away side even when g.homeName is ESPN's
  // "Los Angeles Clippers" (or vice versa).
  const hNick = nickOf(g.homeId, g.homeName), aNick = nickOf(g.awayId, g.awayName);
  const hn = normName(g.homeName), an = normName(g.awayName);
  const isHome = (nm) => (hNick && nm.endsWith(hNick)) || (hn && nm.includes(hn));
  const isAway = (nm) => (aNick && nm.endsWith(aNick)) || (an && nm.includes(an));
  const out = {};
  for (const mk of bm.markets || []) {
    if (mk.key === "h2h") {
      out.h2h = {};
      for (const o of mk.outcomes || []) { const nm = normName(o.name); if (isHome(nm)) out.h2h.home = o.price; else if (isAway(nm)) out.h2h.away = o.price; }
    } else if (mk.key === "totals") {
      out.totals = {};
      for (const o of mk.outcomes || []) { const s = (o.name || "").toLowerCase(); if (o.point != null) out.totals.point = o.point; if (s === "over") out.totals.over = o.price; else if (s === "under") out.totals.under = o.price; }
    } else if (mk.key === "spreads") {
      out.spreads = {};
      for (const o of mk.outcomes || []) { const nm = normName(o.name); if (isHome(nm)) { out.spreads.homePoint = o.point; out.spreads.home = o.price; } else if (isAway(nm)) { out.spreads.awayPoint = o.point; out.spreads.away = o.price; } }
    }
  }
  return out;
}
export function matchCurrentOdds(bet, rows, gl) {
  const t = bet.type, ln = Number(bet.line);
  if (t === "Moneyline") return gl && gl.h2h ? (bet.side === "home" ? gl.h2h.home : gl.h2h.away) ?? null : null;
  if (t === "Total") { if (!gl || !gl.totals || gl.totals.point == null || Math.abs(gl.totals.point - ln) > 1e-6) return null; return (bet.side === "over" ? gl.totals.over : gl.totals.under) ?? null; }
  if (t === "Spread") { if (!gl || !gl.spreads) return null; const pt = bet.side === "home" ? gl.spreads.homePoint : gl.spreads.awayPoint; if (pt == null || Math.abs(pt - ln) > 1e-6) return null; return (bet.side === "home" ? gl.spreads.home : gl.spreads.away) ?? null; }
  const bn = normName(bet.name);
  const r = (rows || []).find((x) => x.type === t && normName(x.player) === bn && Math.abs(x.point - ln) < 1e-6);
  if (!r) return null;
  return (bet.side === "over" ? r.over : r.under) ?? null;
}
export function buildGameLineEntries(g, d, gl, book) {
  const entries = [];
  const lambdaH = d.lambdaH, lambdaA = d.lambdaA;
  const projH = lambdaH, projA = lambdaA;
  const total = projH + projA;
  const totalPt = gl.totals && gl.totals.point != null ? gl.totals.point : null;
  const gp = jointGameProbs(lambdaH, lambdaA, 0, 0, totalPt);
  const base = `model line: ${g.away} ${projA.toFixed(1)} – ${projH.toFixed(1)} ${g.home}`;
  const mk = (name, type, line, side, odds, oppOdds, modelP0, proj, params) => {
    if (odds == null) return null;
    const imp = impliedProb(odds);
    const novig = oppOdds != null ? (imp / (imp + impliedProb(oppOdds))) : imp;
    const modelP = calibrateToMarket(modelP0, novig, type);
    const bm = odds > 0 ? odds / 100 : 100 / -odds;
    return {
      id: `${g.pk}-line-${type}-${side}`, gamePk: g.pk, game: `${g.away}@${g.home}`, gameTimeIso: g.gameTimeIso || null, name, type, line: String(line), side, odds, overOdds: null, underOdds: null, book,
      modelP, rawModelP: modelP0, proj, calc: { dist: "Two-NegBin", params, proj, baseStr: base, mults: [], live: null },
      imp, novig, edge: modelP - novig, ev: evPerUnit(modelP, odds), b: bm, fair: probToAmerican(modelP), devigged: oppOdds != null,
    };
  };
  if (gl.h2h) {
    const e1 = mk(`${g.home} ML`, "Moneyline", "", "home", gl.h2h.home, gl.h2h.away, gp.home, projH, "P(home win)");
    const e2 = mk(`${g.away} ML`, "Moneyline", "", "away", gl.h2h.away, gl.h2h.home, gp.away, projA, "P(away win)");
    if (e1) entries.push(e1); if (e2) entries.push(e2);
  }
  if (totalPt != null) {
    const e1 = mk(`Total ${totalPt}`, "Total", totalPt, "over", gl.totals.over, gl.totals.under, gp.over, total, `P(final total>${totalPt})`);
    const e2 = mk(`Total ${totalPt}`, "Total", totalPt, "under", gl.totals.under, gl.totals.over, gp.under, total, `P(final total<${totalPt})`);
    if (e1) entries.push(e1); if (e2) entries.push(e2);
  }
  if (gl.spreads && gl.spreads.homePoint != null) {
    const hp = gl.spreads.homePoint, ap = gl.spreads.awayPoint;
    const pHome = marginProb(lambdaH, lambdaA, 0, 0, (m) => m > -hp);
    const pAway = ap != null ? marginProb(lambdaH, lambdaA, 0, 0, (m) => m < ap) : 1 - pHome;
    const e1 = mk(`${g.home} ${hp > 0 ? "+" : ""}${hp}`, "Spread", hp, "home", gl.spreads.home, gl.spreads.away, pHome, projH - projA, `P(home margin > ${-hp})`);
    const e2 = mk(`${g.away} ${ap > 0 ? "+" : ""}${ap}`, "Spread", ap, "away", gl.spreads.away, gl.spreads.home, pAway, projA - projH, `P(home margin < ${ap})`);
    if (e1) entries.push(e1); if (e2) entries.push(e2);
  }
  return entries;
}

/* ---- settling helpers ----
   ESPN's NBA box score (unlike NFL's multi-category passing/rushing/receiving split) reports
   one flat stat line per player — no cross-category label collisions to worry about, so
   actualFor() looks the field up directly by key/label. */
export const BOX_STAT_FOR = {
  "Points": ["points", "PTS"], "Rebounds": ["rebounds", "REB"], "Assists": ["assists", "AST"],
  "Three-Pointers Made": ["threePointFieldGoalsMade-threePointFieldGoalsAttempted", "threePointFieldGoalsMade", "3PM"]   // ESPN box key is "made-attempted"; the old name never matched, so every 3PM bet settled as 0, "Steals": ["steals", "STL"], "Blocks": ["blocks", "BLK"], "Turnovers": ["turnovers", "TO"],
};
export function actualFor(type, ps) {
  if (!ps) return null; // player never appeared in the box score -> void/DNP, handled upstream
  if (type === "Pts+Reb+Ast" || type === "Pts+Reb" || type === "Pts+Ast" || type === "Reb+Ast" || type === "Blocks+Steals" || type === "Double-Double" || type === "Triple-Double") {
    const p = num(ps.points ?? ps.PTS), r = num(ps.rebounds ?? ps.REB), a = num(ps.assists ?? ps.AST), s = num(ps.steals ?? ps.STL), bl = num(ps.blocks ?? ps.BLK);
    if (type === "Pts+Reb+Ast") return p + r + a;
    if (type === "Pts+Reb") return p + r;
    if (type === "Pts+Ast") return p + a;
    if (type === "Reb+Ast") return r + a;
    if (type === "Blocks+Steals") return bl + s;
    const cats = [p, r, a, s, bl].filter((x) => x >= 10).length;
    return (type === "Double-Double" ? cats >= 2 : cats >= 3) ? 1 : 0;
  }
  const cands = BOX_STAT_FOR[type];
  if (!cands) return null;
  for (const key of cands) { if (ps[key] != null) return num(ps[key]); }
  return 0; // participated, recorded zero in this category — a real gradeable zero, not an unknown
}
export function gradeLine(type, side, point, homeScore, awayScore) {
  if (homeScore == null || awayScore == null) return { status: null, actual: null };
  if (type === "Moneyline") {
    if (homeScore === awayScore) return { status: "push", actual: `${awayScore}-${homeScore}` }; // practically never happens (OT resolves it) but keep the grid honest
    const homeWin = homeScore > awayScore;
    const win = side === "home" ? homeWin : !homeWin;
    return { status: win ? "won" : "lost", actual: `${awayScore}-${homeScore}` };
  }
  if (type === "Total") {
    const tot = homeScore + awayScore;
    if (tot === point) return { status: "push", actual: tot };
    const over = tot > point;
    return { status: (side === "over" ? over : !over) ? "won" : "lost", actual: tot };
  }
  if (type === "Spread") {
    const margin = side === "home" ? (homeScore - awayScore) : (awayScore - homeScore);
    if (margin + point === 0) return { status: "push", actual: `${awayScore}-${homeScore}` };
    return { status: (margin + point) > 0 ? "won" : "lost", actual: `${awayScore}-${homeScore}` };
  }
  return { status: null, actual: null };
}

/* ---- athlete game logs ----
   Rebuilt on core/espn fetchGamelog, which fixes three problems the old NBA parser had:
   1. ESPN reports threes as "made-attempted" ("2-3") under threePointFieldGoalsMade-threePointFieldGoalsAttempted;
      the old exact-name alias never matched, so every player's 3PM rate was 0.
   2. Preseason games were mixed into season and recent-form numbers.
   3. Before a player's first game of the season, ESPN's default log is LAST season, and the
      "prior season" fetch returned that same season again (double counting in Trends).
   Rows: newest first, regular season + postseason, { eventId, date, atVs, opp, ..., min, pts, reb, ... }. */
const S = {
  min: "minutes", pts: "points", reb: "totalRebounds", ast: "assists", stl: "steals", blk: "blocks", tov: "turnovers",
  fg3m: "threePointFieldGoalsMade-threePointFieldGoalsAttempted", fgm: "fieldGoalsMade-fieldGoalsAttempted",
};
function toRow(r) {
  const out = { eventId: r.eventId, date: r.date, atVs: r.atVs, opp: r.opp, score: r.score, result: r.result, postseason: r.postseason };
  for (const k in S) out[k] = r.s[S[k]] != null ? r.s[S[k]] : (k === "reb" && r.s.rebounds != null ? r.s.rebounds : 0);
  return out;
}
export async function fetchSeasonRows(athleteId, season) {
  const rows = await fetchGamelog(SPORT_PATH, athleteId, season).catch(() => []);
  return rows.map(toRow);
}
const KEYS = ["min", "pts", "reb", "ast", "stl", "blk", "tov", "fg3m", "fgm"];
export function aggregate(rows, w = 1) {
  const a = { g: 0 }; for (const k of KEYS) a[k] = 0;
  for (const r of rows) { a.g += w; for (const k of KEYS) a[k] += w * (r[k] || 0); }
  return a;
}
// season base = this season's regular-season games + last season's. Last season counts in full on
// opening night and fades to half weight by game 15, so week 1 leans on last year instead of
// collapsing to the position prior, and by mid-November this season dominates.
export const priorSeasonWeight = (curGames) => Math.max(0.5, 1 - curGames / 30);
export function buildPlayerLog(cur, prior) {
  const curReg = (cur || []).filter((r) => !r.postseason && r.min > 0);
  const priorReg = (prior || []).filter((r) => !r.postseason && r.min > 0).slice(0, 60);
  const sc = aggregate(curReg), sp = aggregate(priorReg, priorSeasonWeight(curReg.length));
  const season = { g: sc.g + sp.g }; for (const k of KEYS) season[k] = sc[k] + sp[k];
  const recentRows = curReg.slice(0, 10);
  const recent = aggregate(recentRows); recent.games = recentRows.length; delete recent.g;
  return { season, recent, games: [...(cur || []), ...(prior || [])], curGames: curReg.length, priorGames: priorReg.length };
}

/* ---- box score for settling ---- */
export async function fetchGameSummary(eventId) {
  try {
    const s = await fetchSummary(SPORT_PATH, eventId);
    const players = {};
    for (const id in s.players) {
      const p = s.players[id];
      // a DNP shows up in the box with no stat line: that is no action, not a zero
      if (!(p.minutes > 0)) continue;
      players[id] = p;
    }
    return { final: s.final, canceled: s.canceled, homeScore: s.homeScore, awayScore: s.awayScore, players };
  } catch { return { final: false, canceled: false, homeScore: null, awayScore: null, players: {} }; }
}
