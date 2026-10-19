import { ALL_PROPS, FIP_CONST, GAME_MARKETS, LG_KRATE, LG_RPG, MARKET_TO_TYPE, ODDS_SPORT, SAVANT_BASE, STATCAST_PROXY_BASE, STATCAST_SEASON_TTL_MS, TEAMS, TYPE_TO_MARKET } from "./config";
import { calibrateToMarket, ipToOuts, jointGameProbs, marginProb } from "./engine";
import { clamp, evPerUnit, impliedProb, probToAmerican } from "../../core/math";
import { normName, oddsProxyFetch, sideOf } from "../../core/odds";


/* ---------------------- statsapi ---------------------- */
export const SA = "https://statsapi.mlb.com/api/v1";
// statsapi game logs default to REGULAR SEASON ONLY. Ask for every game type so recent-form windows,
// pitcher workload and Trends include Wild Card / Division / LCS / World Series games.
// (Season-total stats stay regular season: bigger, more stable sample.)
export const ALL_GAME_TYPES = "R,F,D,L,W";
export const POSTSEASON_TYPES = ["F", "D", "L", "W"];
const byDate = (a, b) => Date.parse(a.date || "") - Date.parse(b.date || "");
export async function jget(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status}`); return r.json(); }
export async function fetchSchedule(date) {
  const d = await jget(`${SA}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,lineups,team,venue,linescore`);
  const games = (d.dates && d.dates[0] && d.dates[0].games) || [];
  return games.map(mapGame);
}
export function classify(g) {
  const st = g.status && g.status.abstractGameState, det = (g.status && g.status.detailedState) || "";
  if (st === "Final" || det.includes("Final") || det === "Game Over") return "FINAL";
  if (st === "Live" || det.includes("Progress") || det === "Warmup") return "LIVE";
  const hl = (g.lineups && g.lineups.homePlayers && g.lineups.homePlayers.length) || 0;
  const al = (g.lineups && g.lineups.awayPlayers && g.lineups.awayPlayers.length) || 0;
  if (hl >= 9 && al >= 9) return "POSTED";
  if (hl >= 9 || al >= 9) return "PARTIAL";
  if ((g.teams.home && g.teams.home.probablePitcher) || (g.teams.away && g.teams.away.probablePitcher)) return "PENDING";
  return "SCHEDULED";
}
export function mapGame(g) {
  const homeId = g.teams.home.team.id, awayId = g.teams.away.team.id;
  const rec = (t) => (t && t.leagueRecord ? `${t.leagueRecord.wins}-${t.leagueRecord.losses}` : "");
  const ls = g.linescore || {}; const num = (x) => (typeof x === "number" ? x : null);
  return {
    pk: g.gamePk, homeId, awayId,
    home: (TEAMS[homeId] && TEAMS[homeId].ab) || g.teams.home.team.abbreviation || "HOME",
    away: (TEAMS[awayId] && TEAMS[awayId].ab) || g.teams.away.team.abbreviation || "AWAY",
    homeName: (TEAMS[homeId] && TEAMS[homeId].name) || g.teams.home.team.name || "",
    awayName: (TEAMS[awayId] && TEAMS[awayId].name) || g.teams.away.team.name || "",
    homeRec: rec(g.teams.home), awayRec: rec(g.teams.away),
    time: g.gameDate ? new Date(g.gameDate).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "TBD",
    gameTimeIso: g.gameDate || null, // raw scheduled first-pitch timestamp — carried through to board log rows so the Parlay Builder can tell upcoming games from live/started ones
    venue: (g.venue && g.venue.name) || "",
    status: classify(g),
    homeScore: num(g.teams.home.score) ?? num(ls.teams && ls.teams.home && ls.teams.home.runs),
    awayScore: num(g.teams.away.score) ?? num(ls.teams && ls.teams.away && ls.teams.away.runs),
    inning: num(ls.currentInning), inningState: ls.inningState || ls.inningHalf || null, outs: num(ls.outs),
    homeSP: g.teams.home.probablePitcher ? { id: g.teams.home.probablePitcher.id, name: g.teams.home.probablePitcher.fullName } : null,
    awaySP: g.teams.away.probablePitcher ? { id: g.teams.away.probablePitcher.id, name: g.teams.away.probablePitcher.fullName } : null,
    homeLineup: ((g.lineups && g.lineups.homePlayers) || []).map((p) => ({ id: p.id, name: p.fullName })),
    awayLineup: ((g.lineups && g.lineups.awayPlayers) || []).map((p) => ({ id: p.id, name: p.fullName })),
    postseason: POSTSEASON_TYPES.includes(g.gameType),
    manual: false,
  };
}
export async function fetchHitterSeason(id, season) {
  const d = await jget(`${SA}/people/${id}/stats?stats=season&group=hitting&season=${season}`);
  const s = d.stats && d.stats[0] && d.stats[0].splits && d.stats[0].splits[0] && d.stats[0].splits[0].stat;
  if (!s) return null;
  return { g: +s.gamesPlayed || 0, ab: +s.atBats || 0, h: +s.hits || 0, hr: +s.homeRuns || 0, tb: +s.totalBases || 0, r: +s.runs || 0, rbi: +s.rbi || 0, bb: +s.baseOnBalls || 0, so: +s.strikeOuts || 0, pa: +s.plateAppearances || 0, avg: s.avg, obp: s.obp, slg: s.slg, ops: s.ops };
}
export async function fetchHitterLog(id, season, n = 15) {
  const d = await jget(`${SA}/people/${id}/stats?stats=gameLog&group=hitting&season=${season}&gameType=${ALL_GAME_TYPES}`);
  const sp = ((d.stats && d.stats[0] && d.stats[0].splits) || []).slice().sort(byDate).slice(-n);
  let ab = 0, h = 0, hr = 0, tb = 0, r = 0, rbi = 0;
  for (const x of sp) { ab += +x.stat.atBats || 0; h += +x.stat.hits || 0; hr += +x.stat.homeRuns || 0; tb += +x.stat.totalBases || 0; r += +x.stat.runs || 0; rbi += +x.stat.rbi || 0; }
  return { games: sp.length, ab, h, hr, tb, r, rbi, avg: ab ? h / ab : 0, ops: ab ? ((h / ab) + (tb / ab)) : 0 };
}
export async function fetchBvP(batterId, pitcherId, season) {
  try {
    const d = await jget(`${SA}/people/${batterId}/stats?stats=vsPlayer&group=hitting&opposingPlayerId=${pitcherId}&season=${season}&sportId=1`);
    const splits = (d.stats && d.stats[0] && d.stats[0].splits) || [];
    const tot = splits.find((s) => !s.season) || splits[splits.length - 1] || splits[0];
    const s = tot && tot.stat; if (!s) return null;
    return { ab: +s.atBats || 0, h: +s.hits || 0, hr: +s.homeRuns || 0, avg: s.avg };
  } catch { return null; }
}
// batter hand (L/R/S) and pitcher throwing hand (L/R) for a set of player ids, one call
export async function fetchHands(ids) {
  try {
    const d = await jget(`${SA}/people?personIds=${ids.join(",")}`);
    const out = {};
    for (const p of d.people || []) out[p.id] = { bats: (p.batSide && p.batSide.code) || null, throws: (p.pitchHand && p.pitchHand.code) || null };
    return out;
  } catch { return {}; }
}
// hitter's season line vs LHP and vs RHP (platoon splits)
export async function fetchHitterSplits(id, season) {
  try {
    const d = await jget(`${SA}/people/${id}/stats?stats=statSplits&sitCodes=vl,vr&group=hitting&season=${season}&sportId=1`);
    const splits = (d.stats && d.stats[0] && d.stats[0].splits) || [];
    const mk = (x) => ({
      ab: +x.stat.atBats || 0, h: +x.stat.hits || 0, tb: +x.stat.totalBases || 0,
      bb: +x.stat.baseOnBalls || 0, so: +x.stat.strikeOuts || 0, pa: +x.stat.plateAppearances || 0,
      hr: +x.stat.homeRuns || 0, obp: x.stat.obp || null, slg: x.stat.slg || null,
    });
    const byCode = (code) => splits.find((s) => (s.split && s.split.code === code) || s.sitCode === code);
    let vL = byCode("vl"), vR = byCode("vr");
    vL = vL ? mk(vL) : null; vR = vR ? mk(vR) : null;
    if (!vL && !vR && splits.length >= 2) { vL = mk(splits[0]); vR = mk(splits[1]); } // fallback: assume [vl, vr] order
    if (!vL && !vR) return null;
    return { vL, vR };
  } catch { return null; }
}
export async function fetchPitcherSplits(id, season) {
  try {
    const d = await jget(`${SA}/people/${id}/stats?stats=statSplits&sitCodes=vl,vr&group=pitching&season=${season}&sportId=1`);
    const splits = (d.stats && d.stats[0] && d.stats[0].splits) || [];
    const mk = (x) => ({
      bf: +x.stat.battersFaced || 0, so: +x.stat.strikeOuts || 0, bb: +x.stat.baseOnBalls || 0,
      ip: parseFloat(x.stat.inningsPitched) || 0, h: +x.stat.hits || 0,
      hr: +x.stat.homeRuns || 0, er: +x.stat.earnedRuns || 0, era: x.stat.era || null,
    });
    const byCode = (code) => splits.find((s) => (s.split && s.split.code === code) || s.sitCode === code);
    let vL = byCode("vl"), vR = byCode("vr");
    vL = vL ? mk(vL) : null; vR = vR ? mk(vR) : null;
    if (!vL && !vR && splits.length >= 2) { vL = mk(splits[0]); vR = mk(splits[1]); }
    if (!vL && !vR) return null;
    return { vL, vR };
  } catch { return null; }
}
export function mapSearchPlayer(p) {
  const team = p.currentTeam || {};
  const pos = p.primaryPosition || {};
  return {
    id: p.id,
    name: p.fullName || p.nameFirstLast || "",
    teamId: team.id || null,
    team: team.name || "",
    teamAbbr: team.id && TEAMS[team.id] ? TEAMS[team.id].ab : (team.abbreviation || ""),
    position: pos.abbreviation || pos.code || "",
    positionName: pos.name || "",
    bats: p.batSide && p.batSide.code ? p.batSide.code : null,
    throws: p.pitchHand && p.pitchHand.code ? p.pitchHand.code : null,
    active: p.active,
    height: p.height || "",
    weight: p.weight || "",
    birthDate: p.birthDate || "",
    debut: p.mlbDebutDate || "",
  };
}
export function likelyMlbPlayer(p) {
  return p && p.id && p.name && (p.team || p.position || p.active !== false);
}
export async function searchPlayers(q, season) {
  const query = String(q || "").trim();
  if (!query) return [];
  try {
    const d = await jget(`${SA}/people/search?names=${encodeURIComponent(query)}&sportIds=1&hydrate=currentTeam`);
    const people = (d.people || []).map(mapSearchPlayer).filter(likelyMlbPlayer);
    if (people.length) return people.slice(0, 12);
  } catch { /* fall through to active-player list */ }
  const d = await jget(`${SA}/sports/1/players?season=${season}&hydrate=currentTeam`);
  const nq = normName(query);
  return (d.people || [])
    .map(mapSearchPlayer)
    .filter((p) => likelyMlbPlayer(p) && normName(p.name).includes(nq))
    .slice(0, 12);
}
export async function fetchPlayerBio(id) {
  try {
    const d = await jget(`${SA}/people/${id}?hydrate=currentTeam`);
    const p = d.people && d.people[0];
    return p ? mapSearchPlayer(p) : null;
  } catch {
    try {
      const d = await jget(`${SA}/people?personIds=${id}&hydrate=currentTeam`);
      const p = d.people && d.people[0];
      return p ? mapSearchPlayer(p) : null;
    } catch { return null; }
  }
}
export function primaryPlayerKind(player, hitterSeason, pitcherSeason) {
  if (pitcherSeason && (!hitterSeason || (player && String(player.position).toUpperCase() === "P"))) return "pitcher";
  if (player && String(player.position).toUpperCase() === "P") return "pitcher";
  return "hitter";
}
export function displayRate(x) {
  if (x == null || !isFinite(x)) return "—";
  return Number(x).toFixed(3).replace(/^0/, "");
}
export function displayNum(x, d = 1) {
  if (x == null || !isFinite(x)) return "—";
  return Number(x).toFixed(d);
}
export function safeDiv(a, b) { return b ? a / b : null; }
export function outsToIp(outs) {
  if (outs == null || !isFinite(outs)) return "—";
  const o = Math.max(0, Math.round(outs));
  return `${Math.floor(o / 3)}.${o % 3}`;
}
export async function fetchPlayerGameLogs(id, season, group, n = 20) {
  try {
    const d = await jget(`${SA}/people/${id}/stats?stats=gameLog&group=${group}&season=${season}&gameType=${ALL_GAME_TYPES}`);
    const splits = ((d.stats && d.stats[0] && d.stats[0].splits) || [])
      .slice()
      .sort((a, b) => Date.parse(a.date || "") - Date.parse(b.date || ""))
      .slice(-n)
      .reverse();
    return splits.map((x) => ({
      date: x.date || "",
      gamePk: x.game && x.game.gamePk,
      opponent: (x.opponent && (x.opponent.abbreviation || x.opponent.name)) || "",
      homeAway: x.isHome ? "vs" : "@",
      stat: x.stat || {},
    }));
  } catch { return []; }
}
/* ---- Trends tab: pure hit-rate computation over a player's own gamelog rows (same mechanic as
   NFL/NBA — ported after NFL's debugging saga and NBA's clean port). Each row here is one game
   from fetchPlayerGameLogs, shaped { date, gamePk, opponent, homeAway: "vs"|"@", stat: {...} } —
   MLB's gamelog already carries opponent/home-away per row (unlike NFL/NBA's separate metadata
   dict), so no join step is needed; trendValueForGame reads straight off row.stat. */
export const TREND_PROPS = ALL_PROPS;
export function trendValueForGame(row, type) {
  const s = (row && row.stat) || {};
  if (type === "Hits") return +s.hits || 0;
  if (type === "Total Bases") return +s.totalBases || 0;
  if (type === "Home Run") return +s.homeRuns || 0;
  if (type === "H+R+RBI") return (+s.hits || 0) + (+s.runs || 0) + (+s.rbi || 0);
  if (type === "Strikeouts") return +s.strikeOuts || 0;
  if (type === "Outs") return ipToOuts(s.inningsPitched);
  return null;
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
// Builds one Trends card for a player+prop, given their already-fetched gamelog (`gl`, from
// loadDetail's gamelogs/priorGamelogs — no new fetch here). Sources the line from a matching Board
// entry when one exists (today's real pulled odds, zero additional Odds API cost); otherwise
// synthesizes a model-free round-number threshold from the player's own recent average, so Trends
// still works on a day with zero Odds API usage. `boardEntriesForGame` should already be
// pre-filtered to this one game.
export function buildTrendCard(p, pid, type, games, g, isHome, boardEntriesForGame, recentN) {
  if (!games || !games.length) return null;
  const oppAbbr = isHome ? g.away : g.home;
  const matches = boardEntriesForGame.filter((e) => String(e.playerId) === String(pid) && e.type === type);
  const chosen = matches.find((e) => e.side === "over") || matches.find((e) => e.side === "under") || null;
  let line, side, sourced, odds = null, boardEntryId = null;
  if (chosen) {
    line = parseFloat(chosen.line); side = chosen.side; sourced = "book"; odds = chosen.odds; boardEntryId = chosen.id;
  } else {
    const recentVals = games.slice(0, recentN).map((row) => trendValueForGame(row, type)).filter((v) => v != null);
    if (!recentVals.length) return null;
    const avg = recentVals.reduce((a, b) => a + b, 0) / recentVals.length;
    let synth = Math.floor(avg) + 0.5; if (synth > avg) synth -= 1;
    line = Math.max(0.5, synth); side = "over"; sourced = "model";
  }
  const recentGames = games.slice(0, recentN);
  const recentForm = hitRateFromGames(recentGames, type, line, side);
  const h2hGames = games.filter((row) => row.opponent === oppAbbr);
  const vsOpp = hitRateFromGames(h2hGames, type, line, side);
  const wantHomeAway = isHome ? "vs" : "@";
  const venueGames = games.filter((row) => row.homeAway === wantHomeAway);
  const homeAway = hitRateFromGames(venueGames, type, line, side);
  if (!recentForm.n && !vsOpp.n && !homeAway.n) return null;
  return {
    id: `${g.pk}-${pid}-${type}-${line}-${side}`, gamePk: g.pk, game: `${g.away}@${g.home}`,
    playerId: pid, name: p.name, type, line, side, sourced, odds, boardEntryId,
    recentForm, vsOpp, homeAway, opp: oppAbbr, isHome,
  };
}
export function aggregateHittingWindow(logs, n) {
  const rows = (logs || []).slice(0, n);
  let ab = 0, h = 0, hr = 0, tb = 0, r = 0, rbi = 0, bb = 0, so = 0, pa = 0;
  for (const x of rows) {
    const s = x.stat || {};
    ab += +s.atBats || 0; h += +s.hits || 0; hr += +s.homeRuns || 0; tb += +s.totalBases || 0;
    r += +s.runs || 0; rbi += +s.rbi || 0; bb += +s.baseOnBalls || 0; so += +s.strikeOuts || 0; pa += +s.plateAppearances || 0;
  }
  return { games: rows.length, ab, h, hr, tb, r, rbi, bb, so, pa, avg: safeDiv(h, ab), tbG: safeDiv(tb, rows.length), hrrG: safeDiv(h + r + rbi, rows.length), kRate: safeDiv(so, pa || ab + bb) };
}
export function aggregatePitchingWindow(logs, n) {
  const rows = (logs || []).slice(0, n);
  let outs = 0, so = 0, er = 0, h = 0, bb = 0, hr = 0, bf = 0;
  for (const x of rows) {
    const s = x.stat || {};
    outs += ipToOuts(s.inningsPitched);
    so += +s.strikeOuts || 0; er += +s.earnedRuns || 0; h += +s.hits || 0; bb += +s.baseOnBalls || 0; hr += +s.homeRuns || 0; bf += +s.battersFaced || 0;
  }
  return { games: rows.length, outs, ip: outs / 3, so, er, h, bb, hr, bf, era: outs ? er * 27 / outs : null, k9: outs ? so * 27 / outs : null, bb9: outs ? bb * 27 / outs : null };
}
export async function fetchPlayerAnalysisProfile(player, season, throughDate) {
  const id = player && player.id;
  if (!id) throw new Error("No player selected.");
  const [bio, hitterSeason, pitcherBase, hitterLogs, pitcherLogs, hitterSplits, pitcherRecentLog, pitcherSplits] = await Promise.all([
    fetchPlayerBio(id),
    fetchHitterSeason(id, season).catch(() => null),
    fetchPitcherSeason(id, season).catch(() => null),
    fetchPlayerGameLogs(id, season, "hitting", 20),
    fetchPlayerGameLogs(id, season, "pitching", 20),
    fetchHitterSplits(id, season).catch(() => null),
    fetchPitcherLog(id, season).catch(() => null),
    fetchPitcherSplits(id, season).catch(() => null),
  ]);
  const pitcherSeason = pitcherBase ? { ...pitcherBase } : null;
  if (pitcherSeason && pitcherRecentLog) {
    pitcherSeason.recentLog = pitcherRecentLog;
    pitcherSeason.expIp = expectedStartIP(pitcherSeason.ip, pitcherSeason.gs, pitcherSeason.gp, pitcherRecentLog);
  }
  const merged = { ...player, ...(bio || {}) };
  const kind = primaryPlayerKind(merged, hitterSeason, pitcherSeason);
  let statcastBatter = null, statcastPitcher = null;
  if (hitterSeason || kind === "hitter") statcastBatter = await fetchPlayerSeasonStatcast(id, "batter", season, throughDate).catch((e) => ({ verdict: `blocked:${e.message || "csv"}`, source: "savant_csv" }));
  if (pitcherSeason || kind === "pitcher") statcastPitcher = await fetchPlayerSeasonStatcast(id, "pitcher", season, throughDate).catch((e) => ({ verdict: `blocked:${e.message || "csv"}`, source: "savant_csv" }));
  return {
    player: merged,
    kind,
    hitterSeason,
    pitcherSeason,
    hitterLogs,
    pitcherLogs,
    hitterSplits,
    pitcherSplits,
    statcastBatter,
    statcastPitcher: attachPitcherHr9FromStatsApi(statcastPitcher, pitcherSeason),
    hittingWindows: [5, 10, 20].map((n) => ({ n, ...aggregateHittingWindow(hitterLogs, n) })),
    pitchingWindows: [5, 10, 20].map((n) => ({ n, ...aggregatePitchingWindow(pitcherLogs, n) })),
  };
}
export async function fetchPitcherSeason(id, season) {
  const d = await jget(`${SA}/people/${id}/stats?stats=season&group=pitching&season=${season}`);
  const s = d.stats && d.stats[0] && d.stats[0].splits && d.stats[0].splits[0] && d.stats[0].splits[0].stat;
  if (!s) return null;
  const ip = parseFloat(s.inningsPitched) || 0, gs = +s.gamesStarted || 0, gp = +s.gamesPlayed || 0, so = +s.strikeOuts || 0;
  const bb = +s.baseOnBalls || 0, bf = +s.battersFaced || 0, hrA = +s.homeRuns || 0, hbp = +s.hitBatsmen || 0, h = +s.hits || 0;
  const fip = ip ? ((13 * hrA + 3 * (bb + hbp) - 2 * so) / ip) + FIP_CONST : null; // skill-only run prevention, park/defense neutral
  return { era: s.era, so, bb, bf, hrA, h, ip, gs, gp, fip, k9: ip ? (so * 9 / ip) : 0, expIp: expectedStartIP(ip, gs, gp, null), role: pitcherRole(gs, gp) };
}
// Fetch a pitcher's last N starts (game log filtered to starts) to get a recent rolling IP/start.
// Mirrors the hitter L15 layer: season average is dragged down by early short starts / April ramp;
// recent starts reflect the pitcher's current mid-season workload. Falls back gracefully (null) if blocked.
export async function fetchPitcherLog(id, season, n = 5) {
  try {
    const d = await jget(`${SA}/people/${id}/stats?stats=gameLog&group=pitching&season=${season}&gameType=${ALL_GAME_TYPES}`);
    const splits = ((d.stats && d.stats[0] && d.stats[0].splits) || []).slice().sort(byDate)
      .filter((s) => +(s.stat.gamesStarted || 0) > 0)   // starts only
      .slice(-n);
    if (!splits.length) return null;
    const totalIp = splits.reduce((s, x) => s + (parseFloat(x.stat.inningsPitched) || 0), 0);
    const totalSo = splits.reduce((s, x) => s + (+x.stat.strikeOuts || 0), 0);
    // avgK = recent K/9 over last n starts — blended with season K/9 in calculateBaseProjection
    const avgK = totalIp > 0 ? (totalSo * 9) / totalIp : null;
    return { games: splits.length, avgIp: totalIp / splits.length, avgK };
  } catch { return null; }
}
export function expectedStartIP(ip, gs, gp, recentLog) {
  const perStart = gs > 0 ? ip / gs : 0;
  const reliefHeavy = gp > 0 && gs / gp < 0.6;
  // Layer 1 (8/27): override stale reliefHeavy flag when recent starts confirm genuine starter workload.
  // Swingmen who transitioned mid-season (Manaea-type) show gs/gp < 0.6 from early relief appearances,
  // but their last 3+ starts averaging 4.5+ IP prove they are now being used as starters.
  // Without this, the reliefHeavy branch hard-codes 4.0 IP → ~12 outs → blows the sanity cap on Outs.
  const recentlyStarting = !!(recentLog && recentLog.games >= 3 && recentLog.avgIp >= 4.5);
  let exp;
  if (recentlyStarting) {
    // Recent data is authoritative. For reliefHeavy pitchers use 5.0 as season anchor
    // (season per-start is dragged down by early relief stints); for true starters just use perStart.
    const anchor = reliefHeavy ? 5.0 : Math.max(perStart, 4.5);
    exp = 0.65 * recentLog.avgIp + 0.35 * anchor;   // 65% recent, 35% season anchor
  } else if (gs >= 4 && perStart >= 3 && perStart <= 7 && !reliefHeavy) {
    // Normal starter path: increased recent weight 30%→50% for mid-season responsiveness.
    const blendedPerStart = (recentLog && recentLog.games >= 3)
      ? 0.50 * perStart + 0.50 * recentLog.avgIp
      : perStart;
    exp = 0.60 * blendedPerStart + 0.40 * 6.10;
  } else if (reliefHeavy) {
    exp = 4.0;
  } else {
    exp = 5.0;
  }
  return clamp(exp, 2.5, 6.8);
}
export function pitcherRole(gs, gp) { if (gp > 0 && gs / gp < 0.6) return "swing"; if (gs >= 4) return "starter"; return "limited"; }
export async function fetchTeamRPG(teamId, season) {
  try {
    const h = await jget(`${SA}/teams/${teamId}/stats?stats=season&group=hitting&season=${season}&sportId=1`);
    const p = await jget(`${SA}/teams/${teamId}/stats?stats=season&group=pitching&season=${season}&sportId=1`);
    const hs = h.stats && h.stats[0] && h.stats[0].splits && h.stats[0].splits[0] && h.stats[0].splits[0].stat;
    const ps = p.stats && p.stats[0] && p.stats[0].splits && p.stats[0].splits[0] && p.stats[0].splits[0].stat;
    const gp = +(hs && hs.gamesPlayed) || 0, runs = +(hs && hs.runs) || 0;
    const pgp = +(ps && ps.gamesPlayed) || 0, ra = +(ps && ps.runs) || 0;
    const pa = +(hs && hs.plateAppearances) || +(hs && hs.atBats) || 0;
    const so = +(hs && hs.strikeOuts) || 0;                       // team's OWN offense K's
    return { rpg: gp ? runs / gp : LG_RPG, rapg: pgp ? ra / pgp : LG_RPG, kRate: pa ? so / pa : LG_KRATE };
  } catch { return { rpg: LG_RPG, rapg: LG_RPG, kRate: LG_KRATE }; }
}
export async function fetchWeather(lat, lon) {
  try {
    const d = await jget(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation_probability,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=2&timezone=auto`);
    const i = new Date().getHours(); const h = d.hourly;
    return { temp: Math.round(h.temperature_2m && h.temperature_2m[i]), pop: h.precipitation_probability && h.precipitation_probability[i], wind: Math.round(h.wind_speed_10m && h.wind_speed_10m[i]) };
  } catch { return null; }
}
export function parseBoxPlayers(box) {
  const players = {};
  for (const side of ["home", "away"]) {
    const pl = (box && box.teams && box.teams[side] && box.teams[side].players) || {};
    for (const key in pl) {
      const person = pl[key].person; if (!person) continue;
      const bat = (pl[key].stats && pl[key].stats.batting) || {};
      const pit = (pl[key].stats && pl[key].stats.pitching) || {};
      const hits = +bat.hits || 0, dbl = +bat.doubles || 0, tpl = +bat.triples || 0, hr = +bat.homeRuns || 0;
      const pa = +bat.plateAppearances || 0, ab = +bat.atBats || 0, r = +bat.runs || 0, rbi = +bat.rbi || 0;
      const bf = +pit.battersFaced || 0, outs = ipToOuts(pit.inningsPitched), k = +pit.strikeOuts || 0;
      players[person.id] = {
        h: hits, tb: hits + dbl + 2 * tpl + 3 * hr, r, rbi, hr, k, outs,
        batted: pa > 0 || ab > 0 || hits > 0 || r > 0 || rbi > 0,   // did the hitter actually appear?
        pitched: bf > 0 || outs > 0 || k > 0,                        // did the pitcher actually appear?
      };
    }
  }
  return players;
}
export async function fetchLiveBox(pk) { try { return parseBoxPlayers(await jget(`${SA}/game/${pk}/boxscore`)); } catch { return null; } }
export async function fetchGameResult(pk) {
  try {
    const d = await jget(`https://statsapi.mlb.com/api/v1.1/game/${pk}/feed/live`);
    const status = d.gameData && d.gameData.status && d.gameData.status.abstractGameState;
    const ls = (d.liveData && d.liveData.linescore) || {};
    const homeRuns = ls.teams && ls.teams.home ? ls.teams.home.runs : null;
    const awayRuns = ls.teams && ls.teams.away ? ls.teams.away.runs : null;
    return { final: status === "Final", players: parseBoxPlayers((d.liveData && d.liveData.boxscore) || {}), homeRuns, awayRuns };
  } catch { return { final: false, players: {}, homeRuns: null, awayRuns: null }; }
}

/* ---------------------- Baseball Savant / Statcast optional layer ---------------------- */
export function proxifyStatcast(url) { return STATCAST_PROXY_BASE ? `${STATCAST_PROXY_BASE}?url=${encodeURIComponent(url)}` : url; }
export function numOrNull(v) { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
export const STATCAST_KEYS = ["hit_speed", "hit_angle", "hit_distance", "xba", "estimated_ba", "start_speed", "spin_rate", "spinRate", "launch_speed", "launchSpeed", "launch_angle", "launchAngle"];
export function scanForKeys(obj, keys, found, depth = 0) {
  if (depth > 6 || obj == null || typeof obj !== "object") return;
  for (const k of Object.keys(obj)) {
    if (keys.includes(k) && obj[k] != null && obj[k] !== "") found.add(k);
    const v = obj[k];
    if (Array.isArray(v)) for (let i = 0; i < Math.min(v.length, 5); i++) scanForKeys(v[i], keys, found, depth + 1);
    else if (v && typeof v === "object") scanForKeys(v, keys, found, depth + 1);
  }
}
export function findBattedBallArray(feed) {
  if (Array.isArray(feed && feed.exit_velocity) && feed.exit_velocity.length) return feed.exit_velocity;
  let best = [];
  const visit = (o, depth) => {
    if (depth > 6 || o == null || typeof o !== "object") return;
    if (Array.isArray(o)) {
      const looksRight = o.some((it) => it && typeof it === "object" && ("hit_speed" in it || "xba" in it || "estimated_ba" in it || "launchSpeed" in it || "launch_speed" in it));
      if (looksRight && o.length > best.length) best = o;
      o.slice(0, 5).forEach((it) => visit(it, depth + 1));
    } else {
      for (const k of Object.keys(o)) visit(o[k], depth + 1);
    }
  };
  visit(feed, 0);
  return best;
}
export function extractBattedBalls(feed) {
  const arr = findBattedBallArray(feed);
  return arr.map((e) => ({
    batterId: numOrNull(e.batter ?? e.batter_id),
    batterName: e.batter_name ?? e.name ?? "",
    pitcherId: numOrNull(e.pitcher ?? e.pitcher_id),
    inning: numOrNull(e.inning),
    result: e.result ?? e.events ?? "",
    exitVelocity: numOrNull(e.hit_speed ?? e.launch_speed ?? e.launchSpeed),
    launchAngle: numOrNull(e.hit_angle ?? e.launch_angle ?? e.launchAngle),
    distance: numOrNull(e.hit_distance ?? e.total_distance ?? e.totalDistance),
    xba: numOrNull(e.xba ?? e.estimated_ba ?? e.xBA),
  })).filter((b) => b.batterId != null && (b.exitVelocity != null || b.launchAngle != null || b.xba != null));
}
export function verifyStatcast(feed) {
  if (!feed || typeof feed !== "object" || Object.keys(feed).length === 0) return { hasFeed: false, advancedFieldsFound: [], battedBallsWithExitVelo: 0, battedBallsWithXBA: 0, verdict: "empty" };
  const found = new Set(); scanForKeys(feed, STATCAST_KEYS, found, 0);
  const balls = extractBattedBalls(feed);
  const withEV = balls.filter((b) => b.exitVelocity != null).length;
  const withXBA = balls.filter((b) => b.xba != null).length;
  const verdict = withXBA > 0 ? "statcast_confirmed" : (withEV > 0 || found.size > 0 ? "tracking_only" : "boxscore_only");
  return { hasFeed: true, advancedFieldsFound: Array.from(found), battedBallsWithExitVelo: withEV, battedBallsWithXBA: withXBA, sample: balls[0], verdict };
}
export function aggregateStatcastByBatter(battedBalls) {
  const out = {};
  for (const b of battedBalls || []) {
    if (b.batterId == null) continue;
    const id = String(b.batterId);
    const r = out[id] || { bbe: 0, withXBA: 0, xbaSum: 0, withEV: 0, evSum: 0, hardHit: 0, barrelish: 0, balls: [] };
    r.bbe += 1; r.balls.push(b);
    if (b.xba != null) { r.withXBA += 1; r.xbaSum += b.xba; }
    if (b.exitVelocity != null) { r.withEV += 1; r.evSum += b.exitVelocity; if (b.exitVelocity >= 95) r.hardHit += 1; }
    if (b.exitVelocity != null && b.launchAngle != null && b.exitVelocity >= 98 && b.launchAngle >= 8 && b.launchAngle <= 32) r.barrelish += 1;
    out[id] = r;
  }
  for (const id in out) {
    const r = out[id];
    r.avgXBA = r.withXBA ? r.xbaSum / r.withXBA : null;
    r.avgEV = r.withEV ? r.evSum / r.withEV : null;
    r.hardHitRate = r.withEV ? r.hardHit / r.withEV : null;
    r.barrelishRate = r.bbe ? r.barrelish / r.bbe : null;
  }
  return out;
}
export async function fetchGameStatcast(gamePk) {
  const url = `${SAVANT_BASE}/gf?game_pk=${gamePk}`;
  const feed = await jget(proxifyStatcast(url));
  const battedBalls = extractBattedBalls(feed);
  const verification = verifyStatcast(feed);
  return { gamePk, verification, battedBalls, byBatter: aggregateStatcastByBatter(battedBalls) };
}
export function emptyStatcast(reason = "not_fetched") { return { verification: { hasFeed: false, advancedFieldsFound: [], battedBallsWithExitVelo: 0, battedBallsWithXBA: 0, verdict: reason }, battedBalls: [], byBatter: {} }; }


export function statcastCacheGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.ts || Date.now() - obj.ts > STATCAST_SEASON_TTL_MS) return null;
    return obj.data || null;
  } catch { return null; }
}
export function statcastCacheSet(key, data) { try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch {} }
export function csvCell(v) { return v == null ? "" : String(v); }
export function parseCsv(text) {
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
export function seasonStartFor(year) { return `${year}-03-01`; }
export function todayISO() { return new Date().toISOString().slice(0, 10); }
export function statcastSearchUrl({ playerId, playerType, startDate, endDate }) {
  const lookup = playerType === "pitcher" ? `pitchers_lookup%5B%5D=${encodeURIComponent(playerId)}` : `batters_lookup%5B%5D=${encodeURIComponent(playerId)}`;
  return `${SAVANT_BASE}/statcast_search/csv?all=true&hfPT=&hfAB=&hfBBT=&hfPR=&hfZ=&stadium=&hfBBL=&hfNewZones=&hfGT=R%7C&hfSea=&hfSit=&player_type=${playerType}&hfOuts=&opponent=&pitcher_throws=&batter_stands=&hfSA=&game_date_gt=${startDate}&game_date_lt=${endDate}&${lookup}&team=&position=&hfRO=&home_road=&hfFlag=&metric_1=&hfInn=&min_pitches=0&min_results=0&group_by=name&sort_col=pitches&player_event_sort=h_launch_speed&sort_order=desc&min_abs=0&type=details&`;
}
export function isBattedBall(row) { return row && row.type === "X" && (row.launch_speed !== "" || row.launch_angle !== "" || row.bb_type !== ""); }
export function isWhiff(desc) { desc = String(desc || "").toLowerCase(); return desc.includes("swinging_strike") || desc.includes("swinging strike") || desc.includes("foul_tip") || desc.includes("foul tip"); }
export function isCalledOrWhiff(desc) { desc = String(desc || "").toLowerCase(); return isWhiff(desc) || desc.includes("called_strike") || desc.includes("called strike"); }
export function aggregateSeasonStatcast(rows, playerType) {
  let pitches = 0, bbe = 0, evN = 0, evSum = 0, xbaN = 0, xbaSum = 0, xwN = 0, xwSum = 0;
  let hard = 0, barrels = 0, fb = 0, pullFb = 0, hr = 0, whiff = 0, csw = 0;
  for (const r of rows || []) {
    pitches += 1;
    const desc = r.description || "";
    if (isWhiff(desc)) whiff += 1;
    if (isCalledOrWhiff(desc)) csw += 1;
    const ev = numOrNull(r.launch_speed), la = numOrNull(r.launch_angle), lsa = numOrNull(r.launch_speed_angle);
    const xba = numOrNull(r.estimated_ba_using_speedangle), xw = numOrNull(r.estimated_woba_using_speedangle);
    const bbType = String(r.bb_type || "");
    const events = String(r.events || "").toLowerCase();
    if (events === "home_run") hr += 1;
    if (isBattedBall(r)) {
      bbe += 1;
      if (ev != null) { evN += 1; evSum += ev; if (ev >= 95) hard += 1; }
      if (xba != null) { xbaN += 1; xbaSum += xba; }
      if (xw != null) { xwN += 1; xwSum += xw; }
      if (lsa === 6) barrels += 1;
      // Conservative fallback barrel detector when launch_speed_angle is absent.
      else if (ev != null && la != null && ev >= 98 && la >= 8 && la <= 32) barrels += 1;
      const isAir = bbType === "fly_ball" || bbType === "popup";
      if (isAir) {
        fb += 1;
        const stand = String(r.stand || "").toUpperCase();
        const hcX = numOrNull(r.hc_x);
        // Savant hit coordinates are not a perfect spray-angle feed; this is only a light pull/air proxy.
        if (hcX != null && ((stand === "R" && hcX < 125) || (stand === "L" && hcX > 125))) pullFb += 1;
      }
    }
  }
  const base = {
    verdict: bbe > 0 ? "season_confirmed" : (pitches > 0 ? "tracking_only" : "empty"),
    source: "savant_csv", playerType, pitches, bbe,
    avgEV: evN ? evSum / evN : null,
    hardHitRate: evN ? hard / evN : null,
    barrelRate: bbe ? barrels / bbe : null,
    fbRate: bbe ? fb / bbe : null,
    pullFbRate: bbe ? pullFb / bbe : null,
    xba: xbaN ? xbaSum / xbaN : null,
    xwoba: xwN ? xwSum / xwN : null,
    whiffRate: pitches ? whiff / pitches : null,
    cswRate: pitches ? csw / pitches : null,
  };
  if (playerType === "pitcher") {
    base.xwobaAllowed = base.xwoba;
    base.barrelAllowedRate = base.barrelRate;
    base.hardHitAllowedRate = base.hardHitRate;
    base.hrAllowed = hr;
  }
  return base;
}
export async function fetchPlayerSeasonStatcast(playerId, playerType, season, throughDate) {
  if (!playerId) return { verdict: "empty", source: "none" };
  const endDate = throughDate || todayISO();
  const startDate = seasonStartFor(season || endDate.slice(0, 4));
  const key = `mlbEF:statcastSeason:v2:${playerType}:${playerId}:${startDate}:${endDate}`;
  const cached = statcastCacheGet(key); if (cached) return { ...cached, cached: true };
  try {
    const url = statcastSearchUrl({ playerId, playerType, startDate, endDate });
    const res = await fetch(proxifyStatcast(url));
    if (!res.ok) throw new Error(`csv ${res.status}`);
    const txt = await res.text();
    const rows = parseCsv(txt);
    if (rows.length && rows[0].error) throw new Error(rows[0].error);
    const data = aggregateSeasonStatcast(rows, playerType);
    data.rows = rows.length; data.cached = false;
    statcastCacheSet(key, data);
    return data;
  } catch (e) {
    return { verdict: `blocked:${e.message || "csv"}`, source: "savant_csv", playerType, pitches: 0, bbe: 0 };
  }
}
/* ---- Season Statcast via league LEADERBOARDS (hitters) ----
   One daily pull of two batter leaderboards covers every qualified hitter,
   replacing ~18 per-player pitch-dump downloads per game. Column-tolerant, so a
   minor header rename won't break it. Players below the leaderboard minimum (or
   not yet listed) fall back to the per-player CSV path. If the leaderboard fetch
   is CORS-blocked, every hitter falls back too -> identical to current behavior,
   never worse. Pitchers stay on the per-player path to keep whiff%/CSW%. */
   export function statcastLeaderboardUrl(board, type, year) {
    // board: "expected_statistics" | "statcast" (exit velocity & barrels)
    return `${SAVANT_BASE}/leaderboard/${board}?type=${type}&year=${year}&position=&team=&min=1&csv=true`;
  }
  export function lbPick(row, candidates) {
    for (const c of candidates) if (row[c] !== undefined && row[c] !== "") return row[c];
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
    const keys = Object.keys(row);
    for (const c of candidates) { const want = norm(c); const hit = keys.find((k) => norm(k) === want); if (hit && row[hit] !== "") return row[hit]; }
    return null;
  }
  export function lbPctToFraction(v) { const n = numOrNull(v); if (n == null) return null; return n > 1.5 ? n / 100 : n; } // boards give 0-100
  export function mergeLeaderboard(store, rows, board) {
    for (const r of rows || []) {
      const id = numOrNull(lbPick(r, ["player_id", "playerid", "entity_id", "mlbam_id", "id"]));
      if (id == null) continue;
      const k = String(id);
      const rec = store[k] || { id, source: "savant_leaderboard" };
      if (board === "expected_statistics") {
        rec.xba = numOrNull(lbPick(r, ["est_ba", "xba", "estimated_ba", "expected_ba"]));
        rec.xwoba = numOrNull(lbPick(r, ["est_woba", "xwoba", "estimated_woba", "expected_woba"]));
        rec.pa = numOrNull(lbPick(r, ["pa", "plate_appearances"]));
        rec.bip = numOrNull(lbPick(r, ["bip", "batted_balls", "balls_in_play"]));
      } else { // exit velocity & barrels
        rec.avgEV = numOrNull(lbPick(r, ["avg_hit_speed", "avg_ev", "avg_exit_velocity", "exit_velocity_avg"]));
        rec.attempts = numOrNull(lbPick(r, ["attempts", "bbe", "batted_balls", "total_bip"]));
        rec.hardHitRate = lbPctToFraction(lbPick(r, ["ev95percent", "ev95per", "hard_hit_percent", "hardhit_percent", "hard_hit_rate"]));
        rec.barrelRate = lbPctToFraction(lbPick(r, ["brl_percent", "barrels_per_bbe_percent", "barrel_batted_rate", "barrel_percent"]));
      }
      store[k] = rec;
    }
  }
  export async function fetchHitterStatcastLeaderboards(season) {
    const yr = String(season || todayISO().slice(0, 4));
    const cacheKey = `mlbEF:statcastLB:v1:batter:${yr}`;            // shares the 6h TTL via statcastCacheGet
    const cached = statcastCacheGet(cacheKey);
    if (cached) return cached;
    const store = {};
    const boards = ["expected_statistics", "statcast"];           // xBA/xwOBA, then EV/hard-hit/barrel
    const results = await Promise.allSettled(boards.map(async (board) => {
      const res = await fetch(proxifyStatcast(statcastLeaderboardUrl(board, "batter", yr)));
      if (!res.ok) throw new Error(`${board} ${res.status}`);
      const rows = parseCsv(await res.text());
      if (rows.length && rows[0].error) throw new Error(rows[0].error);
      mergeLeaderboard(store, rows, board);
      return board;
    }));
    const ok = results.some((r) => r.status === "fulfilled") && Object.keys(store).length > 0;
    const bundle = { batter: store, ok, fetchedAt: Date.now(), errors: results.filter((r) => r.status === "rejected").map((r) => String((r.reason && r.reason.message) || r.reason)) };
    if (ok) statcastCacheSet(cacheKey, bundle);
    return bundle;
  }
  export function lbToSeasonStatcast(rec) {
    const bbe = rec.attempts != null ? rec.attempts : (rec.bip != null ? rec.bip : 0);
    return {
      verdict: (rec.xba != null || rec.xwoba != null || rec.avgEV != null) ? "season_confirmed" : "empty",
      source: "savant_leaderboard", playerType: "batter",
      pitches: rec.pa != null ? Math.round(rec.pa * 3.9) : 0,
      bbe,
      avgEV: rec.avgEV != null ? rec.avgEV : null,
      hardHitRate: rec.hardHitRate != null ? rec.hardHitRate : null,
      barrelRate: rec.barrelRate != null ? rec.barrelRate : null,
      fbRate: null, pullFbRate: null,                              // not on these boards -> HR mult uses HH/barrel only
      xba: rec.xba != null ? rec.xba : null,
      xwoba: rec.xwoba != null ? rec.xwoba : null,
      whiffRate: null, cswRate: null,
      cached: true,
    };
  }
  export async function resolveHitterSeasonStatcast(lb, playerId, season, throughDate) {
    const rec = lb && lb.batter && lb.batter[String(playerId)];
    if (rec && (rec.xba != null || rec.xwoba != null || rec.avgEV != null)) return lbToSeasonStatcast(rec);
    return fetchPlayerSeasonStatcast(playerId, "batter", season, throughDate); // fallback: below min / not listed / board blocked
  }
export function attachPitcherHr9FromStatsApi(sc, seasonStats) {
  if (!sc || !seasonStats) return sc;
  const ip = seasonStats.ip || 0;
  return { ...sc, hr9: ip ? ((seasonStats.hrA || 0) * 9 / ip) : null };
}
export function statcastCoverageSummary(hitters, spStats, liveStatcast) {
  const hs = Object.values(hitters || {}).map((h) => h.statcastSeason).filter(Boolean);
  const ps = Object.values(spStats || {}).map((p) => p && p.statcastSeason).filter(Boolean);
  const confirmedH = hs.filter((x) => x.verdict === "season_confirmed").length;
  const confirmedP = ps.filter((x) => x.verdict === "season_confirmed").length;
  const lbH = hs.filter((x) => x.source === "savant_leaderboard").length;
  const ppH = hs.filter((x) => x.source === "savant_csv").length;
  const lbP = ps.filter((x) => x.source === "savant_leaderboard").length;
  const ppP = ps.filter((x) => x.source === "savant_csv").length;
  const totalXBA = hs.reduce((a, x) => a + (x.xba != null ? x.bbe || 0 : 0), 0);
  const totalEV = hs.reduce((a, x) => a + (x.avgEV != null ? x.bbe || 0 : 0), 0) + ps.reduce((a, x) => a + (x.avgEV != null ? x.bbe || 0 : 0), 0);
  const liveVerdict = liveStatcast && liveStatcast.verification ? liveStatcast.verification.verdict : "not_fetched";
  const verdict = confirmedH || confirmedP ? "season_confirmed" : liveVerdict;
  const sources = `hitters LB ${lbH}/perPlayer ${ppH} · SP perPlayer ${ppP}${lbP ? `/LB ${lbP}` : ""}`;
  return { hasFeed: !!(confirmedH || confirmedP), verdict, sources, advancedFieldsFound: ["launch_speed", "launch_angle", "estimated_ba_using_speedangle", "estimated_woba_using_speedangle", "launch_speed_angle", "bb_type"], battedBallsWithExitVelo: totalEV, battedBallsWithXBA: totalXBA, seasonHitters: `${confirmedH}/${hs.length}`, seasonPitchers: `${confirmedP}/${ps.length}`, liveVerdict };
}
export async function fetchOddsEvents() {
  const r = await oddsProxyFetch(`/sports/${ODDS_SPORT}/events`, "dateFormat=iso");
  const remaining = r.headers.get("x-requests-remaining");
  if (!r.ok) throw new Error(`events ${r.status}`);
  const data = await r.json();
  return { events: data || [], remaining: remaining != null ? +remaining : null };
}
export async function fetchEventOdds(eventId, book) {
  const markets = [...Object.values(TYPE_TO_MARKET), ...GAME_MARKETS].join(","); // props + moneyline/run line/total
  const r = await oddsProxyFetch(`/sports/${ODDS_SPORT}/events/${eventId}/odds`, `regions=us&markets=${markets}&oddsFormat=american&bookmakers=${book}`);
  const remaining = r.headers.get("x-requests-remaining");
  if (!r.ok) throw new Error(`odds ${r.status}`);
  const data = await r.json();
  return { data, remaining: remaining != null ? +remaining : null };
}
export function matchEvent(events, g) {
  const hn = normName(g.homeName), an = normName(g.awayName);
  return (events || []).find((e) => normName(e.home_team).includes(hn) && normName(e.away_team).includes(an));
}
export function parseEventOdds(data, bookKey) {
  const bm = (data.bookmakers || []).find((b) => b.key === bookKey) || (data.bookmakers || [])[0];
  if (!bm) return [];
  const rows = [];
  for (const mk of bm.markets || []) {
    const type = MARKET_TO_TYPE[mk.key]; if (!type) continue;
    const byKey = {};
    for (const o of mk.outcomes || []) {
      let side = sideOf(o.name), player = o.description;
      if (!side && sideOf(o.description)) { side = sideOf(o.description); player = o.name; }   // fields flipped
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
// game lines (moneyline / run line / total) for the chosen book
export function parseGameOdds(data, bookKey, g) {
  const bm = (data.bookmakers || []).find((b) => b.key === bookKey) || (data.bookmakers || [])[0];
  if (!bm) return {};
  const hn = normName(g.homeName), an = normName(g.awayName);
  const out = {};
  for (const mk of bm.markets || []) {
    if (mk.key === "h2h") {
      out.h2h = {};
      for (const o of mk.outcomes || []) { const nm = normName(o.name); if (hn && nm.includes(hn)) out.h2h.home = o.price; else if (an && nm.includes(an)) out.h2h.away = o.price; }
    } else if (mk.key === "totals") {
      out.totals = {};
      for (const o of mk.outcomes || []) { const s = (o.name || "").toLowerCase(); if (o.point != null) out.totals.point = o.point; if (s === "over") out.totals.over = o.price; else if (s === "under") out.totals.under = o.price; }
    } else if (mk.key === "spreads") {
      out.spreads = {};
      for (const o of mk.outcomes || []) { const nm = normName(o.name); if (hn && nm.includes(hn)) { out.spreads.homePoint = o.point; out.spreads.home = o.price; } else if (an && nm.includes(an)) { out.spreads.awayPoint = o.point; out.spreads.away = o.price; } }
    }
  }
  return out;
}
// match a tracked bet to its current price from freshly-pulled odds (props rows + game lines gl)
export function matchCurrentOdds(bet, rows, gl) {
  const t = bet.type, ln = Number(bet.line);
  if (t === "Moneyline") return gl && gl.h2h ? (bet.side === "home" ? gl.h2h.home : gl.h2h.away) ?? null : null;
  if (t === "Total") { if (!gl || !gl.totals || gl.totals.point == null || Math.abs(gl.totals.point - ln) > 1e-6) return null; return (bet.side === "over" ? gl.totals.over : gl.totals.under) ?? null; }
  if (t === "Run Line") { if (!gl || !gl.spreads) return null; const pt = bet.side === "home" ? gl.spreads.homePoint : gl.spreads.awayPoint; if (pt == null || Math.abs(pt - ln) > 1e-6) return null; return (bet.side === "home" ? gl.spreads.home : gl.spreads.away) ?? null; }
  const bn = normName(bet.name);
  const r = (rows || []).find((x) => x.type === t && normName(x.player) === bn && Math.abs(x.point - ln) < 1e-6);
  if (!r) return null;
  return (bet.side === "over" ? r.over : r.under) ?? null;
}
// build moneyline / total / run-line board entries from our model + market odds
export function buildGameLineEntries(g, d, gl, book) {
  const entries = [];
  const lambdaH = d.lambdaH, lambdaA = d.lambdaA;
  const liveFr = (d.live && d.live.fractionRemaining != null) ? d.live.fractionRemaining : null;
  const isLive = liveFr != null && g.homeScore != null && g.awayScore != null;
  const hc = isLive ? g.homeScore : 0, ac = isLive ? g.awayScore : 0;       // current runs
  const lhEff = isLive ? lambdaH * liveFr : lambdaH;                        // remaining run expectancy
  const laEff = isLive ? lambdaA * liveFr : lambdaA;
  const projH = hc + lhEff, projA = ac + laEff;                            // projected FINAL runs
  const total = projH + projA;
  const totalPt = gl.totals && gl.totals.point != null ? gl.totals.point : null;
  const gp = jointGameProbs(lhEff, laEff, hc, ac, totalPt);
  const base = `model line: ${g.away} ${projA.toFixed(1)} – ${projH.toFixed(1)} ${g.home}${isLive ? ` · LIVE ${(liveFr * 100).toFixed(0)}% left, score ${ac}-${hc}` : ""}`;
  const mk = (name, type, line, side, odds, oppOdds, modelP0, proj, params) => {
    if (odds == null) return null;
    const imp = impliedProb(odds);
    const novig = oppOdds != null ? (imp / (imp + impliedProb(oppOdds))) : imp;
    const modelP = calibrateToMarket(modelP0, novig, type);
    const bm = odds > 0 ? odds / 100 : 100 / -odds;
    return {
      id: `${g.pk}-line-${type}-${side}`, gamePk: g.pk, game: `${g.away}@${g.home}`, gameTimeIso: g.gameTimeIso || null, name, type, line: String(line), side, odds, overOdds: null, underOdds: null, book,
      modelP, rawModelP: modelP0, proj, calc: { dist: isLive ? "Two-Poisson · live" : "Two-Poisson", params, proj, baseStr: base, mults: [], live: null },
      imp, novig, edge: modelP - novig, ev: evPerUnit(modelP, odds), b: bm, fair: probToAmerican(modelP), devigged: oppOdds != null,
    };
  };
  if (gl.h2h) {
    const e1 = mk(`${g.home} ML`, "Moneyline", "", "home", gl.h2h.home, gl.h2h.away, gp.home, projH, "P(home win)");
    const e2 = mk(`${g.away} ML`, "Moneyline", "", "away", gl.h2h.away, gl.h2h.home, gp.away, projA, "P(away win)");
    if (e1) entries.push(e1); if (e2) entries.push(e2);
  }
  if (totalPt != null) {
    const pt = totalPt;
    const e1 = mk(`Total ${pt}`, "Total", pt, "over", gl.totals.over, gl.totals.under, gp.over, total, `P(final total>${pt})`);
    const e2 = mk(`Total ${pt}`, "Total", pt, "under", gl.totals.under, gl.totals.over, gp.under, total, `P(final total<${pt})`);
    if (e1) entries.push(e1); if (e2) entries.push(e2);
  }
  if (gl.spreads && gl.spreads.homePoint != null) {
    const hp = gl.spreads.homePoint, ap = gl.spreads.awayPoint;
    // home covers hp if (home final - away final) > -hp ; away covers ap if margin < ap
    const pHome = marginProb(lhEff, laEff, hc, ac, (m) => m > -hp);
    const pAway = ap != null ? marginProb(lhEff, laEff, hc, ac, (m) => m < ap) : 1 - pHome;
    const e1 = mk(`${g.home} ${hp > 0 ? "+" : ""}${hp}`, "Run Line", hp, "home", gl.spreads.home, gl.spreads.away, pHome, projH - projA, `P(home margin > ${-hp})`);
    const e2 = mk(`${g.away} ${ap > 0 ? "+" : ""}${ap}`, "Run Line", ap, "away", gl.spreads.away, gl.spreads.home, pAway, projA - projH, `P(home margin < ${ap})`);
    if (e1) entries.push(e1); if (e2) entries.push(e2);
  }
  return entries;
}
// raw diagnostic: which books + market keys the API actually returned, and a HR sample
export function oddsDebug(data, bookKey) {
  const bms = data.bookmakers || [];
  const bm = bms.find((b) => b.key === bookKey) || bms[0];
  const rawKeys = bm ? (bm.markets || []).map((m) => m.key) : [];
  const hrMk = bm && (bm.markets || []).find((m) => m.key === "batter_home_runs");
  const hrSample = hrMk && hrMk.outcomes && hrMk.outcomes[0] ? hrMk.outcomes[0] : null;
  return { books: bms.map((b) => b.key), usedBook: bm ? bm.key : null, rawKeys, hasHR: !!hrMk, hrSample };
}
