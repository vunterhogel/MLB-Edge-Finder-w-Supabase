/* NHL data layer: ESPN for schedule / rosters / logs / box scores, The Odds API (via odds-proxy) for prices. */
import { espnSite, espnWeb, fetchGamelog, fetchSummary, jget, numOrNull, searchEspnPlayers, ymd } from "../../core/espn";
import { normName, oddsProxyFetch, sideOf } from "../../core/odds";
import { evPerUnit, impliedProb, probToAmerican } from "../../core/math";
import { GAME_MARKETS, MARKET_TO_TYPE, ODDS_SPORT, SPORT_PATH, TYPE_TO_MARKET } from "./config";
import { calibrateToMarket, fractionRemaining, gameProbs, marginProb } from "./engine";

const SITE = espnSite(SPORT_PATH);

/* ESPN season label: 2026-27 is "2027". Seasons roll over in September. */
export function espnSeasonFor(dateStr) { const [y, m] = String(dateStr).split("-").map(Number); return m >= 9 ? y + 1 : y; }

// remembers which team a player belongs to, so a Player Analysis lookup can find his game on the slate
export const playerTeam = {};

/* ---------------- schedule ---------------- */
function classify(comp, hasGoalies) {
  const st = comp && comp.status && comp.status.type;
  if (st && st.completed) return "FINAL";
  if (st && st.state === "in") return "LIVE";
  if (st && /POSTPON|CANCEL/i.test(String(st.name || ""))) return "POSTPONED";
  return hasGoalies ? "GOALIES" : "SCHEDULED";
}
function probableGoalie(c) {
  const p = (c.probables || []).find((x) => /Goalie/i.test(String(x.name || "")));
  if (!p || !p.athlete) return null;
  return { id: String(p.athlete.id), name: p.athlete.displayName || p.athlete.fullName || "", status: (p.status && p.status.name) || "Expected" };
}
export async function fetchSchedule(date) {
  const d = await jget(`${SITE}/scoreboard?dates=${ymd(date)}`);
  return (d.events || []).map((ev) => {
    const comp = ev.competitions && ev.competitions[0];
    const home = (comp.competitors || []).find((c) => c.homeAway === "home") || {};
    const away = (comp.competitors || []).find((c) => c.homeAway === "away") || {};
    const rec = (c) => { const r = (c.records || []).find((x) => x.type === "total"); return r ? r.summary : ""; };
    const homeGoalie = probableGoalie(home), awayGoalie = probableGoalie(away);
    const status = classify(comp, !!(homeGoalie || awayGoalie));
    return {
      pk: String(ev.id), homeId: home.team ? String(home.team.id) : null, awayId: away.team ? String(away.team.id) : null,
      home: (home.team && home.team.abbreviation) || "HOME", away: (away.team && away.team.abbreviation) || "AWAY",
      homeName: (home.team && home.team.displayName) || "", awayName: (away.team && away.team.displayName) || "",
      homeNick: (home.team && home.team.name) || "", awayNick: (away.team && away.team.name) || "",
      homeRec: rec(home), awayRec: rec(away),
      time: ev.date ? new Date(ev.date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "TBD",
      gameTimeIso: ev.date || null, venue: (comp.venue && comp.venue.fullName) || "",
      status, homeScore: home.score != null && status !== "SCHEDULED" && status !== "GOALIES" ? +home.score : null,
      awayScore: away.score != null && status !== "SCHEDULED" && status !== "GOALIES" ? +away.score : null,
      period: comp.status ? comp.status.period : null, clock: comp.status ? comp.status.displayClock : null,
      homeGoalie, awayGoalie, manual: false,
    };
  });
}

/* ---------------- rosters / team stats ---------------- */
export async function fetchRoster(teamId) {
  const d = await jget(`${SITE}/teams/${teamId}/roster`);
  const out = [];
  for (const grp of d.athletes || []) {
    for (const a of grp.items || []) {
      const pos = (a.position && a.position.abbreviation) || "";
      // ESPN keeps old entries around (e.g. a July note on a player who has since returned) and some
      // statuses are bare codes: only a recent, readable status counts as an injury
      const raw = (a.injuries && a.injuries[0]) || null;
      const fresh = raw && raw.date && Date.now() - Date.parse(raw.date) < 60 * 86400000;
      const inj = raw && fresh && /[a-z]/i.test(String(raw.status || "")) ? raw : null;
      out.push({ id: String(a.id), name: a.fullName || a.displayName || "", pos, group: pos === "G" ? "G" : pos === "D" ? "D" : "F", jersey: a.jersey || "", injury: inj ? String(inj.status || "Injured") : null });
    }
  }
  return out;
}
export async function fetchTeamStats(teamId, season) {
  const d = await jget(`${SITE}/teams/${teamId}/statistics${season ? `?season=${season}` : ""}`);
  const cats = (d.results && d.results.stats && d.results.stats.categories) || [];
  const v = {};
  for (const c of cats) for (const s of c.stats || []) if (v[s.name] == null) v[s.name] = numOrNull(s.value);
  return { gp: v.games || 0, gf: v.goals || 0, ga: v.goalsAgainst || 0, sf: v.shotsTotal || 0, sa: v.shotsAgainst || 0, ppPct: v.powerPlayPct != null ? v.powerPlayPct : null, wins: v.wins, losses: v.losses };
}
export async function fetchPlayerLogs(id, season) {
  // ESPN falls back to a player's latest season when he has no games this season: keep only this season's rows
  const start = `${season - 1}-09-01`;
  const cur = (await fetchGamelog(SPORT_PATH, id, season).catch(() => [])).filter((r) => !r.date || r.date >= start);
  const curReg = cur.filter((r) => !r.postseason);
  let prior = [];
  if (curReg.length < 30) prior = await fetchGamelog(SPORT_PATH, id, season - 1).catch(() => []);
  return { cur, prior };
}

/* ---------------- game result (settling + live box) ---------------- */
export async function fetchGameResult(pk) {
  try {
    const s = await fetchSummary(SPORT_PATH, pk);
    const players = {};
    for (const id in s.players) {
      const p = s.players[id];
      players[id] = { ...p, played: !p.scratched && (p.timeOnIce || 0) > 0, ppp: 0 };
    }
    // power-play points are not in the box line: count them from power-play scoring plays
    for (const pl of s.plays || []) {
      if (!pl.scoringPlay || !pl.strength || !/power/i.test(String(pl.strength.abbreviation || pl.strength.text || ""))) continue;
      if (pl.period && pl.period.number >= 5) continue; // shootout
      for (const pt of pl.participants || []) {
        const id = pt.athlete && String(pt.athlete.id);
        if (id && (pt.type === "scorer" || pt.type === "assister")) { players[id] = players[id] || { played: true }; players[id].ppp = (players[id].ppp || 0) + 1; }
      }
    }
    return { final: s.final, canceled: s.canceled, homeScore: s.homeScore, awayScore: s.awayScore, period: s.period, clock: s.clock, players };
  } catch { return { final: false, players: {} }; }
}
export function statFor(type, p) {
  if (!p) return null;
  if (type === "Shots on Goal") return p.shotsTotal || 0;
  if (type === "Goals") return p.goals || 0;
  if (type === "Assists") return p.assists || 0;
  if (type === "Points") return (p.goals || 0) + (p.assists || 0);
  if (type === "Power Play Points") return p.ppp || 0;
  if (type === "Saves") return p.saves || 0;
  return null;
}

/* ---------------- odds ---------------- */
export async function fetchOddsEvents() {
  const r = await oddsProxyFetch(`/sports/${ODDS_SPORT}/events`, "dateFormat=iso");
  const remaining = r.headers.get("x-requests-remaining");
  if (!r.ok) throw new Error(`events ${r.status}`);
  return { events: (await r.json()) || [], remaining: remaining != null ? +remaining : null };
}
export async function fetchEventOdds(eventId, book) {
  const markets = [...Object.values(TYPE_TO_MARKET), ...GAME_MARKETS].join(",");
  const r = await oddsProxyFetch(`/sports/${ODDS_SPORT}/events/${eventId}/odds`, `regions=us&markets=${markets}&oddsFormat=american&bookmakers=${book}`);
  const remaining = r.headers.get("x-requests-remaining");
  if (!r.ok) throw new Error(`odds ${r.status}`);
  return { data: await r.json(), remaining: remaining != null ? +remaining : null };
}
// match on team nickname ("Wild", "Maple Leafs"): city spellings differ between feeds (St. Louis, Montréal)
const nick = (g, side) => normName(side === "home" ? (g.homeNick || g.homeName) : (g.awayNick || g.awayName));
export function matchEvent(events, g) {
  const hn = nick(g, "home"), an = nick(g, "away");
  return (events || []).find((e) => normName(e.home_team).endsWith(hn) && normName(e.away_team).endsWith(an));
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
      const pt = o.point == null ? 0.5 : o.point;
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
  if (!bm || !g) return {};
  const hn = nick(g, "home"), an = nick(g, "away");
  const isHome = (nm) => normName(nm).endsWith(hn), isAway = (nm) => normName(nm).endsWith(an);
  const out = {};
  for (const mk of bm.markets || []) {
    if (mk.key === "h2h") { out.h2h = {}; for (const o of mk.outcomes || []) { if (isHome(o.name)) out.h2h.home = o.price; else if (isAway(o.name)) out.h2h.away = o.price; } }
    else if (mk.key === "totals") { out.totals = {}; for (const o of mk.outcomes || []) { const s = (o.name || "").toLowerCase(); if (o.point != null) out.totals.point = o.point; if (s === "over") out.totals.over = o.price; else if (s === "under") out.totals.under = o.price; } }
    else if (mk.key === "spreads") { out.spreads = {}; for (const o of mk.outcomes || []) { if (isHome(o.name)) { out.spreads.homePoint = o.point; out.spreads.home = o.price; } else if (isAway(o.name)) { out.spreads.awayPoint = o.point; out.spreads.away = o.price; } } }
  }
  return out;
}
export function matchCurrentOdds(bet, rows, gl) {
  const t = bet.type, ln = Number(bet.line);
  if (t === "Moneyline") return gl && gl.h2h ? (bet.side === "home" ? gl.h2h.home : gl.h2h.away) ?? null : null;
  if (t === "Total") { if (!gl || !gl.totals || gl.totals.point == null || Math.abs(gl.totals.point - ln) > 1e-6) return null; return (bet.side === "over" ? gl.totals.over : gl.totals.under) ?? null; }
  if (t === "Puck Line") { if (!gl || !gl.spreads) return null; const pt = bet.side === "home" ? gl.spreads.homePoint : gl.spreads.awayPoint; if (pt == null || Math.abs(pt - ln) > 1e-6) return null; return (bet.side === "home" ? gl.spreads.home : gl.spreads.away) ?? null; }
  const bn = normName(bet.name);
  const r = (rows || []).find((x) => x.type === t && normName(x.player) === bn && Math.abs(x.point - ln) < 1e-6);
  return r ? ((bet.side === "over" ? r.over : r.under) ?? null) : null;
}
export function oddsDebug(data, bookKey) {
  const bms = data.bookmakers || [];
  const bm = bms.find((b) => b.key === bookKey) || bms[0];
  const rawKeys = bm ? (bm.markets || []).map((m) => m.key) : [];
  const mk = bm && (bm.markets || []).find((m) => m.key === "player_total_saves");
  return { books: bms.map((b) => b.key), usedBook: bm ? bm.key : null, rawKeys, hasHR: !!mk, hrSample: mk && mk.outcomes ? mk.outcomes[0] : null };
}

/* moneyline / puck line / total entries from the model + market */
export function buildGameLineEntries(g, d, gl, book) {
  const entries = [];
  const live = g.status === "LIVE" && g.homeScore != null;
  const fr = live ? fractionRemaining(g.period, g.clock) : 1;
  const hc = live ? g.homeScore : 0, ac = live ? g.awayScore : 0;
  const totalPt = gl.totals && gl.totals.point != null ? gl.totals.point : null;
  const gp = gameProbs(d.lambdaH, d.lambdaA, hc, ac, fr, totalPt);
  const projH = hc + d.lambdaH * fr, projA = ac + d.lambdaA * fr;
  const base = `model: ${g.away} ${projA.toFixed(2)} – ${projH.toFixed(2)} ${g.home}${live ? ` · LIVE ${(fr * 100).toFixed(0)}% left, ${ac}-${hc}` : ""}`;
  const mk = (name, type, line, side, odds, oppOdds, p0, proj, params) => {
    if (odds == null) return null;
    const imp = impliedProb(odds);
    const novig = oppOdds != null ? imp / (imp + impliedProb(oppOdds)) : imp;
    const modelP = calibrateToMarket(p0, novig, type);
    return {
      id: `${g.pk}-line-${type}-${side}`, gamePk: g.pk, game: `${g.away}@${g.home}`, gameTimeIso: g.gameTimeIso || null, name, type, line: String(line), side, odds, overOdds: null, underOdds: null, book,
      modelP, rawModelP: p0, proj, calc: { dist: "Poisson reg + OT", params, proj, baseStr: base, mults: [], live: null },
      imp, novig, edge: modelP - novig, ev: evPerUnit(modelP, odds), b: odds > 0 ? odds / 100 : 100 / -odds, fair: probToAmerican(modelP), devigged: oppOdds != null,
    };
  };
  const push = (...xs) => xs.forEach((x) => x && entries.push(x));
  if (gl.h2h) push(
    mk(`${g.home} ML`, "Moneyline", "", "home", gl.h2h.home, gl.h2h.away, gp.home, projH, "P(home win incl. OT/SO)"),
    mk(`${g.away} ML`, "Moneyline", "", "away", gl.h2h.away, gl.h2h.home, gp.away, projA, "P(away win incl. OT/SO)"));
  if (totalPt != null) push(
    mk(`Total ${totalPt}`, "Total", totalPt, "over", gl.totals.over, gl.totals.under, gp.over, projH + projA, `P(total > ${totalPt})`),
    mk(`Total ${totalPt}`, "Total", totalPt, "under", gl.totals.under, gl.totals.over, gp.under, projH + projA, `P(total < ${totalPt})`));
  if (gl.spreads && gl.spreads.homePoint != null) {
    const hp = gl.spreads.homePoint, ap = gl.spreads.awayPoint;
    const pH = marginProb(d.lambdaH, d.lambdaA, hc, ac, fr, (m) => m + hp > 0);
    const pA = ap != null ? marginProb(d.lambdaH, d.lambdaA, hc, ac, fr, (m) => -m + ap > 0) : 1 - pH;
    push(
      mk(`${g.home} ${hp > 0 ? "+" : ""}${hp}`, "Puck Line", hp, "home", gl.spreads.home, gl.spreads.away, pH, projH - projA, `P(home margin > ${-hp})`),
      mk(`${g.away} ${ap > 0 ? "+" : ""}${ap}`, "Puck Line", ap, "away", gl.spreads.away, gl.spreads.home, pA, projA - projH, `P(away margin > ${-ap})`));
  }
  return entries;
}

/* ---------------- Trends ---------------- */
export function trendValueForGame(row, type) {
  const s = (row && row.s) || {};
  if (type === "Shots on Goal") return s.shotsTotal != null ? s.shotsTotal : null;
  if (type === "Goals") return s.goals != null ? s.goals : null;
  if (type === "Assists") return s.assists != null ? s.assists : null;
  if (type === "Points") return s.points != null ? s.points : (s.goals || 0) + (s.assists || 0);
  if (type === "Power Play Points") return (s.powerPlayGoals || 0) + (s.powerPlayAssists || 0);
  if (type === "Saves") return s.saves != null ? s.saves : null;
  return null;
}
function hitRate(games, type, line, side) {
  let hits = 0, n = 0;
  for (const row of games || []) { const v = trendValueForGame(row, type); if (v == null) continue; n++; if (side === "under" ? v < line : v > line) hits++; }
  return { n, hits, pct: n ? hits / n : null };
}
export function buildTrendCard(p, pid, type, games, g, isHome, boardEntriesForGame, recentN) {
  if (!games || !games.length) return null;
  if (type === "Saves") games = games.filter((r) => r.s && r.s.gameStarted);   // only games he started
  if (!games.length) return null;
  const oppAbbr = isHome ? g.away : g.home;
  const matches = boardEntriesForGame.filter((e) => String(e.playerId) === String(pid) && e.type === type);
  const chosen = matches.find((e) => e.side === "over") || matches.find((e) => e.side === "under") || null;
  let line, side, sourced, odds = null, boardEntryId = null;
  if (chosen) { line = parseFloat(chosen.line); side = chosen.side; sourced = "book"; odds = chosen.odds; boardEntryId = chosen.id; }
  else {
    const vals = games.slice(0, recentN).map((r) => trendValueForGame(r, type)).filter((v) => v != null);
    if (!vals.length) return null;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    let synth = Math.floor(avg) + 0.5; if (synth > avg) synth -= 1;
    line = Math.max(0.5, synth); side = "over"; sourced = "model";
  }
  const recentForm = hitRate(games.slice(0, recentN), type, line, side);
  const vsOpp = hitRate(games.filter((r) => r.opp === oppAbbr), type, line, side);
  const homeAway = hitRate(games.filter((r) => r.atVs === (isHome ? "vs" : "@")), type, line, side);
  if (!recentForm.n && !vsOpp.n && !homeAway.n) return null;
  return { id: `${g.pk}-${pid}-${type}-${line}-${side}`, gamePk: g.pk, game: `${g.away}@${g.home}`, playerId: pid, name: p.name, type, line, side, sourced, odds, boardEntryId, recentForm, vsOpp, homeAway, opp: oppAbbr, isHome };
}

/* ---------------- Player Analysis ---------------- */
export async function searchPlayers(q) {
  const res = await searchEspnPlayers("nhl", q);
  return res.map((p) => ({ ...p, teamAbbr: "", position: "" }));
}
export async function fetchPlayerAnalysisProfile(player, _season, date) {
  const season = espnSeasonFor(date);
  const bio = await jget(`${espnWeb(SPORT_PATH)}/athletes/${player.id}`).catch(() => null);
  const a = (bio && bio.athlete) || {};
  const pos = (a.position && a.position.abbreviation) || "";
  const teamId = a.team ? String(a.team.id) : null;
  if (teamId) playerTeam[String(player.id)] = { teamId, group: pos === "G" ? "G" : "S" };
  const logs = await fetchPlayerLogs(player.id, season);
  return {
    kind: pos === "G" ? "goalie" : "skater",
    player: { id: String(player.id), name: a.displayName || player.name, pos, group: pos === "G" ? "G" : pos === "D" ? "D" : "F", teamAbbr: (a.team && a.team.abbreviation) || "", teamName: (a.team && a.team.displayName) || player.teamName || "", teamId, age: a.age || null, jersey: a.jersey || "" },
    logs,
  };
}
export function findPlayerInSlate(playerId, games) {
  const id = String(playerId);
  for (const g of games || []) {
    if (g.homeGoalie && g.homeGoalie.id === id) return { game: g, kind: "goalie", side: "home", player: g.homeGoalie };
    if (g.awayGoalie && g.awayGoalie.id === id) return { game: g, kind: "goalie", side: "away", player: g.awayGoalie };
  }
  const t = playerTeam[id];
  if (!t) return null;
  const kind = t.group === "G" ? "goalie" : "skater";
  for (const g of games || []) {
    if (g.homeId === t.teamId) return { game: g, kind, side: "home", player: { id } };
    if (g.awayId === t.teamId) return { game: g, kind, side: "away", player: { id } };
  }
  return null;
}
