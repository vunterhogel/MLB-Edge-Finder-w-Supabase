/* MLB sport adapter: everything the shared SportApp shell needs that is genuinely baseball-specific.
   Bodies below are moved verbatim from the original App.tsx (only their location changed), so MLB
   behaves exactly as before. Other sports implement the same shape (see core/sport.ts). */
import { ALL_PROPS, BOOKS, BOOK_LABELS, CATEGORY_ORDER, DEFAULT_LINE, HITTER_PROPS, LG_KRATE, LG_RPG, ODDS_TESTING_LIMIT, PARKS, PITCHER_PROPS, isLineType, matchesQuery } from "./config";
import { TREND_PROPS, attachPitcherHr9FromStatsApi, buildGameLineEntries, buildTrendCard, emptyStatcast, expectedStartIP, fetchBvP, fetchEventOdds, fetchGameResult, fetchGameStatcast, fetchHands, fetchHitterLog, fetchHitterSeason, fetchHitterSplits, fetchHitterStatcastLeaderboards, fetchLiveBox, fetchOddsEvents, fetchPitcherLog, fetchPitcherSeason, fetchPlayerAnalysisProfile, fetchPlayerGameLogs, fetchPlayerSeasonStatcast, fetchSchedule, fetchTeamRPG, fetchWeather, matchCurrentOdds, matchEvent, oddsDebug, parseEventOdds, parseGameOdds, resolveHitterSeasonStatcast, searchPlayers, statcastCoverageSummary } from "./data";
import { POSTSEASON, calculateOppPitchingAdjustment, evalBet, gameFractionRemaining, gameProbs, projectProp } from "./engine";
import { clamp, pct, probToAmerican } from "../../core/math";
import { normName } from "../../core/odds";
import { Env, mono } from "../../core/ui";
import { BoardRow, Chip, LineupCol, MyBetRow, PlayerAnalysisIntro, PlayerProfilePanel, SPCard, STAT_ORDER, ScoreLine, TrendCard, getDeltaSignal } from "./ui";
import { actualFor, findPlayerInSlate, gradeBet, gradeLine, profitUnits } from "./settle";
import * as storage from "./storage";

/* ---- context builders (moved from App) ---- */
function liveSnap(d, pid) { if (!d.live) return null; return { fractionRemaining: d.live.fractionRemaining, totals: (d.live.totalsById && d.live.totalsById[pid]) || {} }; }
function hitterCtx(d, h, pid) {
  return { kind: "hitter", season: h.season, l15: h.l15, bvp: h.bvp, splits: h.splits, bats: h.bats, oppThrows: h.oppThrows, lineupIndex: h.idx, park: d.park, weather: d.weather, statcastLive: h.statcastLive || null, statcastSeason: h.statcastSeason || null, teamLambda: h.side === "home" ? d.lambdaH : d.lambdaA, oppRAPG: h.side === "home" ? d.rapgAway : d.rapgHome, oppSP: (h.oppSP && d.spStats[h.oppSP.id]) || null, live: liveSnap(d, pid), postseason: !!d.postseason };
}
function pitcherCtx(d, sp, isHome) { const ps = d.spStats[sp.id]; return { kind: "pitcher", season: ps, statcastSeason: ps && ps.statcastSeason, park: d.park, weather: d.weather, teamLambda: isHome ? d.lambdaH : d.lambdaA, oppKRate: isHome ? d.kRateAway : d.kRateHome, live: liveSnap(d, sp.id), postseason: !!d.postseason }; }

/* ---- game detail: every stat the MLB engine needs for one game (moved from App.loadDetail) ---- */
async function loadGameDetail(g, { season, date }) {
  const scLB = await fetchHitterStatcastLeaderboards(season).catch(() => ({ batter: {}, ok: false }));
  const park = PARKS[g.homeId] || { rf: 1, elev: 0, lat: null, lon: null, dome: false };
  const hitters = {};
  const allH = [
    ...g.awayLineup.map((x, i) => ({ ...x, side: "away", idx: i, oppSP: g.homeSP })),
    ...g.homeLineup.map((x, i) => ({ ...x, side: "home", idx: i, oppSP: g.awaySP })),
  ];
  const tasks = [];
  // Trends: per-game logs for every lineup hitter + both starters (free MLB Stats API), with a
  // prior-season fallback when the current season's log is thin.
  const gamelogs = {};
  const priorGamelogs = {};
  const priorSeasonStr = String(Number(season) - 1);
  for (const h of allH) {
    const r = { name: h.name, side: h.side, idx: h.idx, oppName: h.oppSP ? h.oppSP.name : null, season: null, l15: null, bvp: null, splits: null, bats: null, oppThrows: null, statcastLive: null, statcastSeason: null };
    hitters[h.id] = r;
    tasks.push(fetchHitterSeason(h.id, season).then((s) => { r.season = s; }).catch(() => {}));
    tasks.push(fetchHitterLog(h.id, season).then((l) => { r.l15 = l; }).catch(() => {}));
    tasks.push(fetchHitterSplits(h.id, season).then((sp) => { r.splits = sp; }).catch(() => {}));
    tasks.push(resolveHitterSeasonStatcast(scLB, h.id, season, date).then((sc) => { r.statcastSeason = sc; }).catch(() => {}));
    if (h.oppSP) tasks.push(fetchBvP(h.id, h.oppSP.id, season).then((bp) => { r.bvp = bp; }).catch(() => {}));
    tasks.push(fetchPlayerGameLogs(h.id, season, "hitting", 20).then(async (gl) => {
      gamelogs[h.id] = gl;
      if (!gl || gl.length < 10) {
        const prior = await fetchPlayerGameLogs(h.id, priorSeasonStr, "hitting", 20).catch(() => []);
        if (prior && prior.length) priorGamelogs[h.id] = prior;
      }
    }).catch(() => {}));
  }
  let hands = {};
  const handIds = [...allH.map((h) => h.id), ...(g.homeSP ? [g.homeSP.id] : []), ...(g.awaySP ? [g.awaySP.id] : [])];
  if (handIds.length) tasks.push(fetchHands(handIds).then((hh) => { hands = hh; }).catch(() => {}));
  const spStats = {};
  // fetchPitcherLog (last-5-starts IP avg) added alongside season + Statcast to fix outs under-projection.
  // expIp is recomputed here with the recent log so calculateBaseProjection always sees an up-to-date value.
  if (g.homeSP) tasks.push(Promise.all([fetchPitcherSeason(g.homeSP.id, season), fetchPlayerSeasonStatcast(g.homeSP.id, "pitcher", season, date), fetchPitcherLog(g.homeSP.id, season)]).then(([s, sc, log]) => { if (s) { s.statcastSeason = attachPitcherHr9FromStatsApi(sc, s); if (log) { s.recentLog = log; s.expIp = expectedStartIP(s.ip, s.gs, s.gp, log); } spStats[g.homeSP.id] = s; } }).catch(() => {}));
  if (g.awaySP) tasks.push(Promise.all([fetchPitcherSeason(g.awaySP.id, season), fetchPlayerSeasonStatcast(g.awaySP.id, "pitcher", season, date), fetchPitcherLog(g.awaySP.id, season)]).then(([s, sc, log]) => { if (s) { s.statcastSeason = attachPitcherHr9FromStatsApi(sc, s); if (log) { s.recentLog = log; s.expIp = expectedStartIP(s.ip, s.gs, s.gp, log); } spStats[g.awaySP.id] = s; } }).catch(() => {}));
  for (const sp of [g.homeSP, g.awaySP].filter(Boolean)) {
    tasks.push(fetchPlayerGameLogs(sp.id, season, "pitching", 20).then(async (gl) => {
      gamelogs[sp.id] = gl;
      if (!gl || gl.length < 5) {
        const prior = await fetchPlayerGameLogs(sp.id, priorSeasonStr, "pitching", 20).catch(() => []);
        if (prior && prior.length) priorGamelogs[sp.id] = prior;
      }
    }).catch(() => {}));
  }
  let teamH = { rpg: LG_RPG, rapg: LG_RPG, kRate: LG_KRATE }, teamA = { rpg: LG_RPG, rapg: LG_RPG, kRate: LG_KRATE }, wx = null, liveBox = null, statcast = emptyStatcast();
  tasks.push(fetchTeamRPG(g.homeId, season).then((r) => { teamH = r; }).catch(() => {}));
  tasks.push(fetchTeamRPG(g.awayId, season).then((r) => { teamA = r; }).catch(() => {}));
  if (park.lat) tasks.push(fetchWeather(park.lat, park.lon).then((w) => { wx = w; }).catch(() => {}));
  if (g.status === "LIVE") tasks.push(fetchLiveBox(g.pk).then((b) => { liveBox = b; }).catch(() => {}));
  if (g.status === "LIVE" || g.status === "FINAL") tasks.push(fetchGameStatcast(g.pk).then((sc) => { statcast = sc; }).catch((e) => { statcast = emptyStatcast(`blocked:${e.message || "gf"}`); }));
  await Promise.allSettled(tasks);
  for (const h of allH) { const r = hitters[h.id]; if (r) { r.bats = hands[h.id] ? hands[h.id].bats : null; r.oppThrows = (h.oppSP && hands[h.oppSP.id]) ? hands[h.oppSP.id].throws : null; r.statcastLive = statcast && statcast.byBatter ? statcast.byBatter[String(h.id)] : null; } }
  // Game-line run expectancy reuses the SAME opposing-pitching layer as the props.
  const offH = clamp((teamH.rpg || LG_RPG) / LG_RPG, 0.7, 1.4);   // home offense strength
  const offA = clamp((teamA.rpg || LG_RPG) / LG_RPG, 0.7, 1.4);   // away offense strength
  const oppPitchForHome = calculateOppPitchingAdjustment({ kind: "hitter", oppSP: g.awaySP ? spStats[g.awaySP.id] : null, oppRAPG: teamA.rapg });
  const oppPitchForAway = calculateOppPitchingAdjustment({ kind: "hitter", oppSP: g.homeSP ? spStats[g.homeSP.id] : null, oppRAPG: teamH.rapg });
  const psRuns = g.postseason ? POSTSEASON.runs : 1;   // October run environment (engine.ts POSTSEASON)
  const lambdaH = +clamp(LG_RPG * offH * oppPitchForHome * park.rf * psRuns, 2.0, 8.5).toFixed(2);
  const lambdaA = +clamp(LG_RPG * offA * oppPitchForAway * park.rf * psRuns, 2.0, 8.5).toFixed(2);
  const statcastCoverage = statcastCoverageSummary(hitters, spStats, statcast);
  const live = g.status === "LIVE" ? { fractionRemaining: gameFractionRemaining(g.inning, g.inningState, g.outs), totalsById: liveBox || {} } : null;
  return { ready: true, loading: false, postseason: !!g.postseason, hitters, spStats, gamelogs, priorGamelogs, weather: wx, park, statcast, statcastCoverage, lambdaH, lambdaA, kRateHome: teamH.kRate, kRateAway: teamA.kRate, rapgHome: teamH.rapg, rapgAway: teamA.rapg, live };
}

/* ---- odds rows -> priced board entries for one game (moved from App.getOdds) ---- */
function buildPropEntries(g, d, rows, book) {
  // name -> {ctx} for hitters and pitchers in this game
  const hitterByName = {};
  for (const pid in d.hitters) { const h = d.hitters[pid]; if (h && h.name) hitterByName[normName(h.name)] = { ctx: hitterCtx(d, h, pid), name: h.name, id: pid }; }
  const pitcherByName = {};
  if (g.awaySP && d.spStats[g.awaySP.id]) pitcherByName[normName(g.awaySP.name)] = { ctx: pitcherCtx(d, g.awaySP, false), name: g.awaySP.name, id: g.awaySP.id };
  if (g.homeSP && d.spStats[g.homeSP.id]) pitcherByName[normName(g.homeSP.name)] = { ctx: pitcherCtx(d, g.homeSP, true), name: g.homeSP.name, id: g.homeSP.id };
  const entries = [];
  for (const row of rows) {
    const isPitcher = row.type === "Strikeouts" || row.type === "Outs";
    const found = (isPitcher ? pitcherByName : hitterByName)[normName(row.player)];
    if (!found) continue; // player not in our loaded data (bench, name mismatch)
    const pre = projectProp(found.ctx, row.type, parseFloat(row.point)); // one sim per prop
    for (const side of ["over", "under"]) {
      const odds = side === "over" ? row.over : row.under;
      if (odds == null) continue;
      const rowBook = row.srcBook || book;
      const bet = { gamePk: g.pk, game: `${g.away}@${g.home}`, gameTimeIso: g.gameTimeIso || null, playerId: found.id, name: found.name, type: row.type, line: String(row.point), side, odds, overOdds: row.over, underOdds: row.under, ctx: found.ctx, book: rowBook };
      const ev2 = evalBet(bet, pre);
      entries.push({ id: `${g.pk}-${found.id}-${row.type}-${row.point}-${side}`, ...bet, ...ev2 });
    }
  }
  return entries;
}

/* ---- Player Analysis: projection context for a searched player who is on today's slate ---- */
function analysisCtx(analysisDetail, analysisSpot, analysisProfile) {
  const pid = String(analysisProfile.player.id);
  if (analysisSpot.kind === "hitter") {
    const rec = analysisDetail.hitters && analysisDetail.hitters[pid];
    return rec ? hitterCtx(analysisDetail, rec, pid) : null;
  }
  const g = analysisSpot.game;
  const isHome = analysisSpot.side === "home";
  const sp = isHome ? g.homeSP : g.awaySP;
  if (!sp || !analysisDetail.spStats || !analysisDetail.spStats[sp.id]) return null;
  return pitcherCtx(analysisDetail, sp, isHome);
}

/* ---- Trends: which players + props get trend cards for a loaded game ---- */
function trendSubjects(g, d) {
  const out = [];
  for (const pid in d.hitters) { const h = d.hitters[pid]; out.push({ player: h, pid, props: HITTER_PROPS, isHome: h.side === "home" }); }
  for (const sideKey of ["home", "away"]) {
    const sp = sideKey === "home" ? g.homeSP : g.awaySP;
    if (!sp) continue;
    out.push({ player: sp, pid: sp.id, props: PITCHER_PROPS, isHome: sideKey === "home" });
  }
  return out;
}

/* ---- settlement against MLB box scores (moved from App.settleBets / settleFullBoardLog) ---- */
function gradeLineResult(type, side, line, res) { return gradeLine(type, side, line, res.homeRuns, res.awayRuns); }
// tracked bet: DNP -> { status: "void", actual: "DNP" }; ungradeable -> null
function gradeTrackedProp(b, res) {
  const ps = res.players[b.playerId];
  const isPitcherProp = b.type === "Strikeouts" || b.type === "Outs";
  const participated = ps && (isPitcherProp ? ps.pitched : ps.batted);
  if (!participated) return { status: "void", actual: "DNP" }; // scratched / didn't play -> no action
  const actual = actualFor(b.type, ps);
  const st = gradeBet(b.side, parseFloat(b.line), actual);
  if (st == null) return null;
  return { status: st, actual };
}
// board-log candidate: DNP -> { status: "void", actual: null }
function gradeLogProp(e, res) {
  const ps = res.players[e.playerId] || res.players[Number(e.playerId)];
  const isPitcher = e.type === "Strikeouts" || e.type === "Outs";
  const participated = ps && (isPitcher ? ps.pitched : ps.batted);
  if (!participated) return { status: "void", actual: null };
  const actual = actualFor(e.type, ps);
  const status = gradeBet(e.side, parseFloat(String(e.line)), actual);
  if (status == null) return null;
  return { status, actual };
}

/* ---- manual bet draft from a Slate player ---- */
function draftCtx(d, g, kind, pid) {
  let ctx = null;
  if (d && d.ready) {
    if (kind === "hitter" && d.hitters[pid]) ctx = hitterCtx(d, d.hitters[pid], pid);
    else if (kind === "pitcher") { const isHome = g.homeSP && g.homeSP.id === pid; const sp = isHome ? g.homeSP : g.awaySP; if (sp && d.spStats[sp.id]) ctx = pitcherCtx(d, sp, isHome); }
  }
  return ctx;
}
const draftDefaults = (kind) => ({ type: kind === "pitcher" ? "Strikeouts" : "Hits", line: kind === "pitcher" ? "5.5" : "0.5" });
const propsForKind = (kind) => (kind === "pitcher" ? PITCHER_PROPS : HITTER_PROPS);

/* ---- Slate UI pieces ---- */
function GameSubtitle({ g }) {
  return <div className="text-[11px] text-slate-500 truncate">{(g.awaySP && g.awaySP.name) || "TBD"} vs {(g.homeSP && g.homeSP.name) || "TBD"}</div>;
}
function SlateDetail({ g, d, draftFromGame, goToAnalysis }) {
  return (
    <>
      <div className="flex flex-wrap gap-2 mt-3 text-[11px]" style={mono}>
        <Env label="PARK RF" v={d.park.rf.toFixed(2)} hot={d.park.rf >= 1.05} cold={d.park.rf <= 0.96} />
        <Env label="ELEV" v={`${d.park.elev}ft`} hot={d.park.elev >= 3000} />
        {d.park.dome && <Env label="DOME" v="yes" />}
        {d.weather && !d.park.dome && <Env label="TEMP" v={`${d.weather.temp}°`} hot={d.weather.temp >= 85} cold={d.weather.temp <= 60} />}
        {d.weather && !d.park.dome && <Env label="WIND" v={`${d.weather.wind}mph`} hot={d.weather.wind >= 12} />}
        {d.weather && !d.park.dome && <Env label="RAIN" v={`${d.weather.pop}%`} hot={d.weather.pop >= 50} />}
      </div>
      <div className="mt-3 bg-slate-950/60 border border-slate-800 rounded-lg p-3">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">MODEL GAME LINE</div>
        {(() => { const gp = gameProbs(d.lambdaH, d.lambdaA); return (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[13px]" style={mono}>
            <span className="text-slate-300">proj score <b className="text-sky-300">{g.away} {d.lambdaA.toFixed(1)} – {d.lambdaH.toFixed(1)} {g.home}</b></span>
            <span>{g.home} <b className="text-emerald-400">{pct(gp.home)}</b> <span className="text-slate-600">({probToAmerican(gp.home)})</span></span>
            <span>{g.away} <b className="text-emerald-400">{pct(gp.away)}</b> <span className="text-slate-600">({probToAmerican(gp.away)})</span></span>
            <span>total <b className="text-sky-300">{gp.totalLambda.toFixed(1)}</b></span>
          </div>); })()}
        <div className="text-[10px] text-slate-600 mt-1.5">model line from team run env × park (read-only) — compare to market for game edges once moneyline odds are wired in.</div>
      </div>
      <div className="grid sm:grid-cols-2 gap-3 mt-3">
        <LineupCol title={`${g.away} (away)`} g={g} lineup={g.awayLineup} d={d} onAdd={(pid) => draftFromGame(g, "hitter", pid, d.hitters[pid] && d.hitters[pid].name)} onPlayerClick={goToAnalysis} />
        <LineupCol title={`${g.home} (home)`} g={g} lineup={g.homeLineup} d={d} onAdd={(pid) => draftFromGame(g, "hitter", pid, d.hitters[pid] && d.hitters[pid].name)} onPlayerClick={goToAnalysis} />
      </div>
      <div className="grid sm:grid-cols-2 gap-3 mt-3">
        <SPCard label={`${g.away} SP`} sp={g.awaySP} st={g.awaySP && d.spStats[g.awaySP.id]} onAdd={() => g.awaySP && draftFromGame(g, "pitcher", g.awaySP.id, g.awaySP.name)} onPlayerClick={g.awaySP ? () => goToAnalysis(g.awaySP) : null} />
        <SPCard label={`${g.home} SP`} sp={g.homeSP} st={g.homeSP && d.spStats[g.homeSP.id]} onAdd={() => g.homeSP && draftFromGame(g, "pitcher", g.homeSP.id, g.homeSP.name)} onPlayerClick={g.homeSP ? () => goToAnalysis(g.homeSP) : null} />
      </div>
    </>
  );
}

const MLB = {
  id: "mlb",
  meta: {
    title: "MLB", emoji: "⚾", tagline: "live odds · de-vigged edge · Monte-Carlo props", league: "MLB",
    statsSource: "MLB Stats API", searchPlaceholder: "Mike Trout",
    analysisHint: "MLB-wide profile lookup. If the player is on the selected slate, this tab adds matchup context, model projections, and any pulled",
    csvPrefix: "mlb-edge-finder", boardLogCsvPrefix: "mlb-board-log", backupApp: "mlb-edge-finder",
    overrideTitle: "Per-market book overrides — e.g. pull Home Run odds from a different book than the rest of the board",
    diagnosticsType: "Home Run", diagnosticsMarketKey: "batter_home_runs",
    draftKindLabel: (kind) => (kind === "pitcher" ? "PITCHER" : "HITTER"),
    searchResultLine: (p) => `${p.teamAbbr || p.team || "FA"} · ${p.position || "—"} · bats ${p.bats || "—"} / throws ${p.throws || "—"}`,
  },
  config: { ALL_PROPS, BOOKS, BOOK_LABELS, CATEGORY_ORDER, DEFAULT_LINE, ODDS_TESTING_LIMIT, isLineType, matchesQuery, STAT_ORDER, TREND_PROPS },
  storage,
  api: { fetchSchedule, fetchOddsEvents, fetchEventOdds, matchEvent, oddsDebug, parseEventOdds, parseGameOdds, matchCurrentOdds, buildGameLineEntries, fetchGameResult, searchPlayers, fetchPlayerAnalysisProfile, findPlayerInSlate, buildTrendCard, getDeltaSignal },
  model: { projectProp },
  loadGameDetail, buildPropEntries, analysisCtx, trendSubjects, propsForKind,
  gradeLineResult, gradeTrackedProp, gradeLogProp, draftCtx, draftDefaults,
  ui: { Chip, ScoreLine, GameSubtitle, SlateDetail, BoardRow, MyBetRow, TrendCard, PlayerAnalysisIntro, PlayerProfilePanel },
};
export default MLB;
