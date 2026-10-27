/* NBA opponent matchup inputs for the projection model (nba-v3). Backend only: nothing here renders.

   Source: sportsdataverse / hoopR public NBA box scores (ESPN data, ESPN team ids = Edge Finder's),
   fetched as compact parquet season files through Edge Finder's own proxy:
     player_box_{season}  every player's line with position (G / F / C), minutes and opponent
     team_box_{season}    team totals, for possessions (pace)
   Updated by sportsdataverse during the season; cached here for 6 hours (last season for 7 days).

   For a game, each opponent's defense is profiled by position: what guards, forwards and centers
   produced against it per possession of floor time (minutes x game pace / 48), so neither playing time
   nor pace leaks into the defensive number. Only games before this game's date count. Each rate is
   shrunk toward the league rate for that position, then returned as a multiplier (opponent / league).
   Last season counts early and fades out by a team's 20th game, since this season's sample starts at
   zero. Pace: expected possessions for this matchup vs the possessions in the player's usual games.
   If the files can't load, everything is null and the engine keeps its v2 inputs. */
import { cacheGet, cacheSet, fetchViaProxy, readParquet } from "../../core/dataProxy";

const BASE = "https://github.com/sportsdataverse/sportsdataverse-data/releases/download";
const STATS = ["pts", "reb", "ast", "fg3m", "stl", "blk", "tov"];
const POS = ["G", "F", "C"];
const posOf = (p) => { const s = String(p || "").toUpperCase(); return s === "C" ? "C" : s.endsWith("F") || s === "F" ? "F" : s.endsWith("G") || s === "G" ? "G" : null; };
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || "").slice(0, 10));

/* one compact row per team per regular-season game: that team's possessions, the game's pace, and what
   its players produced by position (the opponent's defense allowed it) */
async function loadSeason(season) {
  const [pb, tb] = await Promise.all([
    fetchViaProxy(`${BASE}/espn_nba_player_boxscores/player_box_${season}.parquet`, "buffer"),
    fetchViaProxy(`${BASE}/espn_nba_team_boxscores/team_box_${season}.parquet`, "buffer"),
  ]);
  const teams = await readParquet(tb, ["game_id", "season_type", "game_date", "team_id", "opponent_team_id", "field_goals_attempted", "offensive_rebounds", "total_turnovers", "turnovers", "free_throws_attempted"]);
  const players = await readParquet(pb, ["game_id", "season_type", "team_id", "opponent_team_id", "minutes", "points", "rebounds", "assists", "three_point_field_goals_made", "steals", "blocks", "turnovers", "athlete_position_abbreviation", "did_not_play"]);
  const poss = new Map(); // game_id:team -> possessions
  for (const t of teams) {
    if (t.season_type !== 2) continue;
    const tov = t.total_turnovers != null ? t.total_turnovers : t.turnovers;
    poss.set(`${t.game_id}:${t.team_id}`, (t.field_goals_attempted || 0) - (t.offensive_rebounds || 0) + (tov || 0) + 0.44 * (t.free_throws_attempted || 0));
  }
  const rows = new Map();
  for (const t of teams) {
    if (t.season_type !== 2) continue;
    const own = poss.get(`${t.game_id}:${t.team_id}`), opp = poss.get(`${t.game_id}:${t.opponent_team_id}`);
    if (!own || !opp) continue;
    const r = { d: day(t.game_date), t: t.team_id, o: t.opponent_team_id, p: +own.toFixed(1), gp: +((own + opp) / 2).toFixed(1), s: {} };
    for (const P of POS) { r.s[P] = { fp: 0 }; for (const k of STATS) r.s[P][k] = 0; }
    rows.set(`${t.game_id}:${t.team_id}`, r);
  }
  for (const x of players) {
    if (x.season_type !== 2 || x.did_not_play || !(x.minutes > 0)) continue;
    const r = rows.get(`${x.game_id}:${x.team_id}`); const P = posOf(x.athlete_position_abbreviation);
    if (!r || !P) continue;
    const s = r.s[P];
    s.fp += (x.minutes * r.gp) / 48; // possessions of floor time
    s.pts += x.points || 0; s.reb += x.rebounds || 0; s.ast += x.assists || 0; s.fg3m += x.three_point_field_goals_made || 0;
    s.stl += x.steals || 0; s.blk += x.blocks || 0; s.tov += x.turnovers || 0;
  }
  return [...rows.values()].map((r) => { for (const P of POS) for (const k in r.s[P]) r.s[P][k] = +r.s[P][k].toFixed(1); return r; });
}

const loaded = new Map(); // season -> Promise<rows | null>
function seasonRows(season, maxAgeMs) {
  if (!loaded.has(season)) {
    const key = `nbaef_matchups_${season}_v1`;
    const p = (async () => {
      const cached = cacheGet(key, maxAgeMs);
      if (cached) return cached;
      const rows = await loadSeason(season);
      cacheSet(key, rows);
      return rows;
    })().catch(() => null);
    loaded.set(season, p);
    p.then((r) => { if (!r) loaded.delete(season); }); // a failed load retries on the next game
  }
  return loaded.get(season);
}
// { cur, prior } rows for the season the slate belongs to (season = its ending year, as ESPN numbers it)
export async function loadNbaMatchupData(season) {
  if (!season) return null;
  const [cur, prior] = await Promise.all([seasonRows(season, 6 * 3600 * 1000), seasonRows(season - 1, 7 * 86400 * 1000)]);
  return cur || prior ? { cur: cur || [], prior: prior || [] } : null;
}

// prior weight in GAMES of this-season-equivalent sample: k games of league average per stat
const K_GAMES = { pts: 6, reb: 6, ast: 6, fg3m: 8, tov: 8, stl: 10, blk: 10 };
const PRIOR_FADE_GAMES = 20; // last season stops counting once a team has played this many games
const PACE_K = 5;            // games of league-average pace mixed into a team's pace

/* For one Edge Finder game: { home: { def: { G|F|C: { pts, reb, ... } }, pace }, away: { ... }, meta }.
   home.def = how the AWAY defense treats each position (multipliers for home players); home.pace = the
   home players' pace multiplier for this matchup. */
export function nbaMatchupInputs(data, g, date) {
  if (!data || !g || !date) return null;
  const cut = (rows) => rows.filter((r) => r.d < date);
  const cur = cut(data.cur), prior = data.prior; // last season is entirely before this game
  if (!cur.length && !prior.length) return null;
  const gamesOf = (team) => cur.filter((r) => r.t === team).length;
  const lgGames = cur.length / 30;
  const add = (acc, r, w) => { for (const P of POS) for (const k in r.s[P]) acc[P][k] = (acc[P][k] || 0) + w * r.s[P][k]; };
  const empty = () => Object.fromEntries(POS.map((P) => [P, {}]));
  const fade = (gp) => Math.max(0, 1 - gp / PRIOR_FADE_GAMES);
  // league: this season plus last season, faded by the league's average games played
  const league = empty(); const wl = fade(lgGames);
  for (const r of cur) add(league, r, 1);
  if (wl > 0) for (const r of prior) add(league, r, wl);
  const lgGamesTotal = cur.length + wl * prior.length; // team-games in the league sample
  const allowed = (def) => {
    const acc = empty(); const w = fade(gamesOf(def));
    for (const r of cur) if (r.o === def) add(acc, r, 1);
    if (w > 0) for (const r of prior) if (r.o === def) add(acc, r, w);
    const out = {};
    for (const P of POS) {
      const L = league[P]; const perGameFp = L.fp && lgGamesTotal ? L.fp / lgGamesTotal : 0;
      out[P] = { fp: +(acc[P].fp || 0).toFixed(0) };
      for (const k of STATS) {
        const lg = L.fp ? (L[k] || 0) / L.fp : 0;
        if (!lg || !perGameFp) { out[P][k] = null; continue; }
        const kk = K_GAMES[k] * perGameFp;
        out[P][k] = (((acc[P][k] || 0) + kk * lg) / ((acc[P].fp || 0) + kk)) / lg;
      }
    }
    return out;
  };
  // possessions per game: league (this season + faded last season), and each team's, shrunk to league
  let lgN = 0, lgS = 0;
  for (const r of cur) { lgN += 1; lgS += r.p; }
  if (wl > 0) for (const r of prior) { lgN += wl; lgS += wl * r.p; }
  const lgPace = lgN ? lgS / lgN : 99;
  const pace = (team) => {
    const w = fade(gamesOf(team)); let n = 0, s = 0;
    for (const r of cur) if (r.t === team) { n += 1; s += r.p; }
    if (w > 0) for (const r of prior) if (r.t === team) { n += w; s += w * r.p; }
    return (s + PACE_K * lgPace) / (n + PACE_K);
  };
  const home = Number(g.homeId), away = Number(g.awayId);
  const tpH = pace(home), tpA = pace(away);
  // a player's own rates come from games at roughly (his team's pace + an average opponent's) / 2
  const paceMult = (own, opp) => (own + opp) / (own + lgPace);
  return {
    home: { def: allowed(away), pace: paceMult(tpH, tpA), oppGames: gamesOf(away) },
    away: { def: allowed(home), pace: paceMult(tpA, tpH), oppGames: gamesOf(home) },
    meta: { source: "hoopR NBA box scores", throughDate: cur.length ? cur.map((r) => r.d).sort().pop() : null, lgPace: +lgPace.toFixed(1), priorWeight: +wl.toFixed(2) },
  };
}
