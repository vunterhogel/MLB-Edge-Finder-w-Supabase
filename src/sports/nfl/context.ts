/* NFL game context: which players get priced, and the per-player ctx object the projection engine
   consumes. Moved verbatim from the old NFLApp component (loadDetail / playerCtx); shared by the adapter
   and the NFL UI so both build identical contexts. */
import { DST_PROPS, K_PROPS, QB_PROPS, RB_PROPS, WR_PROPS } from "./config";
import { LG } from "./engine";

export const posKey = (pos) => (pos === "PK" ? "K" : pos);
export const propsForPos = (pos) => pos === "QB" ? QB_PROPS : pos === "RB" ? RB_PROPS : (pos === "WR" || pos === "TE") ? WR_PROPS : pos === "K" ? K_PROPS : pos === "DST" ? DST_PROPS : [];
// every prop the model prices for a position (Anytime TD for anyone but K / DST), as the old page did
export const propsForKind = (pos) => [...propsForPos(posKey(pos)), ...(posKey(pos) !== "K" && posKey(pos) !== "DST" ? ["Anytime TD"] : [])];

export function featuredFromRosterAndDepth(roster, depth) {
  // Pick the players worth showing/pricing: starting QB, RB1-2, WR1-3, TE1, K1 (depth-chart rank),
  // falling back to roster order within each position group when a depth chart entry is missing —
  // NFL has no "posted lineup" the way MLB does, so the depth chart is the closest analog.
  const byPos = {};
  for (const p of roster) { (byPos[p.pos] = byPos[p.pos] || []).push(p); }
  const rankOf = (p) => (depth[p.id] ? depth[p.id].rank : 99);
  // depthConfirmed: whether the TOP pick in this position group actually came from
  // real depth-chart data (rank < 99), vs. fetchDepthChart returning nothing for this
  // team (network hiccup, missing data) and this "starter" really just being arbitrary
  // roster-listing order — surfaced to the UI instead of silently presenting either
  // case the same way.
  const pick = (pos, n) => {
    const sorted = (byPos[pos] || []).slice().sort((a, b) => rankOf(a) - rankOf(b)).slice(0, n);
    const topConfirmed = sorted.length === 0 || rankOf(sorted[0]) < 99;
    return sorted.map((p, i) => ({ ...p, depthRank: rankOf(p), depthConfirmed: i === 0 ? topConfirmed : true }));
  };
  return [...pick("QB", 1), ...pick("RB", 2), ...pick("WR", 3), ...pick("TE", 1), ...pick("PK", 1), ...pick("K", 1)];
}
export function playerCtx(d, g, side, p, logOverride = null) {
  const isHome = side === "home";
  const oppData = isHome ? d.away : d.home;
  // logOverride: Player Analysis for a player outside the featured set (old page fetched his log on
  // demand and used no prior-season log for him, which is kept here)
  const gl = logOverride || (d && d.logs ? d.logs[p.id] : null);
  const priorGl = !logOverride && d && d.priorLogs ? d.priorLogs[p.id] : null;
  const impliedTeamPts = isHome ? d.lambdaH : d.lambdaA;
  const marketSpread = g.marketSpreadHome != null ? (isHome ? g.marketSpreadHome : -g.marketSpreadHome) : null;
  const modelSpread = isHome ? (d.lambdaA - d.lambdaH) : (d.lambdaH - d.lambdaA); // signed FOR this team (positive = underdog)
  const teamSpread = marketSpread != null ? marketSpread : modelSpread;
  return {
    kind: p.pos === "PK" ? "K" : p.pos, // shell uses ctx.kind to pick the prop list; same value as pos
    pos: p.pos === "PK" ? "K" : p.pos,
    season: gl ? gl.season : null, recent: gl ? gl.recent : null, games: gl ? gl.games : null,
    // last season's real, complete log — the shrinkage prior once this-season sample is thin/empty
    // (fetched only when it's needed, see loadDetail). null for rookies / no data available.
    priorSeason: priorGl ? priorGl.season : null,
    teamSpread, weather: d.weather, stadium: d.stadium,
    injuryStatus: p.injuryStatus, depthRank: p.depthRank,
    impliedTeamPts, teamDrivesPerGame: 10.8, redZoneTdRate: 0.58,
    oppPassAtt: LG.teamPassAtt, teamSackRate: LG.sackRatePerPassAtt, teamDefIntRate: LG.defIntRatePerPassAtt,
    // opponent-allowed splits: wired from fetchTeamStats' real per-team pass/rush yards-allowed-
    // per-game (ESPN team statistics, already fetched into detail[pk].home/away.teamStats — this
    // was sitting unused). No position-granular split source is available yet (ESPN's generic team
    // stats endpoint doesn't break out "yards allowed to WRs" vs "to RBs"), so oppPassYdsAllowedToRB/
    // ToPos reuse the team-wide pass-defense number as the best available proxy: a leaky pass D
    // gives up more to everyone, RBs and WRs alike, even without a position-specific number. TD-
    // allowed and takeaway splits aren't in this endpoint's response — still neutral (1x) until a
    // source is added. See INTEGRATION.md "known v1 simplifications".
    oppPassYdsAllowed: (oppData.teamStats && oppData.teamStats.def && oppData.teamStats.def.netPassingYardsAllowedPerGame) || null,
    lgPassYdsAllowed: LG.passYdsAllowedPerGame,
    oppPassTdAllowed: null, lgPassTdAllowed: null,
    oppDefTakeaways: null, lgDefTakeaways: null,
    oppRushYdsAllowed: (oppData.teamStats && oppData.teamStats.def && oppData.teamStats.def.rushingYardsAllowedPerGame) || null,
    lgRushYdsAllowed: LG.rushYdsAllowedPerGame,
    oppRushTdAllowed: null, lgRushTdAllowed: null,
    oppPassYdsAllowedToRB: (oppData.teamStats && oppData.teamStats.def && oppData.teamStats.def.netPassingYardsAllowedPerGame) || null,
    lgPassYdsAllowedToRB: LG.passYdsAllowedPerGame,
    oppPassYdsAllowedToPos: (oppData.teamStats && oppData.teamStats.def && oppData.teamStats.def.netPassingYardsAllowedPerGame) || null,
    lgPassYdsAllowedToPos: LG.passYdsAllowedPerGame,
    oppPassTdAllowedToPos: null, lgPassTdAllowedToPos: null,
    oppSackRateAllowed: (oppData.teamStats && oppData.teamStats.def && oppData.teamStats.def.sackRate) || null, lgSackRateAllowed: LG.sackRatePerPassAtt,
    oppQbIntRate: null, lgQbIntRate: LG.intRate,
    touchShare: p.pos === "RB" ? (p.depthRank === 1 ? 0.55 : 0.25) : undefined,
    touchShareMult: 1, goalLineShareMult: p.depthRank === 1 ? 1.15 : 0.7, redZoneShareMult: 1,
    shortWeek: !!g.shortWeek, crossCountryTravel: !!g.crossCountryTravel, onBye: false,
    // v3: this team's matchup vs the opponent (matchups.ts). mx.def = what the opposing defense allows
    // per opportunity by position; mx.off = the opposing offense's sack / INT rates (DST). null -> v2.
    mx: d && d.matchups ? d.matchups[side] : null,
  };
}

export function rosterSpot(d, pid) {
  for (const side of ["home", "away"]) {
    const team = side === "home" ? d.home : d.away;
    const p = team.roster.find((x) => String(x.id) === String(pid));
    if (p) { const depth = team.depth[p.id]; return { side, p: { ...p, depthRank: depth ? depth.rank : 99 } }; }
  }
  return null;
}
// same ctx the old page built for the Player Analysis tab
export function analysisCtx(d, spot, profile) {
  const pid = String(profile.player.id);
  if (pid.startsWith("dst-")) return playerCtx(d, spot.game, spot.side, { id: pid, pos: "DST", name: profile.player.name });
  const hit = rosterSpot(d, pid);
  if (!hit) return null;
  const featured = (hit.side === "home" ? d.home : d.away).featured.find((x) => String(x.id) === pid);
  const p = featured || hit.p;
  return playerCtx(d, spot.game, hit.side, p, d.logs[pid] ? null : (profile.log || null));
}

