/* NFL reference data + market config (moved from the old src/nfl/NFLApp.tsx, values unchanged). */
/* ---------- team + stadium reference (ESPN id-keyed, stable) ---------- */
export const TEAMS = {
  1: { ab: "ATL", name: "Falcons" }, 2: { ab: "BUF", name: "Bills" },
  3: { ab: "CHI", name: "Bears" }, 4: { ab: "CIN", name: "Bengals" },
  5: { ab: "CLE", name: "Browns" }, 6: { ab: "DAL", name: "Cowboys" },
  7: { ab: "DEN", name: "Broncos" }, 8: { ab: "DET", name: "Lions" },
  9: { ab: "GB", name: "Packers" }, 10: { ab: "TEN", name: "Titans" },
  11: { ab: "IND", name: "Colts" }, 12: { ab: "KC", name: "Chiefs" },
  13: { ab: "LV", name: "Raiders" }, 14: { ab: "LAR", name: "Rams" },
  15: { ab: "MIA", name: "Dolphins" }, 16: { ab: "MIN", name: "Vikings" },
  17: { ab: "NE", name: "Patriots" }, 18: { ab: "NO", name: "Saints" },
  19: { ab: "NYG", name: "Giants" }, 20: { ab: "NYJ", name: "Jets" },
  21: { ab: "PHI", name: "Eagles" }, 22: { ab: "ARI", name: "Cardinals" },
  23: { ab: "PIT", name: "Steelers" }, 24: { ab: "LAC", name: "Chargers" },
  25: { ab: "SF", name: "49ers" }, 26: { ab: "SEA", name: "Seahawks" },
  27: { ab: "TB", name: "Buccaneers" }, 28: { ab: "WSH", name: "Commanders" },
  29: { ab: "CAR", name: "Panthers" }, 30: { ab: "JAX", name: "Jaguars" },
  33: { ab: "BAL", name: "Ravens" }, 34: { ab: "HOU", name: "Texans" },
};
export const ABBR_TO_NAME = Object.fromEntries(Object.values(TEAMS).map((t) => [t.ab, t.name]));
export const ABBR_TO_ESPN_ID = Object.fromEntries(Object.entries(TEAMS).map(([id, t]) => [t.ab, +id]));
// search a board entry / tracked bet by player name, team abbrev, or team nickname
export function matchesQuery(item, q) {
  if (!q) return true;
  const parts = [item.name || "", item.game || ""];
  for (const ab of String(item.game || "").split("@")) { const nm = ABBR_TO_NAME[ab.trim()]; if (nm) parts.push(nm); }
  return parts.join(" ").toLowerCase().includes(q.toLowerCase().trim());
}
// STADIUMS: dome=true for fixed roofs AND retractable roofs normally played closed
// (same simplification MLB's PARKS.dome makes for Tampa Bay/Toronto/Texas/Arizona/
// Miami/Milwaukee/Houston — no per-game roof-status feed, so we treat "usually
// closed" as weather-neutral). Verify/adjust yearly — stadiums, names, and roof
// defaults change (e.g. Buffalo's new Highmark Stadium opened for the 2026 season,
// still outdoor; Washington's stadium naming has changed hands more than once).
export const STADIUMS = {
  1: { lat: 33.7554, lon: -84.4008, dome: true },   // ATL - Mercedes-Benz Stadium (retractable, usually closed)
  2: { lat: 42.7738, lon: -78.7870, dome: false },  // BUF - Highmark Stadium (new 2026, outdoor)
  3: { lat: 41.8623, lon: -87.6167, dome: false },  // CHI - Soldier Field
  4: { lat: 39.0955, lon: -84.5160, dome: false },  // CIN - Paycor Stadium
  5: { lat: 41.5061, lon: -81.6995, dome: false },  // CLE - Huntington Bank Field
  6: { lat: 32.7473, lon: -97.0945, dome: true },   // DAL - AT&T Stadium (retractable, usually closed)
  7: { lat: 39.7439, lon: -105.0201, dome: false }, // DEN - Empower Field at Mile High
  8: { lat: 42.3400, lon: -83.0456, dome: true },   // DET - Ford Field
  9: { lat: 44.5013, lon: -88.0622, dome: false },  // GB - Lambeau Field
  10: { lat: 36.1665, lon: -86.7713, dome: false }, // TEN - Nissan Stadium
  11: { lat: 39.7601, lon: -86.1639, dome: true },  // IND - Lucas Oil Stadium (retractable, usually closed)
  12: { lat: 39.0489, lon: -94.4839, dome: false }, // KC - Arrowhead Stadium
  13: { lat: 36.0909, lon: -115.1833, dome: true }, // LV - Allegiant Stadium
  14: { lat: 33.9535, lon: -118.3392, dome: true }, // LAR - SoFi Stadium (fixed climate-controlled roof)
  15: { lat: 25.9580, lon: -80.2389, dome: false }, // MIA - Hard Rock Stadium (open field)
  16: { lat: 44.9738, lon: -93.2575, dome: true },  // MIN - U.S. Bank Stadium
  17: { lat: 42.0909, lon: -71.2643, dome: false }, // NE - Gillette Stadium
  18: { lat: 29.9511, lon: -90.0812, dome: true },  // NO - Caesars Superdome
  19: { lat: 40.8135, lon: -74.0745, dome: false }, // NYG - MetLife Stadium
  20: { lat: 40.8135, lon: -74.0745, dome: false }, // NYJ - MetLife Stadium
  21: { lat: 39.9008, lon: -75.1675, dome: false }, // PHI - Lincoln Financial Field
  22: { lat: 33.5276, lon: -112.2626, dome: true }, // ARI - State Farm Stadium (retractable, usually closed)
  23: { lat: 40.4468, lon: -80.0158, dome: false }, // PIT - Acrisure Stadium
  24: { lat: 33.9535, lon: -118.3392, dome: true }, // LAC - SoFi Stadium
  25: { lat: 37.4032, lon: -121.9698, dome: false }, // SF - Levi's Stadium
  26: { lat: 47.5952, lon: -122.3316, dome: false }, // SEA - Lumen Field (open air)
  27: { lat: 27.9759, lon: -82.5033, dome: false }, // TB - Raymond James Stadium
  28: { lat: 38.9078, lon: -76.8645, dome: false }, // WSH - Northwest Stadium (Landover, MD)
  29: { lat: 35.2258, lon: -80.8528, dome: false }, // CAR - Bank of America Stadium
  30: { lat: 30.3239, lon: -81.6373, dome: false }, // JAX - EverBank Stadium
  33: { lat: 39.2780, lon: -76.6227, dome: false }, // BAL - M&T Bank Stadium
  34: { lat: 29.6847, lon: -95.4107, dome: true },  // HOU - NRG Stadium (retractable, usually closed)
};
export const LG_PPG = 22.0;          // league-avg points/team/game (prior — retune from settled Stats data)
export const NFL_PTS_PHI = 6.5;      // team points variance ≈ NFL_PTS_PHI × mean (overdispersed, like MLB's RUNS_PHI=2.0 for runs)
export const HOME_FIELD_MULT = { home: 1.015, away: 0.985 }; // small, well-documented NFL home edge (~1-1.5 pts on ~44 combined)
export const LG_PLAYS_PER_GAME = 63.5; // league-avg offensive plays/team/game, for pace multiplier

/* ---------- prop + odds config ---------- */
export const QB_PROPS = ["Pass Yards", "Pass TDs", "Interceptions", "Pass Completions", "Pass Attempts", "Longest Completion"];
export const RB_PROPS = ["Rush Yards", "Rush TDs", "Receptions", "Receiving Yards", "Longest Rush"];
export const WR_PROPS = ["Receptions", "Receiving Yards", "Receiving TDs", "Longest Reception"];
export const TD_PROPS = ["Anytime TD"];
export const K_PROPS = ["Kicking Points", "Field Goals Made"];
export const DST_PROPS = ["Sacks", "Def. Interceptions"];
export const ALL_PLAYER_PROPS = [...new Set([...QB_PROPS, ...RB_PROPS, ...WR_PROPS, ...TD_PROPS, ...K_PROPS, ...DST_PROPS])];
export const DEFAULT_LINE = {
  "Pass Yards": "249.5", "Pass TDs": "1.5", "Interceptions": "0.5", "Pass Completions": "22.5", "Pass Attempts": "34.5", "Longest Completion": "23.5",
  "Rush Yards": "59.5", "Rush TDs": "0.5", "Longest Rush": "11.5",
  "Receptions": "4.5", "Receiving Yards": "54.5", "Receiving TDs": "0.5", "Longest Reception": "20.5",
  "Anytime TD": "0.5", "Kicking Points": "6.5", "Field Goals Made": "1.5", "Sacks": "2.5", "Def. Interceptions": "0.5",
};
export const ODDS_SPORT = "americanfootball_nfl";
export const ODDS_SPORT_PRESEASON = "americanfootball_nfl_preseason";
export const TYPE_TO_MARKET = {
  "Pass Yards": "player_pass_yds", "Pass TDs": "player_pass_tds", "Interceptions": "player_pass_interceptions",
  "Pass Completions": "player_pass_completions", "Pass Attempts": "player_pass_attempts", "Longest Completion": "player_pass_longest_completion",
  "Rush Yards": "player_rush_yds", "Rush TDs": "player_rush_tds", "Longest Rush": "player_rush_longest",
  "Receptions": "player_receptions", "Receiving Yards": "player_reception_yds", "Receiving TDs": "player_reception_tds", "Longest Reception": "player_reception_longest",
  "Anytime TD": "player_anytime_td",
  "Kicking Points": "player_kicking_points", "Field Goals Made": "player_field_goals",
  "Sacks": "player_sacks", "Def. Interceptions": "player_defensive_interceptions",
};
export const MARKET_TO_TYPE = Object.fromEntries(Object.entries(TYPE_TO_MARKET).map(([k, v]) => [v, k]));
export const GAME_MARKETS = ["h2h", "spreads", "totals"];        // moneyline, spread, total — identical shape to MLB
export const GAME_PROPS = ["Moneyline", "Spread", "Total"];
export const CATEGORY_ORDER = [...QB_PROPS, ...RB_PROPS.filter((p) => !QB_PROPS.includes(p)), ...WR_PROPS.filter((p) => !RB_PROPS.includes(p) && !QB_PROPS.includes(p)), ...TD_PROPS, ...K_PROPS, ...DST_PROPS, ...GAME_PROPS];
export const isLineType = (t) => GAME_PROPS.includes(t);
export const BOOKS = [
  { key: "draftkings", label: "DraftKings" }, { key: "fanduel", label: "FanDuel" },
  { key: "betmgm", label: "BetMGM" }, { key: "caesars", label: "Caesars" },
  { key: "espnbet", label: "ESPN BET" }, { key: "fanatics", label: "Fanatics" },
];
export const BOOK_LABELS = { ...Object.fromEntries(BOOKS.map((b) => [b.key, b.label])), manual: "Manual" };
export const ODDS_TESTING_LIMIT = 400; // per-session safety rail against runaway loops — same rail as MLB
