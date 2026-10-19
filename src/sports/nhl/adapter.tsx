/* NHL sport adapter for the shared SportApp shell (same shape as sports/mlb/adapter.tsx). */
import { ALL_PROPS, BOOKS, BOOK_LABELS, CATEGORY_ORDER, DEFAULT_LINE, GOALIE_PROPS, ODDS_TESTING_LIMIT, SKATER_PROPS, STAT_ORDER, TREND_PROPS, isLineType, matchesQuery } from "./config";
import { buildGameLineEntries, buildTrendCard, espnSeasonFor, fetchEventOdds, fetchGameResult, fetchOddsEvents, fetchPlayerAnalysisProfile, fetchPlayerLogs, fetchRoster, fetchSchedule, fetchTeamStats, findPlayerInSlate, matchCurrentOdds, matchEvent, oddsDebug, parseEventOdds, parseGameOdds, playerTeam, searchPlayers, statFor } from "./data";
import { MODEL_VERSION, evalBet, fractionRemaining, gameLambdas, goalieRates, projectProp, skaterRates, teamRates } from "./engine";
import { gradeBet } from "../../core/math";
import { normName } from "../../core/odds";
import { createStorage } from "../../core/storage";
import { BoardRow, Chip, GameSubtitle, MyBetRow, PlayerAnalysisIntro, PlayerProfilePanel, ScoreLine, SlateDetail, TrendCard, getDeltaSignal } from "./ui";

const storage = createStorage("nhlef", MODEL_VERSION, {});

/* run async jobs with a concurrency cap (ESPN is fast, but ~50 game logs per game is a lot at once) */
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k]).catch(() => {}); } });
  await Promise.all(workers);
}

/* ---- context builders ---- */
function liveSnap(d, pid) { return d.live ? { fractionRemaining: d.live.fractionRemaining, totals: (d.live.players && d.live.players[pid]) || {} } : null; }
function skaterCtx(d, s) {
  const home = s.side === "home";
  return { kind: "skater", pos: s.group, rates: s.rates, injury: s.injury, teamLambda: home ? d.lambdaH : d.lambdaA, teamShots: home ? d.shotsH : d.shotsA, live: liveSnap(d, s.id) };
}
function goalieCtx(d, gk) {
  const home = gk.side === "home";
  return { kind: "goalie", rates: gk.rates, starter: gk.starter, expShotsAgainst: home ? d.shotsA : d.shotsH, live: liveSnap(d, gk.id) };
}

/* ---- everything the model needs for one game ---- */
async function loadGameDetail(g, { date }) {
  const season = espnSeasonFor(date);
  const [homeRoster, awayRoster, homeT, awayT, liveRes] = await Promise.all([
    fetchRoster(g.homeId).catch(() => []), fetchRoster(g.awayId).catch(() => []),
    fetchTeamStats(g.homeId).catch(() => null), fetchTeamStats(g.awayId).catch(() => null),
    g.status === "LIVE" ? fetchGameResult(g.pk) : Promise.resolve(null),
  ]);
  const roster = [...homeRoster.map((p) => ({ ...p, side: "home", teamId: g.homeId })), ...awayRoster.map((p) => ({ ...p, side: "away", teamId: g.awayId }))];
  const skaters = {}, goalies = {}, gamelogs = {}, priorGamelogs = {};
  await pool(roster, 8, async (p) => {
    playerTeam[p.id] = { teamId: p.teamId, group: p.group === "G" ? "G" : "S" };
    const { cur, prior } = await fetchPlayerLogs(p.id, season);
    gamelogs[p.id] = cur; priorGamelogs[p.id] = prior;
    const curReg = cur.filter((r) => !r.postseason);
    if (p.group === "G") {
      const probable = p.side === "home" ? g.homeGoalie : g.awayGoalie;
      goalies[p.id] = { ...p, rates: goalieRates(cur, prior), starter: !!(probable && probable.id === p.id), starterStatus: probable && probable.id === p.id ? String(probable.status || "").toUpperCase() : null };
    } else {
      const season_ = { g: curReg.reduce((a, r) => a + (r.s.goals || 0), 0), a: curReg.reduce((a, r) => a + (r.s.assists || 0), 0) };
      skaters[p.id] = { ...p, gp: curReg.length, season: season_, rates: skaterRates(cur, prior, p.group) };
    }
  });
  const starterOf = (side) => Object.values(goalies).find((x) => x.side === side && x.starter) || null;
  const lam = gameLambdas(homeT, awayT, starterOf("home") && starterOf("home").rates, starterOf("away") && starterOf("away").rates);
  const live = liveRes ? { fractionRemaining: fractionRemaining(liveRes.period, liveRes.clock), players: liveRes.players } : null;
  return {
    ready: true, loading: false, skaters, goalies, gamelogs, priorGamelogs,
    teams: { home: teamRates(homeT), away: teamRates(awayT), homeRaw: homeT, awayRaw: awayT },
    lambdaH: lam.lambdaH, lambdaA: lam.lambdaA, shotsH: lam.shotsH, shotsA: lam.shotsA, live,
  };
}

/* ---- odds rows -> priced board entries ---- */
function buildPropEntries(g, d, rows, book) {
  const skByName = {}, gkByName = {};
  for (const id in d.skaters) skByName[normName(d.skaters[id].name)] = d.skaters[id];
  for (const id in d.goalies) gkByName[normName(d.goalies[id].name)] = d.goalies[id];
  const entries = [];
  for (const row of rows) {
    const isG = row.type === "Saves";
    const pl = (isG ? gkByName : skByName)[normName(row.player)];
    if (!pl) continue;
    const ctx = isG ? goalieCtx(d, pl) : skaterCtx(d, pl);
    const pre = projectProp(ctx, row.type, parseFloat(row.point));
    for (const side of ["over", "under"]) {
      const odds = side === "over" ? row.over : row.under;
      if (odds == null) continue;
      const bet = { gamePk: g.pk, game: `${g.away}@${g.home}`, gameTimeIso: g.gameTimeIso || null, playerId: pl.id, name: pl.name, type: row.type, line: String(row.point), side, odds, overOdds: row.over, underOdds: row.under, ctx, book: row.srcBook || book };
      entries.push({ id: `${g.pk}-${pl.id}-${row.type}-${row.point}-${side}`, ...bet, ...evalBet(bet, pre) });
    }
  }
  return entries;
}

function analysisCtx(d, spot, profile) {
  const pid = String(profile.player.id);
  if (d.goalies && d.goalies[pid]) return goalieCtx(d, d.goalies[pid]);
  if (d.skaters && d.skaters[pid]) return skaterCtx(d, d.skaters[pid]);
  return null;
}
function trendSubjects(g, d) {
  const out = [];
  for (const id in d.skaters) { const s = d.skaters[id]; if (s.gp > 0 || s.rates.priorGames > 0) out.push({ player: s, pid: id, props: SKATER_PROPS, isHome: s.side === "home" }); }
  for (const id in d.goalies) { const gk = d.goalies[id]; if (gk.starter) out.push({ player: gk, pid: id, props: GOALIE_PROPS, isHome: gk.side === "home" }); }
  return out;
}

/* ---- settlement ---- */
function gradeLineResult(type, side, line, res) {
  const h = res.homeScore, a = res.awayScore;
  if (h == null || a == null) return { status: null, actual: null };
  const actual = `${a}-${h}`;
  if (type === "Moneyline") return { status: (side === "home" ? h > a : a > h) ? "won" : "lost", actual };
  if (type === "Total") { const t = h + a; return { status: t === line ? "push" : (side === "over" ? t > line : t < line) ? "won" : "lost", actual: t }; }
  if (type === "Puck Line") { const m = side === "home" ? h - a : a - h; return { status: m + line === 0 ? "push" : m + line > 0 ? "won" : "lost", actual }; }
  return { status: null, actual: null };
}
function gradeProp(b, res, dnpActual) {
  const p = res.players[b.playerId] || res.players[String(b.playerId)];
  if (!p || !p.played) return { status: "void", actual: dnpActual };
  const actual = statFor(b.type, p);
  const st = gradeBet(b.side, parseFloat(String(b.line)), actual);
  return st == null ? null : { status: st, actual };
}

/* ---- manual draft ---- */
function draftCtx(d, g, kind, pid) {
  if (!d || !d.ready) return null;
  if (kind === "goalie" && d.goalies[pid]) return goalieCtx(d, d.goalies[pid]);
  if (kind === "skater" && d.skaters[pid]) return skaterCtx(d, d.skaters[pid]);
  return null;
}

const NHL = {
  id: "nhl",
  meta: {
    title: "NHL", emoji: "🏒", tagline: "live odds · de-vigged edge · Poisson props + goalie model", league: "NHL",
    statsSource: "ESPN", searchPlaceholder: "Connor McDavid",
    analysisHint: "NHL-wide profile lookup. If the player's team is on the selected slate, this tab adds game context, model projections, and any pulled",
    csvPrefix: "nhl-edge-finder", boardLogCsvPrefix: "nhl-board-log", backupApp: "nhl-edge-finder",
    overrideTitle: "Per-market book overrides: pull one market (e.g. Saves) from a different book than the rest of the board",
    diagnosticsType: "Saves", diagnosticsMarketKey: "player_total_saves",
    draftKindLabel: (kind) => (kind === "goalie" ? "GOALIE" : "SKATER"),
    searchResultLine: (p) => `${p.teamName || "FA"}`,
  },
  config: { ALL_PROPS, BOOKS, BOOK_LABELS, CATEGORY_ORDER, DEFAULT_LINE, ODDS_TESTING_LIMIT, isLineType, matchesQuery, STAT_ORDER, TREND_PROPS },
  storage,
  api: { fetchSchedule, fetchOddsEvents, fetchEventOdds, matchEvent, oddsDebug, parseEventOdds, parseGameOdds, matchCurrentOdds, buildGameLineEntries, fetchGameResult, searchPlayers, fetchPlayerAnalysisProfile, findPlayerInSlate, buildTrendCard, getDeltaSignal },
  model: { projectProp },
  loadGameDetail, buildPropEntries, analysisCtx, trendSubjects,
  propsForKind: (kind) => (kind === "goalie" ? GOALIE_PROPS : SKATER_PROPS),
  gradeLineResult,
  gradeTrackedProp: (b, res) => gradeProp(b, res, "DNP"),
  gradeLogProp: (e, res) => gradeProp(e, res, null),
  draftCtx,
  draftDefaults: (kind) => (kind === "goalie" ? { type: "Saves", line: DEFAULT_LINE.Saves } : { type: "Shots on Goal", line: DEFAULT_LINE["Shots on Goal"] }),
  ui: { Chip, ScoreLine, GameSubtitle, SlateDetail, BoardRow, MyBetRow, TrendCard, PlayerAnalysisIntro, PlayerProfilePanel },
};
export default NHL;
