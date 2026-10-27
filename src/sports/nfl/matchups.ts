/* NFL opponent matchup inputs for the projection model (nfl-v3). Backend only: nothing here renders.

   Edge Finder computes these itself from nflverse's public weekly stat files, fetched through its own
   nfl-stats-proxy Supabase function, because GitHub release downloads can't be read from a browser:
     stats_team_week_{season}.csv    team passing per game (attempts, completions, yards, TDs, INTs, sacks)
     stats_player_week_{season}.csv  player per game with position (targets, catches, yards, TDs, carries)
   nflverse refreshes both during the season, so nothing here needs a manual refresh.

   For a game, each team's opponent is profiled from games played in earlier weeks only (no leakage
   from the game itself or anything after it). Rates are summed numerators over summed denominators,
   never averages of game rates, and each is shrunk toward the league rate over the same weeks,
   then returned as a multiplier (opponent rate / league rate). If the files can't be loaded, or the
   game has no prior weeks (week 1, preseason), every multiplier is null and the engine keeps its
   v2 inputs for that game. */
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../../core/odds";

const PROXY = `${SUPABASE_URL}/functions/v1/nfl-stats-proxy`;
const NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download";
const CACHE_KEY = "nfief_matchupdata_v1";
const CACHE_TTL_MS = 6 * 3600 * 1000;
// ESPN abbreviations -> nflverse abbreviations (every other team matches)
const ESPN_TO_NFLVERSE = { LAR: "LA", WSH: "WAS" };

async function fetchCsv(path) {
  const url = `${PROXY}?url=${encodeURIComponent(`${NFLVERSE}/${path}`)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}`, apikey: SUPABASE_ANON_KEY } });
  if (!r.ok) throw new Error(`nflverse ${path}: ${r.status}`);
  return r.text();
}
function parseCsv(text) {
  // nflverse files have no quoted commas in the columns read here, but handle quotes anyway
  const lines = text.split(/\r?\n/).filter(Boolean);
  const split = (line) => {
    const out = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === "," && !q) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur); return out;
  };
  const head = split(lines[0]);
  return lines.slice(1).map((l) => { const v = split(l); const o = {}; head.forEach((h, i) => { o[h] = v[i]; }); return o; });
}
const num = (x) => { const v = +x; return Number.isFinite(v) ? v : 0; };

/* One compact row per team per game: what that team's OFFENSE did. A defense's allowed numbers are
   the rows whose opponent is that defense. */
function buildRows(teamCsv, playerCsv) {
  const rows = new Map();
  const rowFor = (r) => {
    const k = `${r.game_id}:${r.team}`;
    if (!rows.has(k)) rows.set(k, { team: r.team, opp: r.opponent_team, week: num(r.week), s: {} });
    return rows.get(k);
  };
  const add = (s, k, v) => { s[k] = (s[k] || 0) + v; };
  for (const r of parseCsv(teamCsv)) {
    const s = rowFor(r).s;
    add(s, "completions", num(r.completions)); add(s, "attempts", num(r.attempts));
    add(s, "passingYards", num(r.passing_yards)); add(s, "passTd", num(r.passing_tds));
    add(s, "interceptions", num(r.passing_interceptions)); add(s, "sacks", num(r.sacks_suffered));
    add(s, "dropbacks", num(r.attempts) + num(r.sacks_suffered));
  }
  for (const r of parseCsv(playerCsv)) {
    const pos = r.position === "FB" ? "RB" : r.position;
    if (pos !== "RB" && pos !== "WR" && pos !== "TE") continue;
    const s = rowFor(r).s;
    const g = pos.toLowerCase();
    add(s, `${g}Targets`, num(r.targets)); add(s, `${g}Receptions`, num(r.receptions));
    add(s, `${g}ReceivingYards`, num(r.receiving_yards)); add(s, `${g}RecTd`, num(r.receiving_tds));
    if (pos === "RB") { add(s, "rbCarries", num(r.carries)); add(s, "rbRushYards", num(r.rushing_yards)); add(s, "rbRushTd", num(r.rushing_tds)); }
  }
  return [...rows.values()];
}

const loaded = new Map(); // season -> Promise<rows|null>
export function loadMatchupData(season) {
  if (!season) return Promise.resolve(null);
  if (!loaded.has(season)) {
    const p = (async () => {
      try {
        const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
        if (c && c.season === season && Date.now() - c.at < CACHE_TTL_MS && Array.isArray(c.rows)) return c.rows;
      } catch { /* storage unavailable */ }
      const [teamCsv, playerCsv] = await Promise.all([
        fetchCsv(`stats_team/stats_team_week_${season}.csv`),
        fetchCsv(`stats_player/stats_player_week_${season}.csv`),
      ]);
      const rows = buildRows(teamCsv, playerCsv);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ season, at: Date.now(), rows })); } catch { /* storage full/unavailable */ }
      return rows;
    })().catch(() => null);
    loaded.set(season, p);
    p.then((rows) => { if (!rows) loaded.delete(season); }); // a failed load retries on the next game
  }
  return loaded.get(season);
}

// rate = numerator / denominator; k = prior weight toward the league rate, in the denominator's
// units. Efficiency rates use the minimum sample at which each rate is usable (40 to 60
// opportunities for most). TD and INT rates are rare events, so they get a much heavier prior: a few
// plays can't swing them far. Starting values; calibration from graded bets decides from here.
const RATES = {
  // what a DEFENSE allowed (summed over the offenses that faced it)
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
  for (const r of rows) for (const [k, v] of Object.entries(r.s)) t[k] = (t[k] || 0) + v;
  return t;
};
function multipliers(own, league, keys) {
  const out = {};
  for (const key of keys) {
    const [n, d, k] = RATES[key];
    const lg = league[d] ? (league[n] || 0) / league[d] : 0;
    if (!lg) { out[key] = null; continue; }
    out[key] = (((own[n] || 0) + k * lg) / ((own[d] || 0) + k)) / lg;
    out[`${key}N`] = own[d] || 0; // exposure behind the number
  }
  return out;
}

// the game's place in nflverse week numbering: REG weeks 1-18, then POST 19 (wild card),
// 20 (divisional), 21 (conference), 22 (Super Bowl). ESPN numbers postseason weeks 1-5 (4 = Pro Bowl).
function nflverseWeek(g) {
  if (g.seasonType === 2) return g.week || null;
  if (g.seasonType === 3) return g.week ? 18 + (g.week >= 5 ? 4 : g.week) : null;
  return null; // preseason: no matchup adjustment
}

/* For one Edge Finder game: { home: { def, off }, away: { def, off }, meta }.
   home.def = how the AWAY team's defense treats the home offense (multipliers for home players);
   home.off = how the AWAY team's offense protects / turns it over (for the home DST). */
export function matchupInputs(rows, g) {
  if (!rows || !g) return null;
  const wk = nflverseWeek(g);
  if (!wk) return null;
  const prior = rows.filter((r) => r.week < wk);
  if (!prior.length) return null;
  const league = sum(prior);
  const homeId = ESPN_TO_NFLVERSE[g.home] || g.home, awayId = ESPN_TO_NFLVERSE[g.away] || g.away;
  const side = (oppId) => {
    const vs = prior.filter((r) => r.opp === oppId), own = prior.filter((r) => r.team === oppId);
    return { oppId, oppGames: own.length, def: multipliers(sum(vs), league, DEF_KEYS), off: multipliers(sum(own), league, OFF_KEYS) };
  };
  return {
    home: side(awayId), away: side(homeId),
    meta: { source: "nflverse weekly stats", throughWeek: wk - 1, teamGames: prior.length },
  };
}
