/* NBA sport adapter for the shared SportApp shell (same shape as the MLB and NHL adapters).
   The projection model is the existing NBA engine, moved unchanged except for the fixes noted in
   engine.ts / data.ts (3PM parsing, preseason rows, season-boundary logs, OT ties, DNP settling). */
import { ALL_PLAYER_PROPS, BOOKS, BOOK_LABELS, CATEGORY_ORDER, DEFAULT_LINE, HOME_COURT_MULT, LG_PACE, LG_PPG, ODDS_SPORT, ODDS_TESTING_LIMIT, SIGNAL_RULES, isLineType, isYesNoType, matchesQuery } from "./config";
import { actualFor, buildGameLineEntries, buildPlayerLog, buildTrendCard, computeRest, espnIdForTeamName, fetchDepthChart, fetchEventOdds, fetchGameSummary, fetchOddsEvents, fetchRoster, fetchSchedule, fetchSeasonRows, fetchStandings, fetchTeamSchedule, fetchTeamStats, matchCurrentOdds, matchEvent, nbaSeasonFor, parseEventOdds, parseGameOdds, playerTeam, searchPlayers as espnSearch, gradeLine, trendValueForGame } from "./data";
import { MODEL_VERSION, calculateInjuryAvailability, evalBet, gameProbs, posGroup, projectPlayer } from "./engine";
import { clamp, gradeBet } from "../../core/math";
import { jget, espnWeb } from "../../core/espn";
import { normName } from "../../core/odds";
import { createStorage } from "../../core/storage";
import { logSections } from "../../core/playerLog";
import { injuryBadge } from "../../core/slate";

// same keys as the old NBA page (nbaef_*), so existing bets and board log carry over
const storage = createStorage("nbaef", MODEL_VERSION, {});
const STAT_ORDER = CATEGORY_ORDER;
const TREND_PROPS = ALL_PLAYER_PROPS;

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k]).catch(() => {}); } }));
}
const cache = { standings: {}, sched: {} };
async function standingsFor(yr) { if (!cache.standings[yr]) cache.standings[yr] = fetchStandings(yr).catch(() => ({})); return cache.standings[yr]; }
async function schedFor(teamId, yr) { const k = `${teamId}-${yr}`; if (!cache.sched[k]) cache.sched[k] = fetchTeamSchedule(teamId, yr).catch(() => []); return cache.sched[k]; }

/* the ~10 rotation players shown first on the Slate: depth-chart starters + first bench (moved from the old page) */
function featuredFromRosterAndDepth(roster, depth) {
  const byPos = {};
  for (const p of roster) { const g = posGroup(p.pos); (byPos[g] = byPos[g] || []).push(p); }
  const rankOf = (p) => (depth[p.id] ? depth[p.id].rank : 99);
  const pick = (g, n) => {
    const sorted = (byPos[g] || []).slice().sort((a, b) => rankOf(a) - rankOf(b)).slice(0, n);
    const topConfirmed = sorted.length === 0 || rankOf(sorted[0]) < 99;
    return sorted.map((p, i) => ({ ...p, depthRank: rankOf(p), depthConfirmed: i === 0 ? topConfirmed : true, isStarter: rankOf(p) === 1 }));
  };
  return [...pick("G", 4), ...pick("F", 4), ...pick("C", 2)];
}

/* team points per game, shrunk toward last season's rate (then league) so week 1 isn't a 2-game sample */
function teamPpg(cur, prior) {
  const K = 10;
  const priorFor = prior && prior.ppgFor ? prior.ppgFor : LG_PPG, priorAg = prior && prior.ppgAgainst ? prior.ppgAgainst : LG_PPG;
  const g = cur && cur.g && (cur.pf != null) ? (cur.pf ? cur.g : 0) : 0;
  return {
    ppgFor: g ? (cur.pf + K * priorFor) / (g + K) : priorFor,
    ppgAgainst: g ? (cur.pa + K * priorAg) / (g + K) : priorAg,
    g,
  };
}

async function loadGameDetail(g, { date }) {
  const year = nbaSeasonFor(date);
  const [stCur, stPrior] = await Promise.all([standingsFor(year), standingsFor(year - 1)]);
  const [rosterH, rosterA, depthH, depthA, teamStatsH, teamStatsA, schedH, schedA] = await Promise.all([
    fetchRoster(g.homeId).catch(() => []), fetchRoster(g.awayId).catch(() => []),
    fetchDepthChart(g.homeId, year).catch(() => ({})), fetchDepthChart(g.awayId, year).catch(() => ({})),
    fetchTeamStats(g.homeId).catch(() => ({ off: {}, def: {} })), fetchTeamStats(g.awayId).catch(() => ({ off: {}, def: {} })),
    schedFor(g.homeId, year), schedFor(g.awayId, year),
  ]);
  const withDepth = (roster, depth) => roster.map((p) => ({ ...p, depthRank: depth[p.id] ? depth[p.id].rank : 99, isStarter: !!(depth[p.id] && depth[p.id].rank === 1) }));
  const rH = withDepth(rosterH, depthH), rA = withDepth(rosterA, depthA);
  const featH = featuredFromRosterAndDepth(rosterH, depthH), featA = featuredFromRosterAndDepth(rosterA, depthA);
  const logs = {}, gamelogs = {}, priorGamelogs = {};
  const everyone = [...rH.map((p) => ({ p, teamId: g.homeId })), ...rA.map((p) => ({ p, teamId: g.awayId }))];
  await pool(everyone, 8, async ({ p, teamId }) => {
    playerTeam[p.id] = teamId;
    const [cur, prior] = await Promise.all([fetchSeasonRows(p.id, year), fetchSeasonRows(p.id, year - 1)]);
    logs[p.id] = buildPlayerLog(cur, prior);
    gamelogs[p.id] = cur; priorGamelogs[p.id] = prior;
  });
  const sH = teamPpg(stCur[g.homeId], stPrior[g.homeId]), sA = teamPpg(stCur[g.awayId], stPrior[g.awayId]);
  const lambdaH = +clamp(LG_PPG * clamp(sH.ppgFor / LG_PPG, 0.75, 1.35) * clamp(sA.ppgAgainst / LG_PPG, 0.75, 1.35) * HOME_COURT_MULT.home, 85, 145).toFixed(2);
  const lambdaA = +clamp(LG_PPG * clamp(sA.ppgFor / LG_PPG, 0.75, 1.35) * clamp(sH.ppgAgainst / LG_PPG, 0.75, 1.35) * HOME_COURT_MULT.away, 85, 145).toFixed(2);
  const gameDate = g.gameTimeIso ? new Date(g.gameTimeIso) : new Date(`${date}T19:00:00`);
  return {
    ready: true, loading: false,
    home: { roster: rH, depth: depthH, featured: featH, teamStats: teamStatsH, standings: sH, rest: computeRest(schedH, gameDate) },
    away: { roster: rA, depth: depthA, featured: featA, teamStats: teamStatsA, standings: sA, rest: computeRest(schedA, gameDate) },
    logs, gamelogs, priorGamelogs, lambdaH, lambdaA,
  };
}

/* one player -> the ctx object projectPlayer consumes (moved from the old page's playerCtx) */
function playerCtx(d, side, p, logOverride) {
  const isHome = side === "home";
  const teamData = isHome ? d.home : d.away;
  const gl = logOverride || d.logs[p.id];
  const missingUsageShare = (teamData.roster || []).filter((tp) => tp.id !== p.id && (teamData.featured || []).some((f) => f.id === tp.id && f.isStarter) && calculateInjuryAvailability(tp.injuryStatus) === 0).length * 0.08;
  return {
    kind: "player", pos: p.pos, isStarter: !!p.isStarter,
    season: gl ? gl.season : null, recent: gl ? gl.recent : null, games: gl ? gl.games : null,
    injuryStatus: p.injuryStatus, depthRank: p.depthRank,
    impliedTeamPts: isHome ? d.lambdaH : d.lambdaA, projSpreadAbs: Math.abs(d.lambdaH - d.lambdaA),
    teamPace: null, oppPace: null, lgPace: LG_PACE,
    oppDRTG: null, lgDRTG: null, oppRebRateAllowed: null, lgRebRateAllowed: null, oppAstAllowed: null, lgAstAllowed: null,
    opp3ptPctAllowed: null, lg3ptPctAllowed: null, oppTovForced: null, lgTovForced: null, oppFgaRimAllowed: null, lgFgaRimAllowed: null,
    missingUsageShare,
    daysRest: teamData.rest.daysRest, backToBack: teamData.rest.backToBack, crossCountryTravel: false,
  };
}
const sideOfPlayer = (d, pid) => (d.home.roster.some((p) => p.id === pid) ? "home" : d.away.roster.some((p) => p.id === pid) ? "away" : null);
const rosterEntry = (d, pid) => d.home.roster.find((p) => p.id === pid) || d.away.roster.find((p) => p.id === pid) || null;

function buildPropEntries(g, d, rows, book) {
  const byName = {};
  for (const side of ["home", "away"]) for (const p of (side === "home" ? d.home : d.away).roster) byName[normName(p.name)] = { p, side };
  const entries = [];
  for (const row of rows) {
    const f = byName[normName(row.player)];
    if (!f) continue;
    const ctx = playerCtx(d, f.side, f.p);
    const pre = projectPlayer(ctx, row.type, parseFloat(row.point));
    for (const side of ["over", "under"]) {
      const odds = side === "over" ? row.over : row.under;
      if (odds == null) continue;
      const bet = { gamePk: g.pk, game: `${g.away}@${g.home}`, gameTimeIso: g.gameTimeIso || null, playerId: f.p.id, name: f.p.name, type: row.type, line: String(row.point), side, odds, overOdds: row.over, underOdds: row.under, ctx, book: row.srcBook || book };
      entries.push({ id: `${g.pk}-${f.p.id}-${row.type}-${row.point}-${side}`, ...bet, ...evalBet(bet, pre) });
    }
  }
  return entries;
}

function trendSubjects(g, d) {
  const out = [];
  for (const side of ["home", "away"]) {
    for (const p of (side === "home" ? d.home : d.away).roster) {
      const lg = d.logs[p.id];
      if (!lg || !lg.season.g || lg.season.min / lg.season.g < 12) continue;   // rotation players only
      out.push({ player: p, pid: p.id, props: ALL_PLAYER_PROPS, isHome: side === "home" });
    }
  }
  return out;
}

async function fetchPlayerAnalysisProfile(player, _season, date) {
  const year = nbaSeasonFor(date);
  const bio = await jget(`${espnWeb("basketball/nba")}/athletes/${player.id}`).catch(() => null);
  const a = (bio && bio.athlete) || {};
  const teamId = a.team ? Number(a.team.id) : player.teamId || null;
  if (teamId) playerTeam[String(player.id)] = teamId;
  const [cur, prior] = await Promise.all([fetchSeasonRows(player.id, year), fetchSeasonRows(player.id, year - 1)]);
  return {
    kind: "player",
    player: { id: String(player.id), name: a.displayName || player.name, pos: (a.position && a.position.abbreviation) || "", jersey: a.jersey || "", teamId, teamAbbr: (a.team && a.team.abbreviation) || "", teamName: (a.team && a.team.displayName) || player.teamName || "" },
    logs: { cur, prior }, log: buildPlayerLog(cur, prior),
  };
}
function findPlayerInSlate(playerId, games) {
  const t = playerTeam[String(playerId)];
  if (t == null) return null;
  for (const g of games || []) {
    if (String(g.homeId) === String(t)) return { game: g, kind: "player", side: "home", player: { id: String(playerId) } };
    if (String(g.awayId) === String(t)) return { game: g, kind: "player", side: "away", player: { id: String(playerId) } };
  }
  return null;
}
function analysisCtx(d, spot, profile) {
  const pid = String(profile.player.id);
  const side = sideOfPlayer(d, pid) || spot.side;
  const p = rosterEntry(d, pid) || { id: pid, name: profile.player.name, pos: profile.player.pos, injuryStatus: null, isStarter: false, depthRank: 99 };
  return playerCtx(d, side, p, d.logs[pid] || profile.log);
}


/* ---- Slate: what the shared game panel shows for a basketball game ---- */
const game = {
  subtitle: (g) => g.venue || "TBD",
  finalSuffix: (g) => (g.period && g.period > 4 ? `/${g.period === 5 ? "OT" : `${g.period - 4}OT`}` : ""),
  liveLabel: (g) => `${g.period > 4 ? "OT" : `Q${g.period}`} ${g.clock || ""}`,
};
const perG = (log, k) => (log && log.season && log.season.g ? log.season[k] / log.season.g : null);
const f1 = (x) => (x == null || isNaN(x) ? "—" : Number(x).toFixed(1));
function nbaRow(d, p, i) {
  const lg = d.logs[p.id];
  return {
    id: p.id, idx: i + 1, tag: `${p.pos}${p.isStarter ? "*" : ""}`,
    tagWarn: p.depthConfirmed === false ? "No confirmed depth chart for this team, so the order is the roster listing, not verified starters" : null,
    name: p.name, badges: [injuryBadge(p.injuryStatus)].filter(Boolean),
    stat: `${f1(perG(lg, "min"))} · ${f1(perG(lg, "pts"))} · ${f1(perG(lg, "reb"))} · ${f1(perG(lg, "ast"))} · ${f1(perG(lg, "fg3m"))}`,
    player: { id: p.id, name: p.name }, draft: { kind: "player", id: p.id, name: p.name },
  };
}
function teamColumn(title, team, d) {
  const featuredIds = new Set((team.featured || []).map((p) => p.id));
  const rest = (team.roster || []).filter((p) => !featuredIds.has(p.id)).sort((a, b) => (perG(d.logs[b.id], "min") || 0) - (perG(d.logs[a.id], "min") || 0));
  const n = (team.featured || []).length;
  return { title, legend: "MIN · PTS · REB · AST · 3PM", empty: "— roster unavailable —", rows: (team.featured || []).map((p, i) => nbaRow(d, p, i)), moreRows: rest.map((p, i) => nbaRow(d, p, n + i)) };
}
function slateView(g, d) {
  const gp = gameProbs(d.lambdaH, d.lambdaA);
  const rest = (r) => (r.backToBack ? "B2B" : `${r.daysRest}d`);
  const ppg = (s) => (s && s.ppgFor ? `${f1(s.ppgFor)}/${f1(s.ppgAgainst)}` : null);
  return {
    env: [
      { label: `${g.away} REST`, v: rest(d.away.rest), hot: d.away.rest.backToBack },
      { label: `${g.home} REST`, v: rest(d.home.rest), hot: d.home.rest.backToBack },
      ...(ppg(d.away.standings) ? [{ label: `${g.away} PPG`, v: ppg(d.away.standings) }] : []),
      ...(ppg(d.home.standings) ? [{ label: `${g.home} PPG`, v: ppg(d.home.standings) }] : []),
    ],
    gameLine: { lambdaA: d.lambdaA, lambdaH: d.lambdaH, home: gp.home, away: gp.away, total: gp.totalLambda, note: "team scoring environment (points for / against per game, shrunk to league) × home court. Win % splits regulation ties evenly for OT." },
    sections: [[teamColumn(`${g.away} (away)`, d.away, d), teamColumn(`${g.home} (home)`, d.home, d)]],
  };
}


/* ---- Player Analysis data (rendered by the shared core/analysis.tsx) ---- */
const NBA_ABBR = { "Points": "PTS", "Rebounds": "REB", "Assists": "AST", "Three-Pointers Made": "3PM", "Pts+Reb+Ast": "PRA", "Steals": "STL", "Blocks": "BLK", "Turnovers": "TOV" };
const NBA_FORM_TYPES = ["Points", "Rebounds", "Assists", "Three-Pointers Made", "Pts+Reb+Ast"];
function playerView({ profile, spot, detail }) {
  const p = profile.player;
  const log = profile.log, s = log.season;
  const pg = (k) => (s && s.g ? (s[k] / s.g).toFixed(1) : "—");
  const ready = spot && detail && detail.ready;
  const ctx = ready ? analysisCtx(detail, spot, profile) : null;
  const roster = ready ? rosterEntry(detail, String(p.id)) : null;
  const team = spot ? (spot.side === "home" ? detail && detail.home : detail && detail.away) : null;
  const rows = [...(profile.logs.cur || []), ...(profile.logs.prior || [])].filter((r) => r.min > 0);
  const curCount = (profile.logs.cur || []).filter((r) => r.min > 0).length;
  return {
    headshot: `https://a.espncdn.com/i/headshots/nba/players/full/${p.id}.png`,
    subtitle: `${p.teamAbbr || "FA"} · ${p.pos || "—"}${p.jersey ? ` · #${p.jersey}` : ""} · ${log.curGames} gm this season + ${log.priorGames} last season in the model base`,
    metrics: [["PTS/G", pg("pts")], ["REB/G", pg("reb")], ["AST/G", pg("ast")], ["MIN/G", pg("min")]],
    cards: [
      !spot ? { title: "SLATE MATCHUP", empty: "Not found on the selected date." } : {
        title: "SLATE MATCHUP", headline: { text: `${spot.game.away} @ ${spot.game.home}` },
        note: `${spot.side === "home" ? spot.game.home : spot.game.away} · vs ${spot.side === "home" ? spot.game.away : spot.game.home}`,
        lines: ready ? [
          `model score ${spot.game.away} ${detail.lambdaA.toFixed(1)} – ${detail.lambdaH.toFixed(1)} ${spot.game.home}`,
          `rest ${team.rest.backToBack ? "back-to-back" : `${team.rest.daysRest}d`}`,
          roster && roster.injuryStatus ? { text: `status ${roster.injuryStatus.replace(/_/g, " ")}`, tone: "warn" } : { text: "no injury designation", tone: "muted" },
        ] : [{ text: "loading detail…", tone: "muted" }],
      },
      { title: "SEASON BASELINE", empty: s && s.g ? null : "No games in the model base yet.", grid: [["G", s.g ? Math.round(s.g) : 0], ["MIN", pg("min")], ["PTS", pg("pts"), "sky"], ["REB", pg("reb"), "sky"], ["AST", pg("ast"), "sky"], ["3PM", pg("fg3m"), "sky"], ["STL", pg("stl")], ["BLK", pg("blk")], ["TOV", pg("tov")], ["FGM", pg("fgm")]] },
      !ctx ? { title: "MODEL CONTEXT", empty: spot ? "loading matchup context…" : "Available when the player is on the selected slate." } : {
        title: "MODEL CONTEXT", note: "inputs the projection uses for this game",
        grid: [["implied pts", ctx.impliedTeamPts != null ? ctx.impliedTeamPts.toFixed(1) : "—", "sky"], ["proj spread", ctx.projSpreadAbs != null ? ctx.projSpreadAbs.toFixed(1) : "—"],
          ["starter", ctx.isStarter ? "yes" : "no"], ["depth", ctx.depthRank && ctx.depthRank < 90 ? `#${ctx.depthRank}` : "—"],
          ["days rest", ctx.daysRest ?? "—"], ["B2B", ctx.backToBack ? "yes" : "no", ctx.backToBack ? "warn" : null],
          ["usage freed", ctx.missingUsageShare ? `${Math.round(ctx.missingUsageShare * 100)}%` : "0%"], ["L10 games", ctx.recent && ctx.recent.games != null ? ctx.recent.games : "—"]],
      },
    ],
    ...logSections({ rows, curCount, types: NBA_FORM_TYPES, valueFor: trendValueForGame, abbr: (t) => NBA_ABBR[t] || t, defaultLines: DEFAULT_LINE, title: "Scoring Form" }),
  };
}

/* settlement */
function gradeLineResult(type, side, line, res) { return gradeLine(type, side, line, res.homeScore, res.awayScore); }
function gradeProp(b, res, dnpActual) {
  const ps = res.players[b.playerId] || res.players[String(b.playerId)];
  if (!ps) return { status: "void", actual: dnpActual };   // DNP / inactive -> no action
  const actual = actualFor(b.type, ps);
  if (actual == null) return null;
  const st = isYesNoType(b.type) ? ((actual === 1) === (b.side === "over") ? "won" : "lost") : gradeBet(b.side, parseFloat(String(b.line)), actual);
  return st == null ? null : { status: st, actual };
}
function draftCtx(d, g, kind, pid) {
  if (!d || !d.ready) return null;
  const side = sideOfPlayer(d, pid);
  return side ? playerCtx(d, side, rosterEntry(d, pid)) : null;
}

const NBA = {
  id: "nba",
  meta: {
    title: "NBA", emoji: "🏀", league: "NBA",
    statsSource: "ESPN", searchPlaceholder: "Jayson Tatum",
    csvPrefix: "nba-edge-finder", boardLogCsvPrefix: "nba-board-log", backupApp: "nba-edge-finder",
    overrideTitle: "Per-market book overrides: pull one market from a different book when your main book doesn't carry it",
    diagnosticsType: "Double-Double", diagnosticsMarketKey: "player_double_double",
    draftKindLabel: () => "PLAYER",
    searchResultLine: (p) => `${p.teamName || "FA"}`,
  },
  config: { ALL_PROPS: ALL_PLAYER_PROPS, BOOKS, BOOK_LABELS, CATEGORY_ORDER, DEFAULT_LINE, ODDS_TESTING_LIMIT, isLineType, isYesNoType, matchesQuery, STAT_ORDER, TREND_PROPS, SIGNAL_RULES },
  storage,
  api: {
    fetchSchedule, fetchOddsEvents: () => fetchOddsEvents(ODDS_SPORT), fetchEventOdds: (id, book) => fetchEventOdds(ODDS_SPORT, id, book), matchEvent,
    oddsDebug: (data, bookKey) => {
      const bms = data.bookmakers || []; const bm = bms.find((b) => b.key === bookKey);
      const mk = bm && (bm.markets || []).find((m) => m.key === "player_double_double");
      return { books: bms.map((b) => b.key), usedBook: bm ? bm.key : null, rawKeys: bm ? (bm.markets || []).map((m) => m.key) : [], hasHR: !!mk, hrSample: mk && mk.outcomes ? mk.outcomes[0] : null };
    },
    parseEventOdds, parseGameOdds, matchCurrentOdds, buildGameLineEntries, fetchGameResult: fetchGameSummary,
    searchPlayers: async (q) => (await espnSearch(q)).map((p) => ({ ...p, teamId: p.teamId || espnIdForTeamName(p.teamName) })),
    fetchPlayerAnalysisProfile, findPlayerInSlate,
    buildTrendCard: (p, pid, type, games, g, isHome, entries, n) => buildTrendCard({ ...p, id: pid }, type, { games }, g, isHome, entries, n),
  },
  model: { projectProp: projectPlayer },
  loadGameDetail, buildPropEntries, analysisCtx, trendSubjects,
  propsForKind: () => ALL_PLAYER_PROPS,
  gradeLineResult,
  gradeTrackedProp: (b, res) => gradeProp(b, res, "DNP"),
  gradeLogProp: (e, res) => gradeProp(e, res, null),
  draftCtx,
  draftDefaults: () => ({ type: "Points", line: DEFAULT_LINE.Points || "19.5" }),
  game, slateView, playerView,
};
export default NBA;
