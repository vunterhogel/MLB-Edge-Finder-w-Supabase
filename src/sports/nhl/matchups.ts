/* NHL opponent matchup inputs by position (nhl-v2). Backend only: nothing here renders.

   Source: sportsdataverse public NHL box scores (player_box_{season}, NHL's own data), read as a compact
   parquet season file through Edge Finder's own proxy and cached 6 hours. For each defense: shots on
   goal and goals its opponents' forwards and defensemen produced per game, shrunk 10 games toward the
   league per-position rate, as a multiplier (opponent / league). Regular-season games before this
   game's date only. Validated by replaying the 2025-26 season (see NHL notes in engine.ts). If the
   file can't load or a team can't be matched, the engine uses the team-level opponent factor instead. */
import { cacheGet, cacheSet, fetchViaProxy, readParquet } from "../../core/dataProxy";

const URL = (season) => `https://github.com/sportsdataverse/sportsdataverse-data/releases/download/nhl_player_boxscores/player_box_${season}.parquet`;
// ESPN abbreviations that differ from NHL's own
const ESPN_TO_NHL = { LA: "LAK", NJ: "NJD", SJ: "SJS", TB: "TBL", UTAH: "UTA" };
const K = 10; // games of league-average mixed into a defense's per-game allowed rate

// one row per team per regular-season game: what that team's forwards / defensemen produced
async function loadSeason(season) {
  const buf = await fetchViaProxy(URL(season), "buffer");
  const rows = await readParquet(buf, ["game_id", "game_date", "home_away", "team_abbrev", "position", "shots_on_goal", "goals"]);
  const games = new Map();
  for (const r of rows) {
    if (String(r.game_id).slice(4, 6) !== "02" || !r.position) continue; // regular season skaters only
    const g = games.get(r.game_id) || { d: String(r.game_date).slice(0, 10), home: null, away: null };
    games.set(r.game_id, g);
    const side = (g[r.home_away] = g[r.home_away] || { t: r.team_abbrev, sog: { F: 0, D: 0 }, g: { F: 0, D: 0 } });
    const p = r.position === "D" ? "D" : "F";
    side.sog[p] += r.shots_on_goal || 0; side.g[p] += r.goals || 0;
  }
  const out = [];
  for (const g of games.values()) {
    if (!g.home || !g.away) continue;
    out.push({ d: g.d, t: g.home.t, o: g.away.t, sog: g.home.sog, g: g.home.g });
    out.push({ d: g.d, t: g.away.t, o: g.home.t, sog: g.away.sog, g: g.away.g });
  }
  return out;
}

const loaded = new Map();
export function loadNhlMatchupData(season) {
  if (!season) return Promise.resolve(null);
  if (!loaded.has(season)) {
    const key = `nhlef_matchups_${season}_v1`;
    const p = (async () => {
      const c = cacheGet(key, 6 * 3600 * 1000);
      if (c) return c;
      const rows = await loadSeason(season);
      cacheSet(key, rows);
      return rows;
    })().catch(() => null);
    loaded.set(season, p);
    p.then((r) => { if (!r) loaded.delete(season); });
  }
  return loaded.get(season);
}

/* -> { home: { sog: { F, D }, g: { F, D } }, away: { ... } } (home = how the AWAY defense treats the home
   team's forwards / defensemen), or null when there's no data / a team can't be matched */
export function nhlMatchupInputs(rows, g, date) {
  if (!rows || !g || !date) return null;
  const prior = rows.filter((r) => r.d < date);
  if (!prior.length) return null;
  const teams = new Set(prior.map((r) => r.t));
  const find = (a) => {
    const x = ESPN_TO_NHL[a] || a;
    if (teams.has(x)) return x;
    const hit = [...teams].filter((t) => t.startsWith(a) || a.startsWith(t));
    return hit.length === 1 ? hit[0] : null;
  };
  const home = find(g.home), away = find(g.away);
  if (!home || !away) return null;
  const n = prior.length; // team-games
  const lg = { sog: { F: 0, D: 0 }, g: { F: 0, D: 0 } };
  for (const r of prior) for (const s of ["sog", "g"]) for (const p of ["F", "D"]) lg[s][p] += r[s][p];
  const allowed = (def) => {
    const vs = prior.filter((r) => r.o === def);
    const out = { sog: {}, g: {} };
    for (const s of ["sog", "g"]) for (const p of ["F", "D"]) {
      const per = lg[s][p] / n;
      const tot = vs.reduce((a, r) => a + r[s][p], 0);
      out[s][p] = per ? ((tot + K * per) / (vs.length + K)) / per : 1;
    }
    return out;
  };
  return { home: allowed(away), away: allowed(home), meta: { source: "NHL box scores", teamGames: n, throughDate: prior.map((r) => r.d).sort().pop() } };
}
