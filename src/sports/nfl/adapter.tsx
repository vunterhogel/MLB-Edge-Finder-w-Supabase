/* NFL sport adapter for the shared MLB shell (same shape as the MLB / NBA / NHL adapters).
   The projection model is the old NFL page's engine, moved without changing a number (nfl-v2).
   Everything else (navigation by date, tracking, settlement, stats, persistence) is the MLB shell's. */
import { loadMatchupSnapshot, matchupInputs } from "./matchups";
import { ALL_PLAYER_PROPS, BOOKS, BOOK_LABELS, CATEGORY_ORDER, DEFAULT_LINE, HOME_FIELD_MULT, LG_PPG, ODDS_SPORT, ODDS_SPORT_PRESEASON, ODDS_TESTING_LIMIT, STADIUMS, SIGNAL_RULES, isLineType, matchesQuery } from "./config";
import { GAMELOG_ROWS, ESPN_WEB, TREND_PROPS, actualFor, buildGameLineEntries, buildTrendCard, fetchAthleteGamelog, fetchDepthChart, fetchEventOdds, fetchGameSummary, fetchLongCmpForEventTrySeasons, fetchOddsEvents, fetchRoster, fetchScheduleByDate, fetchStandings, fetchTeamStats, fetchWeather, gradeLine, jget, matchCurrentOdds, matchEvent, normName, parseEventOdds, parseGameOdds, searchPlayers, trendValueForGame } from "./data";
import { MODEL_VERSION, calculateInjuryAvailability, evalBet, gameProbs, projectProp } from "./engine";
import { analysisCtx, featuredFromRosterAndDepth, playerCtx, posKey, propsForKind, propsForPos, rosterSpot } from "./context";
import { createStorage } from "../../core/storage";
import { clamp, gradeBet } from "../../core/math";
import { logSections } from "../../core/playerLog";
import { injuryChip } from "../../core/slate";

// NFL seasons cross the new year (playoffs in Jan/Feb belong to the previous season)
export function nflSeasonFor(dateStr) { const [y, m] = String(dateStr).split("-").map(Number); return m >= 3 ? y : y - 1; }

// Older NFL records (before the shared shell) stored their slate as a week key "year-seasonType-week".
// The shell keys every sport by date, so those are mapped to the Sunday of that week when loaded
// (bets and board-log rows map identically, so settlement still pairs them up).
function weekKeySunday(k) {
  const m = /^(\d{4})-([123])-(\d+)$/.exec(String(k || ""));
  if (!m) return null;
  const y = +m[1], st = +m[2], w = +m[3];
  const labor = new Date(y, 8, 1); while (labor.getDay() !== 1) labor.setDate(labor.getDate() + 1);
  const wk1 = new Date(labor); wk1.setDate(wk1.getDate() + 6);           // first regular-season Sunday
  const d = new Date(wk1);
  if (st === 2) d.setDate(d.getDate() + 7 * (w - 1));
  else if (st === 1) d.setDate(d.getDate() - 7 * (4 - w));
  else d.setDate(d.getDate() + 7 * (17 + w));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function migrateRecord(r) {
  const k = r.date ?? r.week;
  const date = weekKeySunday(k);
  return date ? { ...r, date } : (r.date == null && r.week != null ? { ...r, date: r.week } : r);
}
const storage = createStorage("nfief", MODEL_VERSION, {}, migrateRecord);   // nfief_* keys (unchanged)

/* the odds feed splits preseason into its own sport key; follow the loaded date's games */
let currentSportKey = ODDS_SPORT;
async function fetchScheduleForDate(date) {
  const games = await fetchScheduleByDate(date);
  currentSportKey = games.some((g) => g.seasonType === 1) ? ODDS_SPORT_PRESEASON : ODDS_SPORT;
  return games;
}

/* ---------------- per-game detail (moved from the old page's loadDetail) ---------------- */
// player id -> ESPN team id, so Player Analysis can find a searched player's game on the slate
const playerTeam = {};
const standingsCache = {};
function standingsFor(yr) { if (!standingsCache[yr]) standingsCache[yr] = fetchStandings(yr).catch(() => ({})); return standingsCache[yr]; }

async function loadGameDetail(g, { date }) {
  const year = nflSeasonFor(date);
  const standings = await standingsFor(year);
  const stadium = STADIUMS[g.homeId] || { lat: null, lon: null, dome: true };
  const [rosterH, rosterA, depthH, depthA, teamStatsH, teamStatsA, matchupSnap] = await Promise.all([
    fetchRoster(g.homeId).catch(() => []), fetchRoster(g.awayId).catch(() => []),
    fetchDepthChart(g.homeId, year).catch(() => ({})), fetchDepthChart(g.awayId, year).catch(() => ({})),
    fetchTeamStats(g.homeId).catch(() => ({ off: {}, def: {} })), fetchTeamStats(g.awayId).catch(() => ({ off: {}, def: {} })),
    loadMatchupSnapshot(),
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
    // v3: opponent positional matchup multipliers from the NFL Matchup Lab snapshot (null -> v2 inputs)
    matchups: matchupInputs(matchupSnap, g),
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
      entries.push({ id: `${g.pk}-${found.id}-${row.type}-${row.point}-${side}`, ...bet, ...ev, suppressNote: ev.roleCheck ? "role check" : null });
    }
  }
  return entries;
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
  const year = nflSeasonFor(key);
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


/* ---------------- Slate: what the shared game panel shows for a football game ---------------- */
const game = {
  subtitle: (g) => (g.venue || "TBD") + (g.awayRec || g.homeRec ? ` · ${g.awayRec || "—"} / ${g.homeRec || "—"}` : ""),
  finalSuffix: (g) => (g.period && g.period > 4 ? "/OT" : ""),
  liveLabel: (g) => `${g.period > 4 ? "OT" : `Q${g.period}`} ${g.clock || ""}`,
};
// headline last-4-games rate per position, from the gamelog the Slate already fetches
const L4_HEADLINE = { QB: ["passYds", "pYds"], RB: ["rushYds", "rYds"], WR: ["recYds", "rcYds"], TE: ["recYds", "rcYds"], K: ["kickPts", "pts"] };
function l4(gl, pos) {
  const cfg = L4_HEADLINE[pos];
  if (!cfg || !gl || !gl.recent || !gl.recent.games) return null;
  return `L${gl.recent.games} ${cfg[1]} ${((gl.recent[cfg[0]] || 0) / gl.recent.games).toFixed(1)}/g`;
}
function footballColumn(title, team, d) {
  const dst = { id: `dst-${team.teamId}`, pos: "DST", name: `${title.split(" ")[0]} D/ST` };
  const rows = [...team.featured, dst].map((p, i) => {
    const pos = posKey(p.pos);
    const gl = d.logs[p.id];
    const s = gl && gl.season;
    return {
      id: p.id, idx: i + 1, name: p.name,
      chip: { text: `${p.pos}${p.depthRank && p.depthRank < 90 ? p.depthRank : ""}`, tone: "muted", title: "position / depth-chart rank" },
      chips: [p.depthConfirmed === false ? { text: "?", tone: "warn", title: "No confirmed depth chart for this team, so the order is the roster listing, not a verified starter" } : null, injuryChip(p.injuryStatus)].filter(Boolean),
      stat: l4(gl, pos),
      detail: [{ text: s && s.g ? `season: ${s.g} gm` : "season: n/a" }, ...(gl && gl.recent && gl.recent.games ? [{ text: `last ${gl.recent.games}: ${l4(gl, pos) || "—"}`, strong: true }] : [])],
      player: { id: p.id, name: p.name, pos: p.pos, teamId: team.teamId }, draft: { kind: pos, id: p.id, name: p.name },
    };
  });
  return { title, empty: "— roster unavailable —", rows: team.featured.length ? rows : [] };
}
function slateView(g, d) {
  const gp = gameProbs(d.lambdaH, d.lambdaA);
  const w = d.weather;
  return {
    env: [
      { label: "VENUE", v: g.venue || "—" },
      ...(d.stadium && d.stadium.dome ? [{ label: "ROOF", v: "dome/closed" }] : []),
      ...(w ? [{ label: "TEMP", v: `${w.temp}°`, hot: w.temp >= 90, cold: w.temp <= 32 }, { label: "WIND", v: `${w.wind}mph`, hot: w.wind >= 15 }, { label: "RAIN", v: `${w.pop}%`, hot: w.pop >= 50 }] : []),
    ],
    gameLine: { lambdaA: d.lambdaA, lambdaH: d.lambdaH, home: gp.home, away: gp.away, total: gp.totalLambda, note: "team scoring environment (standings points for / against × home field). Game lines are experimental: once odds are pulled they anchor to the market total and spread." },
    sections: [[footballColumn(`${g.away} (away)`, d.away, d), footballColumn(`${g.home} (home)`, d.home, d)]],
  };
}


/* ---------------- Player Analysis data (rendered by the shared core/analysis.tsx) ---------------- */
const NFL_ABBR = { "Pass Yards": "PaYd", "Pass Completions": "Cmp", "Pass Attempts": "Att", "Pass TDs": "PaTD", "Interceptions": "INT", "Rush Yards": "RuYd", "Rush TDs": "RuTD", "Receptions": "Rec", "Receiving Yards": "ReYd", "Receiving TDs": "ReTD", "Kicking Points": "KPts", "Field Goals Made": "FGM", "Anytime TD": "TD" };
const FORM_TYPES = { QB: ["Pass Yards", "Pass Completions", "Pass Attempts", "Pass TDs"], RB: ["Rush Yards", "Receptions", "Receiving Yards", "Anytime TD"], WR: ["Receptions", "Receiving Yards", "Receiving TDs"], TE: ["Receptions", "Receiving Yards", "Receiving TDs"], K: ["Kicking Points", "Field Goals Made"] };
const n1 = (x) => (x == null || isNaN(x) ? "—" : Number(x).toFixed(1));
function seasonMetrics(pos, s) {
  const has = !!(s && s.g > 0);
  const v = (k) => (has ? Math.round(s[k] || 0) : "—");
  const per = (k) => (has ? n1((s[k] || 0) / s.g) : "—");
  if (pos === "QB") return { tiles: [["Pass Yds", v("passYds")], ["Pass TD", v("passTd")], ["INT", v("ints")], ["Yds/G", per("passYds")]], grid: [["G", has ? s.g : 0], ["Cmp/G", per("passCmp")], ["Att/G", per("passAtt")], ["Yds/G", per("passYds"), "sky"], ["TD", v("passTd"), "sky"], ["INT", v("ints")], ["Rush Yds", v("rushYds")], ["Rush TD", v("rushTd")]] };
  if (pos === "RB") return { tiles: [["Rush Yds", v("rushYds")], ["Rush TD", v("rushTd")], ["Rec", v("rec")], ["YPC", has && s.rushAtt ? (s.rushYds / s.rushAtt).toFixed(1) : "—"]], grid: [["G", has ? s.g : 0], ["Car/G", per("rushAtt")], ["Rush Yds/G", per("rushYds"), "sky"], ["Rush TD", v("rushTd"), "sky"], ["Tgt/G", per("targets")], ["Rec/G", per("rec")], ["Rec Yds/G", per("recYds")], ["Rec TD", v("recTd")]] };
  if (pos === "WR" || pos === "TE") return { tiles: [["Rec", v("rec")], ["Rec Yds", v("recYds")], ["Rec TD", v("recTd")], ["Yds/Rec", has && s.rec ? (s.recYds / s.rec).toFixed(1) : "—"]], grid: [["G", has ? s.g : 0], ["Tgt/G", per("targets"), "sky"], ["Rec/G", per("rec"), "sky"], ["Yds/G", per("recYds"), "sky"], ["Rec TD", v("recTd")], ["Catch%", has && s.targets ? `${Math.round((s.rec / s.targets) * 100)}%` : "—"], ["Yds/Tgt", has && s.targets ? (s.recYds / s.targets).toFixed(1) : "—"], ["Rush Yds", v("rushYds")]] };
  if (pos === "K") return { tiles: [["FG Made", v("fgMade")], ["Kick Pts", v("kickPts")], ["Pts/G", per("kickPts")], ["Games", has ? s.g : "—"]], grid: [["G", has ? s.g : 0], ["FGM/G", per("fgMade"), "sky"], ["Pts/G", per("kickPts"), "sky"], ["FG Made", v("fgMade")]] };
  return { tiles: [["Sacks", "—"], ["Def INT", "—"], ["Games", "—"], ["Depth", "—"]], grid: [] };
}
function playerView({ profile, spot, detail }) {
  const p = profile.player;
  const ready = spot && detail && detail.ready;
  const ctx = ready ? analysisCtx(detail, spot, profile) : null;
  const pos = (ctx && ctx.pos) || p.pos || "";
  const log = (detail && detail.logs && detail.logs[p.id]) || profile.log;
  const prior = (detail && detail.priorLogs && detail.priorLogs[p.id]) || profile.priorLog;
  const sm = seasonMetrics(pos === "TE" ? "TE" : pos, log && log.season);
  const types = FORM_TYPES[pos] || [];
  const curRows = (log && log.games) || [];
  const roster = ready ? [...detail.home.roster, ...detail.away.roster].find((x) => String(x.id) === String(p.id)) : null;
  const mult = (x) => (x == null ? "—" : `×${Number(x).toFixed(2)}`);
  const oppDef = ctx && ctx.oppPassYdsAllowed != null ? ctx.oppPassYdsAllowed : null;
  return {
    headshot: pos === "DST" ? null : `https://a.espncdn.com/i/headshots/nfl/players/full/${p.id}.png`,
    subtitle: [p.teamAbbr || (spot ? (spot.side === "home" ? spot.game.home : spot.game.away) : "FA"), pos || "—", p.jersey ? `#${p.jersey}` : "", ctx && ctx.depthRank && ctx.depthRank < 90 ? `depth #${ctx.depthRank}` : "", roster && roster.injuryStatus ? roster.injuryStatus.replace(/_/g, " ") : ""].filter(Boolean).join(" · "),
    metrics: sm.tiles,
    cards: [
      !spot ? { title: "SLATE MATCHUP", empty: "Not found on the selected date." } : {
        title: "SLATE MATCHUP", headline: { text: `${spot.game.away} @ ${spot.game.home}` },
        note: `${spot.side === "home" ? spot.game.home : spot.game.away} ${pos || "player"} · vs ${spot.side === "home" ? spot.game.away : spot.game.home}`,
        lines: ready ? [
          `model score ${spot.game.away} ${detail.lambdaA.toFixed(1)} – ${detail.lambdaH.toFixed(1)} ${spot.game.home}`,
          detail.weather ? `${detail.weather.temp}°F · wind ${detail.weather.wind}mph · rain ${detail.weather.pop}%` : detail.stadium && detail.stadium.dome ? "dome / closed roof" : "weather unavailable",
          roster && roster.injuryStatus ? { text: `status ${roster.injuryStatus.replace(/_/g, " ")}`, tone: "warn" } : { text: "no injury designation", tone: "muted" },
        ] : [{ text: "loading detail…", tone: "muted" }],
      },
      { title: "SEASON BASELINE", empty: log && log.season && log.season.g > 0 ? null : "No season log yet.", grid: sm.grid },
      !ctx ? { title: "MODEL CONTEXT", empty: spot ? "loading matchup context…" : "Available when the player is on the selected slate." } : {
        title: "MODEL CONTEXT", note: "inputs the projection uses for this game",
        grid: [["spread", ctx.teamSpread != null ? n1(ctx.teamSpread) : "—", "sky"], ["implied pts", ctx.impliedTeamPts != null ? n1(ctx.impliedTeamPts) : "—", "sky"],
          ["opp pass yds/g", oppDef != null ? n1(oppDef) : "—"], ["opp rush yds/g", ctx.oppRushYdsAllowed != null ? n1(ctx.oppRushYdsAllowed) : "—"],
          ["availability", mult(calculateInjuryAvailability(ctx.injuryStatus))], ["goal-line share", mult(ctx.goalLineShareMult)],
          ["short week", ctx.shortWeek ? "yes" : "no"], ["prior season", ctx.priorSeason ? "in base" : "none"]],
      },
    ],
    ...logSections({ rows: [...curRows, ...((prior && prior.games) || [])], curCount: curRows.length, types, valueFor: trendValueForGame, abbr: (t) => NFL_ABBR[t] || t, defaultLines: DEFAULT_LINE, title: "Recent Form" }),
  };
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
    found[k] = await fetchLongCmpForEventTrySeasons(b.playerId, b.gamePk, nflSeasonFor(b.date));
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
  meta: {
    title: "NFL", tagline: "live odds · de-vigged edge · Monte-Carlo props", emoji: "🏈", league: "NFL",
    analysisHint: "NFL-wide profile lookup. If the player is on the selected slate, this tab adds matchup context, model projections, and any pulled",
    statsSource: "ESPN", searchPlaceholder: "Patrick Mahomes",
    csvPrefix: "nfl-edge-finder", boardLogCsvPrefix: "nfl-board-log", backupApp: "nfl-edge-finder",
    overrideTitle: "Per-market book overrides: pull one market from a different book when your main book doesn't carry it",
    diagnosticsType: "Anytime TD", diagnosticsMarketKey: "player_anytime_td",
    draftKindLabel: (kind) => kind || "PLAYER",
    searchResultLine: (p) => p.teamName || "Free agent / unresolved team",
    intro: {
      file: "Search any NFL player by name.", fileSub: "season · last 4 · game log",
      slate: (games) => `${games.length} game(s) on this date, ${games.filter((g) => g.status === "LIVE").length} live.`,
      slateSub: "game script · weather · injuries · depth",
    },
  },
  config: { ALL_PROPS: ALL_PLAYER_PROPS, BOOKS, BOOK_LABELS, CATEGORY_ORDER, DEFAULT_LINE, ODDS_TESTING_LIMIT, isLineType, matchesQuery, STAT_ORDER: CATEGORY_ORDER, TREND_PROPS, SIGNAL_RULES },
  storage,
  api: {
    fetchSchedule: fetchScheduleForDate,
    fetchOddsEvents: () => fetchOddsEvents(currentSportKey),
    fetchEventOdds: (id, books) => fetchEventOdds(currentSportKey, id, books),
    matchEvent,
    oddsDebug: (data, bookKey) => {
      const bms = (data && data.bookmakers) || []; const bm = bms.find((b) => b.key === bookKey);
      const mk = bm && (bm.markets || []).find((m) => m.key === "player_anytime_td");
      return { books: bms.map((b) => b.key), usedBook: bm ? bm.key : null, rawKeys: bm ? (bm.markets || []).map((m) => m.key) : [], hasHR: !!mk, hrSample: mk && mk.outcomes ? mk.outcomes[0] : null };
    },
    parseEventOdds, parseGameOdds, matchCurrentOdds, buildGameLineEntries,
    fetchGameResult: fetchGameSummary,
    searchPlayers: (q) => searchPlayers(q),
    fetchPlayerAnalysisProfile, findPlayerInSlate,
    buildTrendCard: (p, _pid, type, games, g, isHome, entries, n) => buildTrendCard(p, posKey(p.pos), type, games ? { games } : null, g, isHome, entries, n),
  },
  model: { projectProp },
  loadGameDetail, buildPropEntries, analysisCtx, trendSubjects, augmentResults,
  propsForKind,
  gradeLineResult,
  gradeTrackedProp: (b, res) => gradeProp(b, res, "DNP"),
  gradeLogProp: (e, res) => gradeProp(e, res, null),
  draftCtx,
  draftDefaults: (kind) => { const type = DRAFT_DEFAULT[posKey(kind)] || "Receptions"; return { type, line: DEFAULT_LINE[type] || "0.5" }; },
  game, slateView, playerView,
};
export default NFL;
