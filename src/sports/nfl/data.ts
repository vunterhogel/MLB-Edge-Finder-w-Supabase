/* NFL data layer: ESPN fetchers, The Odds API parsing, settlement helpers (moved from the old NFLApp.tsx). */
import { clamp, evPerUnit, impliedProb, probToAmerican } from "../../core/math";
import { oddsProxyFetch } from "../../core/odds";
import { GAME_MARKETS, K_PROPS, MARKET_TO_TYPE, QB_PROPS, RB_PROPS, TD_PROPS, TEAMS, TYPE_TO_MARKET, WR_PROPS } from "./config";
import { calibrateToMarket, jointGameProbs, marginProb } from "./engine";

/* ============================================================
   DATA LAYER — ESPN hidden API (doc §1)
   Shapes verified live against site.api.espn.com / sports.core.api.espn.com
   in Aug 2026. Every parser is column/shape-TOLERANT (mirrors the MLB
   app's lbPick/scanForKeys philosophy for Statcast leaderboards): if a
   field renames or a nesting shifts, we degrade to a league prior
   instead of throwing. Nothing here is a hard dependency.
   ============================================================ */
export const ESPN_SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
export const ESPN_WEB = "https://site.web.api.espn.com/apis/common/v3/sports/football/nfl";
export const ESPN_CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";
export async function jget(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status}`); return r.json(); }
export function refId(ref) {
  // Extract the resource id from an ESPN URL — the LAST "/digits" path
  // segment, e.g. ".../seasons/2026/athletes/4431452?lang=en&region=us"
  // -> "4431452", or ".../player/_/id/3139477/patrick-mahomes" -> "3139477".
  // MUST take the *last* match, not the first: Core-API "$ref" URLs have an
  // earlier "/seasons/<year>/" segment that also looks like "/<digits>/",
  // and matching the first occurrence silently grabbed the season year
  // instead of the real id — breaking every id-keyed lookup that depends on
  // this (e.g. depth-chart rank matching, which is why the wrong player was
  // showing as a team's starter).
  if (!ref) return null;
  const matches = [...String(ref).matchAll(/\/(\d+)(?=[/?]|$)/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

/* ---- schedule / scoreboard ---- */
export function classify(comp) {
  const st = comp && comp.status && comp.status.type;
  if (!st) return "SCHEDULED";
  if (st.completed) return "FINAL";
  if (st.state === "in") return "LIVE";
  return "SCHEDULED"; // pregame — NFL doesn't post an official "lineup" the way MLB does; injuries/depth-chart stand in
}
export function mapGame(ev) {
  const comp = ev.competitions && ev.competitions[0];
  const home = (comp.competitors || []).find((c) => c.homeAway === "home") || {};
  const away = (comp.competitors || []).find((c) => c.homeAway === "away") || {};
  const rec = (c) => { const r = (c.records || []).find((x) => x.type === "total" || !x.type); return r ? r.summary : ""; };
  const homeId = home.team && +home.team.id, awayId = away.team && +away.team.id;
  return {
    pk: ev.id, homeId, awayId,
    home: (home.team && home.team.abbreviation) || "HOME", away: (away.team && away.team.abbreviation) || "AWAY",
    homeName: (home.team && home.team.displayName) || "", awayName: (away.team && away.team.displayName) || "",
    homeRec: rec(home), awayRec: rec(away),
    time: ev.date ? new Date(ev.date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "TBD",
    gameTimeIso: ev.date || null, // raw scheduled kickoff timestamp — carried through to board log rows so the Parlay Builder can tell upcoming games from live/started ones
    // NFL weeks aren't confined to Thu/Sun/Mon (Saturday, international Friday,
    // Thanksgiving/Black-Friday/Christmas games all exist) — surface the actual
    // day so a card never implies a game is "this weekend" when it isn't.
    dateLabel: ev.date ? new Date(ev.date).toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" }) : "",
    venue: (comp.venue && comp.venue.fullName) || "",
    indoor: !!(comp.venue && comp.venue.indoor),
    status: classify(comp),
    homeScore: home.score != null ? +home.score : null, awayScore: away.score != null ? +away.score : null,
    period: comp.status && comp.status.period, clock: comp.status && comp.status.displayClock,
    week: ev.week && ev.week.number, seasonType: ev.season && ev.season.type,
    manual: false,
  };
}
// the shell navigates every sport by date: the NFL games on one calendar date (same scoreboard feed)
export async function fetchScheduleByDate(date) {
  const d = await jget(`${ESPN_SITE}/scoreboard?dates=${String(date).replace(/-/g, "")}&limit=100`);
  return (d.events || []).map(mapGame);
}
export async function fetchSchedule(seasonType, week, year) {
  const d = await jget(`${ESPN_SITE}/scoreboard?seasontype=${seasonType}&week=${week}&year=${year}`);
  return (d.events || []).map(mapGame);
}
export function currentWeekGuess(today = new Date()) {
  // Rough season-structure heuristic (Labor Day anchors Week 1): a SYNCHRONOUS
  // first-paint default only, so the UI isn't blank while fetchCurrentWeek()'s
  // live lookup resolves — always overridable in the UI, and always corrected
  // by fetchCurrentWeek() below once that live call returns. Do not rely on
  // this alone: it hardcodes assumptions (e.g. exactly 4 preseason weeks) that
  // drift from the real schedule season to season (recent seasons have used 3).
  const y = today.getFullYear();
  const laborDay = (() => { const d = new Date(y, 8, 1); while (d.getDay() !== 1) d.setDate(d.getDate() + 1); return d; })();
  const week1Kickoff = new Date(laborDay); week1Kickoff.setDate(week1Kickoff.getDate() + 3); // first Thursday after Labor Day
  const preseasonStart = new Date(y, 7, 1);
  if (today < preseasonStart) return { seasonType: 2, week: 18, year: y - 1 }; // offseason -> show last week of prior season
  if (today < week1Kickoff) { const wk = clamp(Math.ceil((today - preseasonStart) / 6.048e8) + 1, 1, 4); return { seasonType: 1, week: wk, year: y }; }
  const wk = clamp(Math.floor((today - week1Kickoff) / 6.048e8) + 1, 1, 18);
  return { seasonType: 2, week: wk, year: y };
}
/* ---- live current-week lookup: replaces calendar-math guessing with the real
   NFL schedule. ESPN's scoreboard, fetched with no narrow week/seasontype filter,
   includes leagues[0].calendar — an array of season-type groups (Preseason=1,
   Regular Season=2, Postseason=3, matching this app's seasonType numbering),
   each with an `entries` array of that phase's weeks (also covering odd ones
   like Hall of Fame Weekend or Wild Card), every entry carrying its own
   startDate/endDate and a 1-based `value` = the week number ESPN's own
   scoreboard/week params expect. Verified live (2026-09-08): top-level
   season.type=2, week.number=1 for that date, and the calendar's Preseason
   group correctly lists 3 weeks (Hall of Fame Weekend, Pre Wk 1, Pre Wk 2) for
   the 2026 season — confirming this reads the real schedule shape instead of
   assuming a fixed preseason length or fixed game days. */
export async function fetchCurrentWeek(now = new Date()) {
  const d = await jget(`${ESPN_SITE}/scoreboard`);
  const cal = (d.leagues && d.leagues[0] && d.leagues[0].calendar) || [];
  const weeks = [];
  for (const group of cal) {
    const seasonType = +group.value;
    for (const entry of group.entries || []) {
      const week = +entry.value;
      const start = entry.startDate ? new Date(entry.startDate) : null;
      const end = entry.endDate ? new Date(entry.endDate) : null;
      if (Number.isFinite(seasonType) && Number.isFinite(week) && start && !isNaN(start) && end && !isNaN(end)) {
        weeks.push({ seasonType, week, start, end });
      }
    }
  }
  if (!weeks.length) throw new Error("empty calendar");
  weeks.sort((a, b) => a.start - b.start);
  const nowT = now.getTime();
  const year = (d.season && d.season.year) || now.getFullYear();
  // the week containing "now" ...
  let found = weeks.find((w) => nowT >= w.start.getTime() && nowT < w.end.getTime());
  // ... else the NEXT upcoming week (we're between weeks) ...
  if (!found) found = weeks.find((w) => w.start.getTime() > nowT);
  // ... else the whole season has concluded: fall back to the most recent past week.
  if (!found) found = weeks[weeks.length - 1];
  return { seasonType: found.seasonType, week: found.week, year };
}

/* ---- roster (embeds injuries — one call per team gets both) ---- */
export async function fetchRoster(teamId) {
  const d = await jget(`${ESPN_SITE}/teams/${teamId}/roster`);
  const out = [];
  for (const grp of d.athletes || []) {
    for (const a of grp.items || []) {
      const inj = (a.injuries && a.injuries[0]) || null;
      out.push({
        id: a.id, name: a.fullName || a.displayName || "",
        pos: (a.position && a.position.abbreviation) || "",
        jersey: a.jersey || "",
        injuryStatus: inj ? String(inj.status || "").toUpperCase().replace(/\s+/g, "_") : null,
      });
    }
  }
  return out;
}
/* ---- universal player search (the NFL equivalent of MLB's statsapi people/search) ----
   ESPN's cross-sport search (site.api.espn.com/apis/search/v2) is the only verified,
   keyless, real-time NFL player-name search available — confirmed live (Aug 2026):
   results live at results[0].contents[], each item carries `uid: "s:20~l:28~a:<athleteId>"`
   (s:20/l:28 = football/NFL — used to filter out NCAAF/other-sport name collisions like
   multiple "Josh Allen"s) and `subtitle` = the player's current team's full name
   ("Kansas City Chiefs"), which espnIdForTeamName() below resolves back to our ESPN team id. */
export function espnIdForTeamName(fullName) {
  if (!fullName) return null;
  const s = fullName.trim();
  for (const id in TEAMS) if (s.endsWith(TEAMS[id].name)) return +id;
  return null;
}
export async function searchPlayers(query) {
  const q = String(query || "").trim();
  if (!q) return [];
  try {
    const d = await jget(`https://site.api.espn.com/apis/search/v2?query=${encodeURIComponent(q)}&limit=20&type=player`);
    const contents = (d.results && d.results[0] && d.results[0].contents) || [];
    return contents
      .filter((p) => p.defaultLeagueSlug === "nfl")
      .map((p) => {
        const m = String(p.uid || "").match(/a:(\d+)/);
        const id = m ? m[1] : refId(p.link && p.link.web);
        const teamName = p.subtitle || "";
        return { id, name: p.displayName || "", teamName, teamId: espnIdForTeamName(teamName) };
      })
      .filter((p) => p.id);
  } catch { return []; }
}
/* ---- depth chart: athlete id -> {slot label, rank} ---- */
export async function fetchDepthChart(teamId, year) {
  try {
    const d = await jget(`${ESPN_CORE}/seasons/${year}/teams/${teamId}/depthcharts`);
    const out = {};
    for (const unit of d.items || []) {
      for (const posKey in unit.positions || {}) {
        const grp = unit.positions[posKey];
        for (const a of grp.athletes || []) {
          const id = refId(a.athlete && a.athlete.$ref);
          if (!id) continue;
          if (!out[id] || (a.rank || 99) < out[id].rank) out[id] = { pos: posKey.toUpperCase(), rank: a.rank || 99 };
        }
      }
    }
    return out;
  } catch { return {}; }
}

/* ---- athlete gamelog: season + recent-N aggregate, column-tolerant ---- */
export function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }
// stat-name aliases: ESPN's `names` array wording drifts by season; match tolerantly.
export const STAT_ALIASES = {
  passAtt: ["passingAttempts", "attempts"], passCmp: ["completions"], passYds: ["passingYards", "netPassingYards"],
  passTd: ["passingTouchdowns", "passingTDs"], ints: ["interceptions"],
  rushAtt: ["rushingAttempts", "carries"], rushYds: ["rushingYards"], rushTd: ["rushingTouchdowns", "rushingTDs"],
  targets: ["receivingTargets", "targets"], rec: ["receptions"], recYds: ["receivingYards"], recTd: ["receivingTouchdowns", "receivingTDs"],
  fgMade: ["fieldGoalsMade"], kickPts: ["totalPoints", "kickingPoints"],
  sacks: ["sacks"], defInt: ["interceptions"],
  // per-game "longest play" stats — averaged across games (see fetchAthleteGamelog), never summed,
  // so Longest Reception/Rush/Completion can be grounded in each player's own real big-play history
  // instead of a ratio of other stats that cancels out to one league-wide constant for everyone.
  // Deliberately NOT aliased to a bare "long" — ESPN's flat names array spans multiple stat
  // categories (passing/rushing/receiving) and a bare "long" could ambiguously match the wrong
  // category's column for a dual-role player (e.g. an RB with both rushing and receiving lines).
  // If these specific names don't match live, this degrades to null (n=0) and the position/depth-
  // varying fallback prior below takes over — never a silent cross-match.
  longRec: ["longReception", "receivingLong"], longRush: ["longRushing", "rushingLong"],
  longCmp: ["longPassing", "passingLong"],
};
export const LONG_KEYS = ["longRec", "longRush", "longCmp"]; // gated-average, not summed, in fetchAthleteGamelog
// Trends tab: maps each player-prop label to the per-game gamelog field (same STAT_ALIASES
// vocabulary fetchAthleteGamelog already populates on every `games[]` row) that a trend's hit-rate
// check reads. "Anytime TD" has no raw alias — it's a derived combo (rushTd + recTd), handled as a
// special case in trendValueForGame(). Game-level props (Moneyline/Spread/Total) and DST props are
// out of v1 scope: Trends is pure player box-score history, nothing ESPN's gamelog doesn't carry.
export const TREND_STAT_KEY = {
  "Pass Yards": "passYds", "Pass TDs": "passTd", "Interceptions": "ints",
  "Pass Completions": "passCmp", "Pass Attempts": "passAtt", "Longest Completion": "longCmp",
  "Rush Yards": "rushYds", "Rush TDs": "rushTd", "Longest Rush": "longRush",
  "Receptions": "rec", "Receiving Yards": "recYds", "Receiving TDs": "recTd", "Longest Reception": "longRec",
  "Kicking Points": "kickPts", "Field Goals Made": "fgMade",
};
export const TREND_PROPS = [...QB_PROPS, ...RB_PROPS, ...WR_PROPS, ...TD_PROPS, ...K_PROPS].filter((t, i, a) => a.indexOf(t) === i);
export function pickAlias(names, key) {
  const cands = STAT_ALIASES[key] || [key];
  for (const c of cands) { const i = names.findIndex((n) => String(n).toLowerCase() === c.toLowerCase()); if (i >= 0) return i; }
  return -1;
}
export const GAMELOG_ROWS = 8; // cap for the "Last N Games" log table (5-10 games, per product ask)
// Pulls the { eventId -> {statKey: number} } map of REAL per-game stat values out of a gamelog
// response. Verified live against ESPN (Sept 2026): the per-game numbers do NOT live under
// `d.events` at all — that dict is metadata-only (week/date/opponent/score/team, no numbers
// whatsoever). The actual values live under `d.seasonTypes[].categories[].events`, indexed
// positionally against `d.names` (so `stats[idx["longCmp"]]` is that game's longest completion).
// IMPORTANT, and the reason this needed a second pass after the first "fix": that `events` value
// is an ARRAY of `{eventId, stats}` rows, not an object keyed by event id the way `d.events` (the
// metadata dict) is — the two are shaped differently despite the same field name. The first
// version of this function did `for (const eid in ev)` and used the loop's enumeration key
// (an array INDEX — "0", "1", ...) as the output key instead of the row's own `.eventId` field,
// so every lookup was keyed wrong and silently never matched a real event id. Live-confirmed via
// raw JSON dump: `categories[0].events` = `[{"eventId":"401872657","stats":[...]}]`. Handle both
// an array and an (in case ESPN ever changes this back) object defensively, but always key by
// `row.eventId` — never by the loop variable.
export function statsByEventFromGamelog(d, idx) {
  const out = {};
  for (const st of d.seasonTypes || []) {
    for (const cat of st.categories || []) {
      const ev = cat.events;
      if (!ev) continue;
      const rows = Array.isArray(ev) ? ev : (typeof ev === "object" ? Object.values(ev) : []);
      for (const row of rows) {
        if (!row || !row.stats) continue;
        const eid = row.eventId != null ? String(row.eventId) : null;
        if (!eid) continue;
        const rec = (out[eid] = out[eid] || {});
        for (const k in idx) if (idx[k] >= 0 && row.stats[idx[k]] != null) rec[k] = num(row.stats[idx[k]]);
      }
    }
  }
  return out;
}
export async function fetchAthleteGamelog(athleteId, n = 4, season = null) {
  try {
    const url = `${ESPN_WEB}/athletes/${athleteId}/gamelog` + (season ? `?season=${season}` : "");
    const d = await jget(url);
    const names = d.names || [];
    // This used to fail 100% silently: any failure here (bad response shape, no names[], a
    // thrown fetch error below) just returned null and every caller swallows that null without
    // a trace. Trends depends entirely on this succeeding, so log *why* it came back empty —
    // check the browser console for these if Trends shows "0 trends" with games/detail loaded.
    if (!names.length) { console.warn(`[gamelog] empty names[] for athlete ${athleteId}${season ? ` (season ${season})` : ""} — response: ${JSON.stringify(d).slice(0, 200)}`); return null; }
    const idx = {};
    for (const k in STAT_ALIASES) idx[k] = pickAlias(names, k);
    const statsByEvent = statsByEventFromGamelog(d, idx);

    // Chronological order by the metadata's own week/date — NOT by object-key enumeration
    // order, which is an assumption about JS engine behavior this file no longer relies on.
    const eventsObj = (d.events && typeof d.events === "object" && !Array.isArray(d.events)) ? d.events : {};
    const eventIds = Object.keys(eventsObj).sort((a, b) => {
      const ea = eventsObj[a] || {}, eb = eventsObj[b] || {};
      const wa = ea.week != null ? ea.week : 0, wb = eb.week != null ? eb.week : 0;
      if (wa !== wb) return wa - wb;
      const da = ea.gameDate ? Date.parse(ea.gameDate) : 0, db = eb.gameDate ? Date.parse(eb.gameDate) : 0;
      return da - db;
    });
    const all = eventIds.map((eid) => statsByEvent[eid] || {});

    // "long*" stats are a per-game max, not additive — summing them across games is meaningless.
    // Average instead, gated to games where the player actually had a qualifying play (a catch,
    // a carry, a completion) so a bye/DNP/zero-target game doesn't drag the average toward 0.
    const GATE_KEY = { longRec: "rec", longRush: "rushAtt", longCmp: "passCmp" };
    const avgLong = (arr, key) => {
      const gate = GATE_KEY[key];
      const vals = arr.filter((r) => (!gate || r[gate] > 0) && r[key] > 0).map((r) => r[key]);
      return vals.length ? { avg: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length } : { avg: null, n: 0 };
    };
    const sum = (arr) => arr.reduce((acc, r) => { for (const k in r) if (!LONG_KEYS.includes(k)) acc[k] = (acc[k] || 0) + (r[k] || 0); return acc; }, { g: arr.length });
    // THE ACTUAL ROOT CAUSE of every gamelog fetch throwing (console: "Cannot access 'season2'
    // before initialization", for 100% of players, unaffected by concurrency or season-thinness —
    // which is exactly why neither of the last two fixes touched it): this local aggregate used to
    // be named `season`, which is ALSO this function's parameter name (the season year to query).
    // Redeclaring a parameter with `const` in the same function scope is an illegal duplicate
    // declaration; esbuild's build-time transform silently renames one binding instead of raising a
    // syntax error, and the renamed binding gets read before its own initializer runs — a guaranteed
    // throw on every single invocation, caught by this function's own try/catch and swallowed into a
    // silent `null` since before this session started (this predates the Trends tab entirely — it's
    // why Player Analysis's season/recent splits and the projection shrinkage prior were presumably
    // always running on empty data too, not just Trends). Renamed to seasonAgg; no behavior change
    // for callers, which only ever read the RETURNED object's `.season` key, set at the bottom.
    const seasonAgg = sum(all); seasonAgg.g = all.length;
    for (const k of LONG_KEYS) { const { avg, n: cnt } = avgLong(all, k); seasonAgg[`${k}Avg`] = avg; seasonAgg[`${k}N`] = cnt; }
    const recentSlice = all.slice(-n);
    const recent = sum(recentSlice); recent.games = recentSlice.length;
    for (const k of LONG_KEYS) { const { avg, n: cnt } = avgLong(recentSlice, k); recent[`${k}Avg`] = avg; recent[`${k}N`] = cnt; }

    // Per-game log rows (week/date/opponent) for the "Last N Games" table — metadata and stats
    // are joined by event id directly now, so there's no positional-pairing risk left.
    let games = eventIds.map((eid) => {
      const ev = eventsObj[eid] || {};
      const opp = (ev.opponent && (ev.opponent.abbreviation || ev.opponent.displayName)) || null;
      return {
        eventId: eid,
        week: ev.week != null ? ev.week : null,
        date: ev.gameDate || ev.date || null,
        atVs: ev.atVs || null,
        opp,
        score: ev.score || null,
        result: ev.gameResult || null,
        ...(statsByEvent[eid] || {}),
      };
    });
    games = games.slice(-GAMELOG_ROWS).reverse(); // most-recent-first, capped

    return { season: seasonAgg, recent, games };
  } catch (e) { console.warn(`[gamelog] fetch threw for athlete ${athleteId}${season ? ` (season ${season})` : ""}:`, (e && e.message) || e); return null; }
}

/* ---- Trends tab: pure hit-rate computation over a player's own gamelog rows ----
   Every number here is backward-looking box-score history — no projection model, no Odds API
   call. A "trend" is just: did this player's real per-game stat clear this line, how often, across
   three slices of their own history (recent form / vs this opponent / this venue type). */
export function trendValueForGame(row, type) {
  if (type === "Anytime TD") return (row.rushTd || 0) + (row.recTd || 0);
  const key = TREND_STAT_KEY[type];
  if (!key) return null;
  const v = row[key];
  return v != null ? v : 0;
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
// fetchAthleteGamelog — no new fetch here). Sources the line from a matching Board entry (today's
// real pulled odds, zero additional Odds API cost) when one exists; otherwise synthesizes a
// model-free round-number threshold from the player's own recent average (Linemate does the same
// for players/games nobody's pulled odds on yet) so Trends works even on a day with zero Odds API
// usage. `boardEntriesForGame` should already be pre-filtered to this one game.
export function buildTrendCard(p, pos, type, gl, g, isHome, boardEntriesForGame, recentN) {
  if (!gl || !gl.games || !gl.games.length) return null;
  const oppAbbr = isHome ? g.away : g.home;
  const matches = boardEntriesForGame.filter((e) => String(e.playerId) === String(p.id) && e.type === type);
  const chosen = matches.find((e) => e.side === "over") || matches.find((e) => e.side === "under") || null;
  let line, side, sourced, odds = null, boardEntryId = null;
  if (chosen) {
    line = parseFloat(chosen.line); side = chosen.side; sourced = "book"; odds = chosen.odds; boardEntryId = chosen.id;
  } else {
    const recentVals = gl.games.slice(0, recentN).map((row) => trendValueForGame(row, type)).filter((v) => v != null);
    if (!recentVals.length) return null;
    const avg = recentVals.reduce((a, b) => a + b, 0) / recentVals.length;
    let synth = Math.floor(avg) + 0.5; if (synth > avg) synth -= 1;
    line = Math.max(0.5, synth); side = "over"; sourced = "model";
  }
  const recentGames = gl.games.slice(0, recentN);
  const recentForm = hitRateFromGames(recentGames, type, line, side);
  const h2hGames = gl.games.filter((row) => row.opp === oppAbbr);
  const vsOpp = hitRateFromGames(h2hGames, type, line, side);
  const wantAtVs = isHome ? "vs" : "@";
  const venueGames = gl.games.filter((row) => row.atVs === wantAtVs);
  const homeAway = hitRateFromGames(venueGames, type, line, side);
  if (!recentForm.n && !vsOpp.n && !homeAway.n) return null;
  return {
    id: `${g.pk}-${p.id}-${type}-${line}-${side}`, gamePk: g.pk, game: `${g.away}@${g.home}`,
    playerId: p.id, name: p.name, pos, type, line, side, sourced, odds, boardEntryId,
    recentForm, vsOpp, homeAway, opp: oppAbbr, isHome,
  };
}

// ---- settlement-only: pull ONE game's "longest completion" value out of a QB's gamelog.
// ESPN's box score summary (fetchGameSummary) never carries a longest-completion field at all
// (passing box scores expose C/ATT/YDS/TD/INT/SACKS/QBR/RTG — no LONG column; only rushing and
// receiving box scores have one), which is why BOX_STAT_FOR has no entry for this market. Without
// this fallback, actualFor() returns null forever and these bets never leave "open". The gamelog
// endpoint (same one the projection engine already uses) DOES carry it per game — see
// statsByEventFromGamelog() for where it actually lives — so look the one game up directly
// instead of guessing. Deliberately returns null (not 0) on any lookup failure — leaving the bet
// open is safer than mis-grading it from a network hiccup or a shape mismatch.
export async function fetchLongCmpForEvent(athleteId, eventId, season = null) {
  // Every early-return below is logged with WHY, not just swallowed — this lookup has already
  // failed once against a wrong assumption about the response shape, so if it fails again we
  // want to know from the browser console which branch it hit instead of guessing blind again.
  const tag = `[fetchLongCmpForEvent athlete=${athleteId} event=${eventId}]`;
  try {
    const url = `${ESPN_WEB}/athletes/${athleteId}/gamelog` + (season ? `?season=${season}` : "");
    const d = await jget(url);
    const names = d.names || [];
    if (!names.length) { console.warn(tag, "no names[] in response — empty/unexpected payload", d); return null; }
    const idx = { longCmp: pickAlias(names, "longCmp") };
    if (idx.longCmp < 0) { console.warn(tag, "longPassing/passingLong not found in names[]", names); return null; }
    const statsByEvent = statsByEventFromGamelog(d, idx);
    const row = statsByEvent[String(eventId)];
    if (!row || row.longCmp == null) {
      // JSON.stringify, not the bare array — a bare array/object argument to console.warn
      // collapses to "Array(1)" when the log line is copy-pasted instead of expanded in
      // DevTools, which is exactly what made the first round of this diagnostic useless.
      console.warn(tag, `event id not found in seasonTypes[].categories[].events (season=${season || "default"}) — known event ids: ${JSON.stringify(Object.keys(statsByEvent))}`);
      return null;
    }
    return row.longCmp;
  } catch (err) { console.warn(tag, "fetch/parse threw:", err); return null; }
}
// Pulls the season YEAR back out of a tracked bet/board-log row's own `week` field, which is
// stamped as `${year}-${seasonType}-${week}` at trackBet() time — e.g. "2026-2-1" -> 2026. This
// is the season the bet was actually placed under, straight from data already on the row, rather
// than guessing at "today's" season from the current calendar date.
export function weekYear(weekKey) {
  if (!weekKey) return null;
  const y = parseInt(String(weekKey).split("-")[0], 10);
  return Number.isFinite(y) ? y : null;
}
// Live-verified (Sept 2026) that ESPN's gamelog endpoint's default "no season param" response can
// resolve to a stale/minimal season — as few as ONE known game, and not necessarily the current
// one — rather than reliably tracking the athlete's actual current season the way the rest of
// this file assumed. So for settlement (where mis-grading a real bet is the risk we're avoiding)
// try the bet's own season year explicitly FIRST, and only fall back to the ambiguous default if
// that specific season lookup comes up empty (e.g. the bet's week field is missing/malformed).
export async function fetchLongCmpForEventTrySeasons(athleteId, eventId, season) {
  if (season) {
    const v = await fetchLongCmpForEvent(athleteId, eventId, season);
    if (v != null) return v;
  }
  return fetchLongCmpForEvent(athleteId, eventId, null);
}

/* ---- team season stats: offense (own production) + defense (allowed) ---- */
export function pickCat(categories, wantNames) {
  const out = {};
  for (const cat of categories || []) {
    for (const s of cat.stats || []) {
      const nm = String(s.name || "").toLowerCase();
      for (const want of wantNames) if (nm === want.toLowerCase() && out[want] == null) out[want] = numOrNull(s.value);
    }
  }
  return out;
}
export function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
export async function fetchTeamStats(teamId) {
  try {
    const d = await jget(`${ESPN_SITE}/teams/${teamId}/statistics`);
    const categories = (d.results && d.results.stats && d.results.stats.categories) || d.splits && d.splits.categories || d.categories || [];
    const off = pickCat(categories, ["netPassingYardsPerGame", "rushingYardsPerGame", "yardsPerGame", "totalPointsPerGame", "netPassingYards", "rushingYards"]);
    const def = pickCat(categories, ["yardsAllowedPerGame", "netPassingYardsAllowedPerGame", "rushingYardsAllowedPerGame", "sackRate", "totalSacks", "interceptions"]);
    return { off, def, raw: categories.length > 0 };
  } catch { return { off: {}, def: {}, raw: false }; }
}
/* ---- standings: points for/against per team (primary game-line input — always reliable) ---- */
export async function fetchStandings(year) {
  try {
    const d = await jget(`${ESPN_SITE.replace("/apis/site/v2", "/apis/v2")}/standings?season=${year}`);
    const out = {};
    const walk = (node) => {
      if (node && node.standings && node.standings.entries) {
        for (const e of node.standings.entries) {
          const id = e.team && +e.team.id; if (!id) continue;
          const stat = (name) => { const s = (e.stats || []).find((x) => x.name === name); return s ? numOrNull(s.value) : null; };
          const w = stat("wins") || 0, l = stat("losses") || 0, t = stat("ties") || 0;
          const g = Math.max(w + l + t, 1);
          out[id] = { pf: stat("pointsFor"), pa: stat("pointsAgainst"), g, ppgFor: (stat("pointsFor") || 0) / g, ppgAgainst: (stat("pointsAgainst") || 0) / g };
        }
      }
      for (const c of (node && node.children) || []) walk(c);
    };
    walk(d);
    return out;
  } catch { return {}; }
}

/* ---- weather (verbatim pattern from MLB — Open-Meteo, no key) ---- */
export async function fetchWeather(lat, lon) {
  try {
    const d = await jget(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation_probability,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=3&timezone=auto`);
    const i = new Date().getHours(); const h = d.hourly;
    return { temp: Math.round(h.temperature_2m && h.temperature_2m[i]), pop: h.precipitation_probability && h.precipitation_probability[i], wind: Math.round(h.wind_speed_10m && h.wind_speed_10m[i]) };
  } catch { return null; }
}

/* ---- boxscore (settling tracked bets) ---- */
export async function fetchGameSummary(eventId) {
  try {
    const d = await jget(`${ESPN_SITE}/summary?event=${eventId}`);
    const comp = d.header && d.header.competitions && d.header.competitions[0];
    const statusType = comp && comp.status && comp.status.type;
    // completed covers overtime the same as regulation (ESPN's flag is period-agnostic) —
    // no special OT handling needed here.
    const final = !!(statusType && statusType.completed);
    // A game ESPN has marked as never going to be played as scheduled (weather/logistics
    // cancellation, forfeit) will NEVER flip `completed` true — left alone it would sit open
    // forever. Postponed/suspended games are NOT included here: those are usually replayed
    // (often at the same event id) or resume later, so they're correctly left open until
    // ESPN resolves them one way or the other.
    const canceled = !!(statusType && /CANCELED|CANCELLED|FORFEIT/i.test(String(statusType.name || "")));
    const home = comp && (comp.competitors || []).find((c) => c.homeAway === "home");
    const away = comp && (comp.competitors || []).find((c) => c.homeAway === "away");
    const players = {};
    for (const team of (d.boxscore && d.boxscore.players) || []) {
      for (const cat of team.statistics || []) {
        const catName = cat.name || "";
        const labels = cat.labels || cat.names || [];
        const keys = cat.keys || [];
        for (const ath of cat.athletes || []) {
          const id = ath.athlete && ath.athlete.id; if (!id) continue;
          const p = (players[id] = players[id] || { participated: true });
          // namespace by category so a player who shows up in more than one (a receiving RB,
          // a rushing QB) doesn't have one category's "YDS"/"TD" clobber another's.
          const bucket = (p[catName] = p[catName] || {});
          (ath.stats || []).forEach((v, i) => {
            const key = keys[i], label = labels[i];
            const sv = String(v);
            if (sv.includes("/")) {
              // combined "made/attempted" cell (passing C/ATT "24/35", kicking FG "2/3", XP "1/1")
              const [a, b] = sv.split("/").map((x) => num(x));
              if (key) { bucket[`${key}#0`] = a; bucket[`${key}#1`] = b; }
              if (label) { bucket[`${label}#0`] = a; bucket[`${label}#1`] = b; }
            } else {
              const n = num(v);
              if (key) bucket[key] = n;
              if (label) bucket[label] = n;
            }
          });
        }
      }
    }
    return { final, canceled, homeScore: home ? +home.score : null, awayScore: away ? +away.score : null, players };
  } catch { return { final: false, canceled: false, homeScore: null, awayScore: null, players: {} }; }
}

/* ============================================================
   THE ODDS API — reuses the EXISTING odds-proxy edge function
   unmodified (it's already sport-agnostic: path+query passthrough).
   Only the sport key and market list change vs MLB.
   ============================================================ */
// odds-proxy fetch + Supabase config are shared (core/odds). normName stays NFL-local: it also strips a
// trailing "v" suffix, which the shared version doesn't, and changing it could change name matching.
export function normName(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z ]/g, " ").replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/\s+/g, " ").trim();
}
export async function fetchOddsEvents(sportKey) {
  const r = await oddsProxyFetch(`/sports/${sportKey}/events`, "dateFormat=iso");
  const remaining = r.headers.get("x-requests-remaining");
  if (!r.ok) throw new Error(`events ${r.status}`);
  const data = await r.json();
  return { events: data || [], remaining: remaining != null ? +remaining : null };
}
export async function fetchEventOdds(sportKey, eventId, book) {
  const markets = [...Object.values(TYPE_TO_MARKET), ...GAME_MARKETS].join(",");
  const r = await oddsProxyFetch(`/sports/${sportKey}/events/${eventId}/odds`, `regions=us&markets=${markets}&oddsFormat=american&bookmakers=${book}`);
  const remaining = r.headers.get("x-requests-remaining");
  if (!r.ok) throw new Error(`odds ${r.status}`);
  const data = await r.json();
  return { data, remaining: remaining != null ? +remaining : null };
}
export function matchEvent(events, g) {
  const hn = normName(g.homeName), an = normName(g.awayName);
  return (events || []).find((e) => normName(e.home_team).includes(hn) && normName(e.away_team).includes(an));
}
export const sideOf = (s) => { s = (s || "").toLowerCase().trim(); if (s === "over" || s === "yes") return "over"; if (s === "under" || s === "no") return "under"; return null; };
export function parseEventOdds(data, bookKey) {
  const bm = (data.bookmakers || []).find((b) => b.key === bookKey) || (data.bookmakers || [])[0];
  if (!bm) return [];
  const rows = [];
  for (const mk of bm.markets || []) {
    const type = MARKET_TO_TYPE[mk.key]; if (!type) continue;
    const byKey = {};
    for (const o of mk.outcomes || []) {
      let side = sideOf(o.name), player = o.description;
      if (!side && sideOf(o.description)) { side = sideOf(o.description); player = o.name; }
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
export function matchCurrentOdds(bet, rows, gl) {
  const t = bet.type, ln = Number(bet.line);
  if (t === "Moneyline") return gl && gl.h2h ? (bet.side === "home" ? gl.h2h.home : gl.h2h.away) ?? null : null;
  if (t === "Total") { if (!gl || !gl.totals || gl.totals.point == null || Math.abs(gl.totals.point - ln) > 1e-6) return null; return (bet.side === "over" ? gl.totals.over : gl.totals.under) ?? null; }
  if (t === "Spread") { if (!gl || !gl.spreads) return null; const pt = bet.side === "home" ? gl.spreads.homePoint : gl.spreads.awayPoint; if (pt == null || Math.abs(pt - ln) > 1e-6) return null; return (bet.side === "home" ? gl.spreads.home : gl.spreads.away) ?? null; }
  const bn = normName(bet.name);
  const r = (rows || []).find((x) => x.type === t && normName(x.player) === bn && Math.abs(x.point - ln) < 1e-6);
  if (!r) return null;
  return (bet.side === "over" ? r.over : r.under) ?? null;
}
// build moneyline / total / spread board entries from our model + market odds — mirrors MLB's
// buildGameLineEntries, using the NFL two-team NegBin grid (§2) instead of the run grid.
export function buildGameLineEntries(g, d, gl, book) {
  const entries = [];
  // Anchor the team-score projection to the market's own total + spread when it's available —
  // real, game-specific signal (personnel, coaching, pace, injuries the market already knows
  // about) that a standings-based model has no way to see before games are played. d.lambdaH/
  // d.lambdaA (season-standings-driven) is the same "average NFL team" estimate for every game
  // until real box scores accumulate — it's the fallback, not the primary source, once a market
  // line exists. This is what stops every game's Moneyline/Total/Spread proj from being identical.
  const mTotal = gl.totals && gl.totals.point != null ? gl.totals.point : null;
  const mHp = gl.spreads && gl.spreads.homePoint != null ? gl.spreads.homePoint : null; // negative = home favored
  let lambdaH = d.lambdaH, lambdaA = d.lambdaA;
  let anchor = "standings model";
  if (mTotal != null && mHp != null) {
    // home - away = -mHp (home favored by -mHp points); home + away = mTotal
    lambdaH = clamp((mTotal - mHp) / 2, 6, 45);
    lambdaA = clamp((mTotal + mHp) / 2, 6, 45);
    anchor = "market total/spread";
  }
  const projH = lambdaH, projA = lambdaA;
  const total = projH + projA;
  const totalPt = gl.totals && gl.totals.point != null ? gl.totals.point : null;
  const gp = jointGameProbs(lambdaH, lambdaA, 0, 0, totalPt);
  const base = `${anchor} line: ${g.away} ${projA.toFixed(1)} – ${projH.toFixed(1)} ${g.home}`;
  const mk = (name, type, line, side, odds, oppOdds, modelP0, proj, params) => {
    if (odds == null) return null;
    const imp = impliedProb(odds);
    const novig = oppOdds != null ? (imp / (imp + impliedProb(oppOdds))) : imp;
    const modelP = calibrateToMarket(modelP0, novig, type);
    const bm = odds > 0 ? odds / 100 : 100 / -odds;
    return {
      id: `${g.pk}-line-${type}-${side}`, gamePk: g.pk, game: `${g.away}@${g.home}`, gameTimeIso: g.gameTimeIso || null, name, type, line: String(line), side, odds, overOdds: null, underOdds: null, book,
      modelP, rawModelP: modelP0, proj, calc: { dist: "Two-NegBin", params, proj, baseStr: base, mults: [], live: null },
      imp, novig, edge: modelP - novig, ev: evPerUnit(modelP, odds), b: bm, fair: probToAmerican(modelP), devigged: oppOdds != null,
    };
  };
  if (gl.h2h) {
    const e1 = mk(`${g.home} ML`, "Moneyline", "", "home", gl.h2h.home, gl.h2h.away, gp.home, projH, "P(home win)");
    const e2 = mk(`${g.away} ML`, "Moneyline", "", "away", gl.h2h.away, gl.h2h.home, gp.away, projA, "P(away win)");
    if (e1) entries.push(e1); if (e2) entries.push(e2);
  }
  if (totalPt != null) {
    const e1 = mk(`Total ${totalPt}`, "Total", totalPt, "over", gl.totals.over, gl.totals.under, gp.over, total, `P(final total>${totalPt})`);
    const e2 = mk(`Total ${totalPt}`, "Total", totalPt, "under", gl.totals.under, gl.totals.over, gp.under, total, `P(final total<${totalPt})`);
    if (e1) entries.push(e1); if (e2) entries.push(e2);
  }
  if (gl.spreads && gl.spreads.homePoint != null) {
    const hp = gl.spreads.homePoint, ap = gl.spreads.awayPoint;
    const pHome = marginProb(lambdaH, lambdaA, 0, 0, (m) => m > -hp);
    const pAway = ap != null ? marginProb(lambdaH, lambdaA, 0, 0, (m) => m < ap) : 1 - pHome;
    const e1 = mk(`${g.home} ${hp > 0 ? "+" : ""}${hp}`, "Spread", hp, "home", gl.spreads.home, gl.spreads.away, pHome, projH - projA, `P(home margin > ${-hp})`);
    const e2 = mk(`${g.away} ${ap > 0 ? "+" : ""}${ap}`, "Spread", ap, "away", gl.spreads.away, gl.spreads.home, pAway, projA - projH, `P(home margin < ${ap})`);
    if (e1) entries.push(e1); if (e2) entries.push(e2);
  }
  return entries;
}

/* ---- settling helpers ----
   ESPN's box score groups a player's stats into CATEGORIES (passing, rushing, receiving,
   kicking, defensive, interceptions, …), each with its own `labels` (display, e.g. "YDS")
   AND `keys` (semantic, e.g. "passingYards") arrays — but several categories reuse the same
   bare label ("YDS"/"TD" all appear in passing, rushing, receiving AND kicking/return
   categories; "INT" appears in BOTH passing [thrown] and the separate interceptions
   category [picks made]). A player who shows up in more than one category in the same game
   — any receiving RB, any rushing QB — would silently have one category's number clobber
   another's if stats were flattened into one bare-label bag. fetchGameSummary below keys
   each player's stats by CATEGORY first (players[id][categoryName][field]), and this table
   matches on (category, field) pairs — field tried as the semantic key first, falling back
   to the display label, the same tolerant-matching posture STAT_ALIASES uses for gamelogs. */
export const BOX_STAT_FOR = {
  "Pass Yards": [["passing", "passingYards"], ["passing", "YDS"]],
  "Pass TDs": [["passing", "passingTouchdowns"], ["passing", "TD"]],
  "Interceptions": [["passing", "interceptions"], ["passing", "INT"]],
  // ESPN's passing box score reports completions/attempts as ONE combined cell ("24/35", label
  // "C/ATT") — not separate "CMP"/"ATT" fields. fetchGameSummary splits that combined cell into
  // "<key>#0" (made/completions) and "<key>#1" (attempted) so each half is gradeable on its own.
  "Pass Completions": [["passing", "completions/passingAttempts#0"]],
  "Pass Attempts": [["passing", "completions/passingAttempts#1"]],
  "Rush Yards": [["rushing", "rushingYards"], ["rushing", "YDS"]],
  "Rush TDs": [["rushing", "rushingTouchdowns"], ["rushing", "TD"]],
  "Longest Rush": [["rushing", "longRushing"], ["rushing", "LONG"]],
  "Receptions": [["receiving", "receptions"], ["receiving", "REC"]],
  "Receiving Yards": [["receiving", "receivingYards"], ["receiving", "YDS"]],
  "Receiving TDs": [["receiving", "receivingTouchdowns"], ["receiving", "TD"]],
  "Longest Reception": [["receiving", "longReception"], ["receiving", "LONG"]],
  "Kicking Points": [["kicking", "totalKickingPoints"], ["kicking", "PTS"]],
  "Field Goals Made": [["kicking", "fieldGoalsMade/fieldGoalAttempts#0"]],
  "Sacks": [["defensive", "sacks"], ["defensive", "SACKS"]],
  "Def. Interceptions": [["interceptions", "interceptions"], ["interceptions", "INT"]],
  // no "Longest Completion" here: ESPN's box score summary doesn't carry that field at all
  // (only longest rush / longest reception). actualFor() returns null for it and the two
  // settlement functions (settleBets/settleFullBoardLog) fall back to fetchLongCmpForEvent(),
  // which pulls it from the player's gamelog instead — see that function for why.
};
export function actualFor(type, ps) {
  if (!ps) return null; // handled upstream: player never appeared anywhere in the box score -> void/DNP
  if (type === "Anytime TD") {
    // matches projectAnytimeTD's own definition (union of rush-TD and rec-TD probability):
    // a thrown TD pass doesn't count — the QB isn't the one "scoring" it for this market.
    const rushTd = (ps.rushing && (ps.rushing.rushingTouchdowns ?? ps.rushing.TD)) || 0;
    const recTd = (ps.receiving && (ps.receiving.receivingTouchdowns ?? ps.receiving.TD)) || 0;
    return rushTd + recTd;
  }
  const cands = BOX_STAT_FOR[type];
  if (!cands) return null;
  for (const [cat, field] of cands) {
    const bucket = ps[cat];
    if (bucket && bucket[field] != null) return bucket[field];
  }
  // Player DID appear in the box score (participated) but recorded nothing in this specific
  // category — e.g. an RB with zero carries this week. That's a real, gradeable zero, not an
  // unknown to leave open forever (mirrors MLB: a batter with 0 hits still grades, not voids).
  return 0;
}
export function gradeLine(type, side, point, homeScore, awayScore) {
  if (homeScore == null || awayScore == null) return { status: null, actual: null };
  if (type === "Moneyline") {
    if (homeScore === awayScore) return { status: "push", actual: `${awayScore}-${homeScore}` }; // NFL ties are real
    const homeWin = homeScore > awayScore;
    const win = side === "home" ? homeWin : !homeWin;
    return { status: win ? "won" : "lost", actual: `${awayScore}-${homeScore}` };
  }
  if (type === "Total") {
    const tot = homeScore + awayScore;
    if (tot === point) return { status: "push", actual: tot };
    const over = tot > point;
    return { status: (side === "over" ? over : !over) ? "won" : "lost", actual: tot };
  }
  if (type === "Spread") {
    const margin = side === "home" ? (homeScore - awayScore) : (awayScore - homeScore);
    if (margin + point === 0) return { status: "push", actual: `${awayScore}-${homeScore}` };
    return { status: (margin + point) > 0 ? "won" : "lost", actual: `${awayScore}-${homeScore}` };
  }
  return { status: null, actual: null };
}
