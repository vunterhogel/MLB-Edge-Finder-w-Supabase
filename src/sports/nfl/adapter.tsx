/* NFL sport adapter for the shared SportApp shell (same shape as the MLB / NBA / NHL adapters).
   The projection model is the old NFL page's engine, moved without changing a number (nfl-v2).
   NFL runs by week, not date, so this adapter also supplies the shell's optional week navigator:
   the slate key is "<year>-<seasonType>-<week>" (e.g. "2026-2-8"), the same key the old page used for
   tracked bets and board-log ids, so existing data lines up. */
import { ALL_PLAYER_PROPS, BOOKS, BOOK_LABELS, CATEGORY_ORDER, DEFAULT_LINE, HOME_FIELD_MULT, LG_PPG, ODDS_SPORT, ODDS_SPORT_PRESEASON, ODDS_TESTING_LIMIT, STADIUMS, isLineType, matchesQuery } from "./config";
import { GAMELOG_ROWS, ESPN_WEB, TREND_PROPS, actualFor, buildGameLineEntries, buildTrendCard, currentWeekGuess, fetchAthleteGamelog, fetchCurrentWeek, fetchDepthChart, fetchEventOdds, fetchGameSummary, fetchLongCmpForEventTrySeasons, fetchOddsEvents, fetchRoster, fetchSchedule, fetchStandings, fetchTeamStats, fetchWeather, gradeLine, jget, matchCurrentOdds, matchEvent, normName, parseEventOdds, parseGameOdds, searchPlayers, weekYear } from "./data";
import { EXPERIMENTAL_TYPES, evalBet, projectProp } from "./engine";
import { analysisCtx, featuredFromRosterAndDepth, playerCtx, posKey, propsForKind, propsForPos, rosterSpot } from "./context";
import { MODEL_VERSION, storage } from "./storage";
import { clamp, gradeBet } from "../../core/math";
import { BoardRow, Chip, GameSubtitle, MyBetRow, PlayerAnalysisIntro, PlayerProfilePanel, ScoreLine, SlateDetail, TrendCard, WeekNav, getDeltaSignal } from "./ui";

/* ---------------- week slate ---------------- */
const SEASON_TYPE_SHORT = { 1: "Pre", 2: "", 3: "Post" };
export function parseWeekKey(k) {
  const [y, st, w] = String(k || "").split("-").map(Number);
  return { year: y || new Date().getFullYear(), seasonType: st || 2, week: w || 1 };
}
export const weekKeyOf = ({ year, seasonType, week }) => `${year}-${seasonType}-${week}`;
const slate = {
  unit: "week",
  initial: () => weekKeyOf(currentWeekGuess()),
  resolveCurrent: async () => weekKeyOf(await fetchCurrentWeek()),
  season: (k) => String(parseWeekKey(k).year),
  order: (k) => { const { year, seasonType, week } = parseWeekKey(k); return year * 1000 + seasonType * 100 + week; },
  label: (k) => { const { year, seasonType, week } = parseWeekKey(k); return `${year} ${SEASON_TYPE_SHORT[seasonType] ? `${SEASON_TYPE_SHORT[seasonType]} ` : ""}Wk ${week}`; },
  Nav: WeekNav,
};

/* the odds feed splits preseason into its own sport key; follow whichever week is loaded */
let currentSportKey = ODDS_SPORT;
async function fetchScheduleForKey(k) {
  const { year, seasonType, week } = parseWeekKey(k);
  currentSportKey = seasonType === 1 ? ODDS_SPORT_PRESEASON : ODDS_SPORT;
  return fetchSchedule(seasonType, week, year);
}

/* ---------------- per-game detail (moved from the old page's loadDetail) ---------------- */
// player id -> ESPN team id, so Player Analysis can find a searched player's game on the slate
const playerTeam = {};
const standingsCache = {};
function standingsFor(yr) { if (!standingsCache[yr]) standingsCache[yr] = fetchStandings(yr).catch(() => ({})); return standingsCache[yr]; }

async function loadGameDetail(g, { date }) {
  const year = parseWeekKey(date).year;
  const standings = await standingsFor(year);
  const stadium = STADIUMS[g.homeId] || { lat: null, lon: null, dome: true };
  const [rosterH, rosterA, depthH, depthA, teamStatsH, teamStatsA] = await Promise.all([
    fetchRoster(g.homeId).catch(() => []), fetchRoster(g.awayId).catch(() => []),
    fetchDepthChart(g.homeId, year).catch(() => ({})), fetchDepthChart(g.awayId, year).catch(() => ({})),
    fetchTeamStats(g.homeId).catch(() => ({ off: {}, def: {} })), fetchTeamStats(g.awayId).catch(() => ({ off: {}, def: {} })),
  ]);
  let wx = null;
  if (!stadium.dome && stadium.lat) wx = await fetchWeather(stadium.lat, stadium.lon).catch(() => null);
  const featH = featuredFromRosterAndDepth(rosterH, depthH);
  const featA = featuredFromRosterAndDepth(rosterA, depthA);
  for (const p of rosterH) playerTeam[String(p.id)] = g.homeId;
  for (const p of rosterA) playerTeam[String(p.id)] = g.awayId;
  playerTeam[`dst-${g.homeId}`] = g.homeId; playerTeam[`dst-${g.awayId}`] = g.awayId;
  // logs: the aggregated {season, recent, games} objects the engine reads; gamelogs: the per-game rows
  // the shell's Trends tab reads (current season first, then the prior-season fallback)
  const logs = {}, priorLogs = {}, gamelogs = {}, priorGamelogs = {};
  await Promise.allSettled([...featH, ...featA].map((p) =>
    fetchAthleteGamelog(p.id, 4).then(async (gl) => {
      logs[p.id] = gl;
      gamelogs[p.id] = (gl && gl.games) || [];
      // thin or empty current-season sample -> last season's complete log is the shrinkage prior
      if (!gl || !gl.games || gl.games.length < GAMELOG_ROWS) {
        const prior = await fetchAthleteGamelog(p.id, 4, year - 1).catch(() => null);
        if (prior) { priorLogs[p.id] = prior; priorGamelogs[p.id] = prior.games || []; }
      }
    }).catch(() => {})));
  const sH = standings[g.homeId] || {}, sA = standings[g.awayId] || {};
  const offH = clamp((sH.ppgFor || LG_PPG) / LG_PPG, 0.65, 1.5);
  const offA = clamp((sA.ppgFor || LG_PPG) / LG_PPG, 0.65, 1.5);
  const defAllowH = clamp((sA.ppgAgainst || LG_PPG) / LG_PPG, 0.65, 1.5); // away points allowed -> feeds HOME's projected points
  const defAllowA = clamp((sH.ppgAgainst || LG_PPG) / LG_PPG, 0.65, 1.5);
  const lambdaH = +clamp(LG_PPG * offH * defAllowH * HOME_FIELD_MULT.home, 6, 45).toFixed(2);
  const lambdaA = +clamp(LG_PPG * offA * defAllowA * HOME_FIELD_MULT.away, 6, 45).toFixed(2);
  return {
    ready: true, loading: false, stadium, weather: wx,
    home: { teamId: g.homeId, roster: rosterH, depth: depthH, featured: featH, teamStats: teamStatsH, standings: sH },
    away: { teamId: g.awayId, roster: rosterA, depth: depthA, featured: featA, teamStats: teamStatsA, standings: sA },
    logs, priorLogs, gamelogs, priorGamelogs, lambdaH, lambdaA,
  };
}

/* ---------------- odds rows -> priced board entries ---------------- */
// gl = the game's parsed market lines; the market spread drives the game-script multiplier
function buildPropEntries(g, d, rows, book, gl) {
  const gWithSpread = { ...g, marketSpreadHome: gl && gl.spreads && gl.spreads.homePoint != null ? gl.spreads.homePoint : null };
  const byName = {};
  for (const side of ["home", "away"]) {
    const teamData = side === "home" ? d.home : d.away;
    for (const p of teamData.featured) byName[normName(p.name)] = { ctx: playerCtx(d, gWithSpread, side, p), name: p.name, id: p.id, pos: p.pos };
  }
  const entries = [];
  for (const row of rows) {
    const found = byName[normName(row.player)];
    if (!found) continue;
    if (!propsForPos(posKey(found.pos)).includes(row.type) && row.type !== "Anytime TD") continue;
    const pre = projectProp(found.ctx, row.type, parseFloat(row.point));
    for (const side of ["over", "under"]) {
      const odds = side === "over" ? row.over : row.under;
      if (odds == null) continue;
      const bet = { gamePk: g.pk, game: `${g.away}@${g.home}`, gameTimeIso: g.gameTimeIso || null, playerId: found.id, name: found.name, type: row.type, line: String(row.point), side, odds, overOdds: row.over, underOdds: row.under, ctx: found.ctx, book: row.srcBook || book };
      const ev = evalBet(bet, pre);
      entries.push({ id: `${g.pk}-${found.id}-${row.type}-${row.point}-${side}`, ...bet, ...ev, experimental: EXPERIMENTAL_TYPES.has(row.type), suppressNote: ev.roleCheck ? "role check" : null });
    }
  }
  return entries;
}
function buildLineEntries(g, d, gl, book) {
  return buildGameLineEntries(g, d, gl, book).map((e) => ({ ...e, experimental: EXPERIMENTAL_TYPES.has(e.type) }));
}

/* ---------------- Player Analysis ---------------- */
const dstName = (teamId, d) => {
  const g = d && (d.home.teamId === teamId ? "home" : d.away.teamId === teamId ? "away" : null);
  return g ? `${g} D/ST` : "D/ST";
};
async function fetchPlayerAnalysisProfile(player, _season, key) {
  const id = String(player.id);
  if (id.startsWith("dst-")) {
    const teamId = Number(id.slice(4));
    return { kind: "DST", player: { id, name: player.name || "D/ST", pos: "DST", teamId, teamName: player.teamName || "" }, log: null, priorLog: null };
  }
  const year = parseWeekKey(key).year;
  const [bio, gl] = await Promise.all([
    jget(`${ESPN_WEB}/athletes/${id}`).catch(() => null),
    fetchAthleteGamelog(id, 4).catch(() => null),
  ]);
  const a = (bio && bio.athlete) || {};
  const teamId = a.team ? Number(a.team.id) : player.teamId || null;
  if (teamId) playerTeam[id] = teamId;
  const prior = !gl || !gl.games || gl.games.length < GAMELOG_ROWS ? await fetchAthleteGamelog(id, 4, year - 1).catch(() => null) : null;
  const pos = posKey((a.position && a.position.abbreviation) || player.pos || "");
  return {
    kind: pos,
    player: { id, name: a.displayName || player.name, pos, jersey: a.jersey || "", teamId, teamAbbr: (a.team && a.team.abbreviation) || "", teamName: (a.team && a.team.displayName) || player.teamName || "" },
    log: gl, priorLog: prior,
  };
}
function findPlayerInSlate(playerId, games) {
  const t = playerTeam[String(playerId)];
  if (t == null) return null;
  for (const g of games || []) {
    if (String(g.homeId) === String(t)) return { game: g, side: "home", player: { id: String(playerId) } };
    if (String(g.awayId) === String(t)) return { game: g, side: "away", player: { id: String(playerId) } };
  }
  return null;
}
/* ---------------- Trends ---------------- */
function trendSubjects(g, d) {
  const out = [];
  for (const side of ["home", "away"]) {
    for (const p of (side === "home" ? d.home : d.away).featured) out.push({ player: { ...p, pos: posKey(p.pos) }, pid: p.id, props: propsForKind(p.pos), isHome: side === "home" });
  }
  return out;
}

/* ---------------- settlement ---------------- */
// ESPN's box score has no Longest Completion; pull it from each passer's gamelog before grading
async function augmentResults(items, results) {
  const found = {}; let attempted = 0, hits = 0;
  for (const b of items) {
    if (b.type !== "Longest Completion") continue;
    const res = results[b.gamePk];
    if (!res || !res.final || res.canceled) continue;
    const k = `${b.playerId}:${b.gamePk}`;
    if (k in found) continue;
    attempted++;
    found[k] = await fetchLongCmpForEventTrySeasons(b.playerId, b.gamePk, weekYear(b.date ?? b.week));
    if (found[k] != null) hits++;
    res.longCmp = res.longCmp || {};
    res.longCmp[String(b.playerId)] = found[k];
  }
  return attempted ? ` Longest Completion lookups: ${hits}/${attempted} found (see console for misses).` : "";
}
function gradeLineResult(type, side, line, res) { return gradeLine(type, side, line, res.homeScore, res.awayScore); }
function gradeProp(b, res, dnpActual) {
  const ps = res.players[b.playerId] || res.players[String(b.playerId)];
  if (!ps) return { status: "void", actual: dnpActual };   // never appeared in the box score -> no action
  let actual = actualFor(b.type, ps);
  if (actual == null && b.type === "Longest Completion") actual = (res.longCmp && res.longCmp[String(b.playerId)]) ?? null;
  const st = gradeBet(b.side, parseFloat(String(b.line)), actual);
  return st == null ? null : { status: st, actual };
}

/* ---------------- manual draft (+ on a Slate player) ---------------- */
function draftCtx(d, g, kind, pid) {
  if (!d || !d.ready) return null;
  if (String(pid).startsWith("dst-")) { const side = d.home.teamId === Number(String(pid).slice(4)) ? "home" : "away"; return playerCtx(d, g, side, { id: pid, pos: "DST", name: dstName(Number(String(pid).slice(4)), d) }); }
  const hit = rosterSpot(d, pid);
  if (!hit) return null;
  const featured = (hit.side === "home" ? d.home : d.away).featured.find((x) => String(x.id) === String(pid));
  return playerCtx(d, g, hit.side, featured || hit.p);
}
const DRAFT_DEFAULT = { QB: "Pass Yards", RB: "Rush Yards", WR: "Receiving Yards", TE: "Receiving Yards", K: "Kicking Points", DST: "Sacks" };

const NFL = {
  id: "nfl",
  slate,
  meta: {
    title: "NFL", emoji: "🏈", tagline: "live odds · de-vigged edge · Monte-Carlo props", league: "NFL",
    statsSource: "ESPN", searchPlaceholder: "Patrick Mahomes",
    analysisHint: "League-wide NFL player lookup. Players whose team plays in the selected week get matchup context, model projections, and any pulled",
    csvPrefix: "nfl-edge-finder", boardLogCsvPrefix: "nfl-board-log", backupApp: "nfl-edge-finder",
    slateColumn: "week",
    boardLogExtraCols: [["preStart", (e) => (e.preStart == null ? "" : e.preStart ? "true" : "false")], ["roleCheck", (e) => (e.roleCheck ? "true" : "")]],
    emptySlateMsg: "No games this week (bye-heavy week, or week/season not yet scheduled).",
    overrideTitle: "Per-market book overrides: pull one market from a different book when your main book doesn't carry it",
    diagnosticsType: "Anytime TD", diagnosticsMarketKey: "player_anytime_td",
    draftKindLabel: (kind) => kind || "PLAYER",
    searchResultLine: (p) => p.teamName || "Free agent / unresolved team",
  },
  config: { ALL_PROPS: ALL_PLAYER_PROPS, BOOKS, BOOK_LABELS, CATEGORY_ORDER, DEFAULT_LINE, ODDS_TESTING_LIMIT, isLineType, matchesQuery, STAT_ORDER: CATEGORY_ORDER, TREND_PROPS, TREND_SAMPLES: [3, 5, 8, 12, 16], TREND_DEFAULT_N: 8 },
  storage,
  api: {
    fetchSchedule: fetchScheduleForKey,
    fetchOddsEvents: () => fetchOddsEvents(currentSportKey),
    fetchEventOdds: (id, books) => fetchEventOdds(currentSportKey, id, books),
    matchEvent,
    oddsDebug: (data, bookKey) => {
      const bms = (data && data.bookmakers) || []; const bm = bms.find((b) => b.key === bookKey);
      const mk = bm && (bm.markets || []).find((m) => m.key === "player_anytime_td");
      return { books: bms.map((b) => b.key), usedBook: bm ? bm.key : null, rawKeys: bm ? (bm.markets || []).map((m) => m.key) : [], hasHR: !!mk, hrSample: mk && mk.outcomes ? mk.outcomes[0] : null };
    },
    parseEventOdds, parseGameOdds, matchCurrentOdds, buildGameLineEntries: buildLineEntries,
    fetchGameResult: fetchGameSummary,
    searchPlayers: (q) => searchPlayers(q),
    fetchPlayerAnalysisProfile, findPlayerInSlate,
    buildTrendCard: (p, _pid, type, games, g, isHome, entries, n) => buildTrendCard(p, posKey(p.pos), type, games ? { games } : null, g, isHome, entries, n),
    getDeltaSignal,
  },
  model: { projectProp },
  loadGameDetail, buildPropEntries, analysisCtx, trendSubjects, augmentResults,
  propsForKind,
  gradeLineResult,
  gradeTrackedProp: (b, res) => gradeProp(b, res, "DNP"),
  gradeLogProp: (e, res) => gradeProp(e, res, "DNP"),
  draftCtx,
  draftDefaults: (kind) => { const type = DRAFT_DEFAULT[posKey(kind)] || "Receptions"; return { type, line: DEFAULT_LINE[type] || "0.5" }; },
  ui: { Chip, ScoreLine, GameSubtitle, SlateDetail, BoardRow, MyBetRow, TrendCard, PlayerAnalysisIntro, PlayerProfilePanel },
};
export { MODEL_VERSION };
export default NFL;
