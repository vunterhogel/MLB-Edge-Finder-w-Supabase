/* NBA reference data + market config (moved from the old NBAApp.tsx). */
/* ---------- team reference (ESPN id-keyed) ----------
   Standard, long-stable ESPN NBA team id scheme. Verify against a live
   GET /apis/site/v2/sports/basketball/nba/teams before relying on it —
   same "verify/adjust yearly" caution the NFL app gives its STADIUMS
   table, since this file was written without network access to confirm
   it live. */
export const TEAMS = {
  1: { ab: "ATL", name: "Hawks" }, 2: { ab: "BOS", name: "Celtics" },
  17: { ab: "BKN", name: "Nets" }, 30: { ab: "CHA", name: "Hornets" },
  4: { ab: "CHI", name: "Bulls" }, 5: { ab: "CLE", name: "Cavaliers" },
  6: { ab: "DAL", name: "Mavericks" }, 7: { ab: "DEN", name: "Nuggets" },
  8: { ab: "DET", name: "Pistons" }, 9: { ab: "GS", name: "Warriors" },
  10: { ab: "HOU", name: "Rockets" }, 11: { ab: "IND", name: "Pacers" },
  12: { ab: "LAC", name: "Clippers" }, 13: { ab: "LAL", name: "Lakers" },
  29: { ab: "MEM", name: "Grizzlies" }, 14: { ab: "MIA", name: "Heat" },
  15: { ab: "MIL", name: "Bucks" }, 16: { ab: "MIN", name: "Timberwolves" },
  3: { ab: "NO", name: "Pelicans" }, 18: { ab: "NY", name: "Knicks" },
  25: { ab: "OKC", name: "Thunder" }, 19: { ab: "ORL", name: "Magic" },
  20: { ab: "PHI", name: "76ers" }, 21: { ab: "PHX", name: "Suns" },
  22: { ab: "POR", name: "Trail Blazers" }, 23: { ab: "SAC", name: "Kings" },
  24: { ab: "SA", name: "Spurs" }, 28: { ab: "TOR", name: "Raptors" },
  26: { ab: "UTAH", name: "Jazz" }, 27: { ab: "WSH", name: "Wizards" },
};
export const ABBR_TO_NAME = Object.fromEntries(Object.values(TEAMS).map((t) => [t.ab, t.name]));
export function matchesQuery(item, q) {
  if (!q) return true;
  const parts = [item.name || "", item.game || ""];
  for (const ab of String(item.game || "").split("@")) { const nm = ABBR_TO_NAME[ab.trim()]; if (nm) parts.push(nm); }
  return parts.join(" ").toLowerCase().includes(q.toLowerCase().trim());
}
export const LG_PPG = 114.0;          // league-avg team points/game (prior — retune from settled Stats data)
export const LG_PACE = 99.5;          // league-avg possessions/48 min (prior)
export const NBA_PTS_PHI = 1.3;       // team points variance ≈ NBA_PTS_PHI × mean — far less overdispersed than NFL (6.5) or MLB runs (2.0)
export const HOME_COURT_MULT = { home: 1.015, away: 0.985 }; // ~2.5-3pt NBA home edge on a ~225pt combined total, proportionally like NFL's home field mult

/* ---------- prop + odds config ---------- */
export const CORE_PROPS = ["Points", "Rebounds", "Assists", "Three-Pointers Made", "Steals", "Blocks", "Turnovers"];
export const COMBO_PROPS = ["Pts+Reb+Ast", "Pts+Reb", "Pts+Ast", "Reb+Ast", "Blocks+Steals"];
export const SPECIAL_PROPS = ["Double-Double", "Triple-Double"];
export const ALL_PLAYER_PROPS = [...CORE_PROPS, ...COMBO_PROPS, ...SPECIAL_PROPS];
export const DEFAULT_LINE = {
  "Points": "22.5", "Rebounds": "7.5", "Assists": "5.5", "Three-Pointers Made": "2.5",
  "Steals": "1.5", "Blocks": "1.5", "Turnovers": "2.5",
  "Pts+Reb+Ast": "35.5", "Pts+Reb": "28.5", "Pts+Ast": "27.5", "Reb+Ast": "12.5", "Blocks+Steals": "2.5",
  "Double-Double": "0.5", "Triple-Double": "0.5",
};
export const ODDS_SPORT = "basketball_nba";
export const TYPE_TO_MARKET = {
  "Points": "player_points", "Rebounds": "player_rebounds", "Assists": "player_assists",
  "Three-Pointers Made": "player_threes", "Steals": "player_steals", "Blocks": "player_blocks", "Turnovers": "player_turnovers",
  "Pts+Reb+Ast": "player_points_rebounds_assists", "Pts+Reb": "player_points_rebounds", "Pts+Ast": "player_points_assists",
  "Reb+Ast": "player_rebounds_assists", "Blocks+Steals": "player_blocks_steals",
  "Double-Double": "player_double_double", "Triple-Double": "player_triple_double",
};
export const MARKET_TO_TYPE = Object.fromEntries(Object.entries(TYPE_TO_MARKET).map(([k, v]) => [v, k]));
export const GAME_MARKETS = ["h2h", "spreads", "totals"]; // moneyline, spread, total — identical shape to MLB/NFL
export const GAME_PROPS = ["Moneyline", "Spread", "Total"];
export const CATEGORY_ORDER = [...CORE_PROPS, ...COMBO_PROPS, ...SPECIAL_PROPS, ...GAME_PROPS];
export const isLineType = (t) => GAME_PROPS.includes(t);
// Projection-vs-line signal thresholds (core/signals.ts). Empty until there is enough settled board-log
// data to fit them per market, the way MLB's were; the Board shows the same signal column and filter.
export const SIGNAL_RULES = {};
export const isYesNoType = (t) => t === "Double-Double" || t === "Triple-Double";
export const BOOKS = [
  { key: "draftkings", label: "DraftKings" }, { key: "fanduel", label: "FanDuel" },
  { key: "betmgm", label: "BetMGM" }, { key: "caesars", label: "Caesars" },
  { key: "espnbet", label: "ESPN BET" }, { key: "fanatics", label: "Fanatics" },
];
export const BOOK_LABELS = { ...Object.fromEntries(BOOKS.map((b) => [b.key, b.label])), manual: "Manual" };
export const ODDS_TESTING_LIMIT = 400; // per-session safety rail against runaway loops — same rail as MLB/NFL
