/* NFL opponent matchup inputs for the projection model (nfl-v3). Backend only: nothing here renders.

   Source: NFL Matchup Lab's published research snapshot (github.com/vunterhogel/NFL-Matchup-Lab,
   public/data/snapshot.json). Matchup Lab builds it from public nflverse play-by-play, rosters and
   schedules and keeps it as its own project; Edge Finder only reads the file. Every snapshot game
   carries its ESPN event id, which is Edge Finder's game id (g.pk), so a slate game joins exactly.

   For a game, each team's opponent is profiled the way Matchup Lab profiles a defense: final games
   whose kickoff AND completion are before this game's kickoff (Matchup Lab's cutoff rule), with
   rates built from summed numerators / denominators, never averages of game rates. Each rate is
   shrunk toward the league rate over the same games, using Matchup Lab's minimum sample for that
   metric as the prior weight, and returned as a multiplier (opponent rate / league rate).

   Refresh: the snapshot only changes when Matchup Lab's `npm run data:refresh` is run and pushed.
   If it can't be fetched, or the game isn't in it (postseason, another season), every multiplier
   is null and the engine keeps its v2 inputs for that game. */

export const MATCHUP_SNAPSHOT_URL = "https://raw.githubusercontent.com/vunterhogel/NFL-Matchup-Lab/main/public/data/snapshot.json";

let snapshotPromise = null;
export function loadMatchupSnapshot() {
  if (!snapshotPromise) {
    snapshotPromise = fetch(MATCHUP_SNAPSHOT_URL, { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => (s && Array.isArray(s.games) && Array.isArray(s.teamGames) ? indexSnapshot(s) : null))
      .catch(() => null);
    // a failed fetch is retried on the next game load instead of being cached for the session
    snapshotPromise.then((s) => { if (!s) snapshotPromise = null; });
  }
  return snapshotPromise;
}

function indexSnapshot(s) {
  const gameById = new Map(s.games.map((g) => [g.id, g]));
  const gameByEspn = new Map(s.games.filter((g) => g.espnId).map((g) => [String(g.espnId), g]));
  const posById = new Map((s.players || []).map((p) => [p.id, p.position === "FB" ? "RB" : p.position]));
  // player TDs folded into team-game rows (the team rows carry no TD fields)
  const tdByTeamGame = new Map();
  for (const pg of s.playerGames || []) {
    const pos = posById.get(pg.playerId);
    const k = `${pg.gameId}:${pg.teamId}`;
    const t = tdByTeamGame.get(k) || { passTd: 0, rbRushTd: 0, rbRecTd: 0, wrRecTd: 0, teRecTd: 0 };
    const st = pg.stats || {};
    t.passTd += st.passingTouchdowns || 0;
    if (pos === "RB") { t.rbRushTd += st.rushingTouchdowns || 0; t.rbRecTd += st.receivingTouchdowns || 0; }
    if (pos === "WR") t.wrRecTd += st.receivingTouchdowns || 0;
    if (pos === "TE") t.teRecTd += st.receivingTouchdowns || 0;
    tdByTeamGame.set(k, t);
  }
  const rows = s.teamGames.map((r) => ({ ...r, stats: { ...r.stats, ...(tdByTeamGame.get(`${r.gameId}:${r.teamId}`) || {}) } }));
  return { meta: s.meta, gameById, gameByEspn, rows, asOf: Date.parse(s.meta && s.meta.asOf) };
}

// rate = numerator / denominator; k = prior weight toward the league rate, in the denominator's units.
// Efficiency rates use Matchup Lab's minimum sample for the matching metric. TD and INT rates are
// rare events (Matchup Lab doesn't measure them), so they get a much heavier prior: a few plays
// can't swing them far. These are starting values; calibration from graded bets decides from here.
const RATES = {
  // what a DEFENSE allowed (summed over the opposing offenses' rows)
  compPct: ["completions", "attempts", 60],
  ypCmp: ["passingYards", "completions", 40],
  passTdRate: ["passTd", "attempts", 200],
  intRate: ["interceptions", "attempts", 250],
  rbYpc: ["rbRushYards", "rbCarries", 40],
  rbRushTdRate: ["rbRushTd", "rbCarries", 150],
  rbCatch: ["rbReceptions", "rbTargets", 15],
  rbYpt: ["rbReceivingYards", "rbTargets", 15],
  rbRecTdRate: ["rbRecTd", "rbTargets", 120],
  wrCatch: ["wrReceptions", "wrTargets", 40],
  wrYpt: ["wrReceivingYards", "wrTargets", 40],
  wrRecTdRate: ["wrRecTd", "wrTargets", 200],
  teCatch: ["teReceptions", "teTargets", 15],
  teYpt: ["teReceivingYards", "teTargets", 15],
  teRecTdRate: ["teRecTd", "teTargets", 120],
  // what an OFFENSE gave up to defenses (for DST props)
  sackRate: ["sacks", "dropbacks", 80],
  offIntRate: ["interceptions", "attempts", 250],
};
const DEF_KEYS = Object.keys(RATES).filter((k) => k !== "sackRate" && k !== "offIntRate");
const OFF_KEYS = ["sackRate", "offIntRate"];

const sum = (rows) => {
  const t = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.stats)) if (Number.isFinite(v)) t[k] = (t[k] || 0) + v;
  return t;
};
function multipliers(own, league, keys) {
  const out = {};
  for (const key of keys) {
    const [num, den, k] = RATES[key];
    const lgDen = league[den] || 0;
    if (!lgDen) { out[key] = null; continue; }
    const lg = (league[num] || 0) / lgDen;
    if (!lg) { out[key] = null; continue; }
    const shrunk = ((own[num] || 0) + k * lg) / ((own[den] || 0) + k);
    out[key] = shrunk / lg;
    out[`${key}N`] = own[den] || 0; // exposure behind the number
  }
  return out;
}

/* For one Edge Finder game: { home: { def, off }, away: { def, off }, meta }.
   home.def = how the AWAY team's defense treats the home offense (multipliers for home players);
   home.off = how the AWAY team's offense protects / turns it over (for the home DST). */
export function matchupInputs(snap, g) {
  if (!snap || !g) return null;
  const game = snap.gameByEspn.get(String(g.pk));
  if (!game) return null;
  const kickoff = Date.parse(game.kickoff);
  const cutoff = Math.min(Number.isFinite(kickoff) ? kickoff : Date.now(), snap.asOf || Infinity);
  const usable = (sg) => {
    if (sg.status !== "final") return false;
    const ko = Date.parse(sg.kickoff);
    const done = Date.parse(sg.completedAt || new Date(ko + 6 * 3600000).toISOString());
    return ko < cutoff && done < cutoff;
  };
  const rows = snap.rows.filter((r) => { const sg = snap.gameById.get(r.gameId); return sg && usable(sg); });
  const league = sum(rows);
  const games = new Set(rows.map((r) => r.gameId));
  if (!games.size) return null;
  const vsDefense = (teamId) => sum(rows.filter((r) => r.opponentId === teamId)); // offenses that faced this defense
  const ofOffense = (teamId) => sum(rows.filter((r) => r.teamId === teamId));
  const gamesFor = (teamId) => rows.filter((r) => r.teamId === teamId).length;
  const side = (oppId) => ({
    oppId, oppGames: gamesFor(oppId),
    def: multipliers(vsDefense(oppId), league, DEF_KEYS),
    off: multipliers(ofOffense(oppId), league, OFF_KEYS),
  });
  return {
    home: side(game.awayTeam), away: side(game.homeTeam),
    meta: { source: "NFL Matchup Lab", asOf: snap.meta && snap.meta.asOf, latestWeek: snap.meta && snap.meta.latestWeek, games: games.size, cutoff: new Date(cutoff).toISOString() },
  };
}
