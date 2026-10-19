/* ============================================================
   NHL EDGE FINDER (runs on the shared SportApp shell)
   DATA (all browser-reachable, no keys):
     - ESPN site/web APIs (hockey/nhl): scoreboard + probable goalies,
       team rosters with injuries, athlete game logs, team season
       stats, game summaries (live + final box scores for settling).
       api-web.nhle.com is NOT used client-side: it sends no CORS
       header, so browsers block it. ESPN does.
     - The Odds API via the existing odds-proxy edge function.
   ============================================================ */

export const SPORT_PATH = "hockey/nhl";
export const ODDS_SPORT = "icehockey_nhl";

/* league reference rates (per team per game, recent seasons) */
export const LG = {
  goals: 3.05,        // goals per team per game (regulation + OT/SO credit)
  shots: 28.5,        // shots on goal per team per game
  svPct: 0.900,       // league save %
  ppPct: 0.21,
};

/* positional priors per game, used to shrink thin samples */
export const PRIOR = {
  F: { sog: 1.75, g: 0.21, a: 0.30, ppp: 0.10, toi: 15.5 },
  D: { sog: 1.25, g: 0.06, a: 0.25, ppp: 0.08, toi: 20.0 },
};
/* games of prior mixed in (bigger = more regression to the position average) */
export const SHRINK_G = { sog: 8, g: 30, a: 25, ppp: 30, toi: 4 };
export const PRIOR_SEASON_WEIGHT = 0.5;   // a prior-season game counts half a current-season game
export const PRIOR_SEASON_MAX = 60;       // only the most recent 60 prior-season games are used

export const SKATER_PROPS = ["Shots on Goal", "Points", "Goals", "Assists", "Power Play Points"];
export const GOALIE_PROPS = ["Saves"];
export const ALL_PROPS = [...SKATER_PROPS, ...GOALIE_PROPS];
export const DEFAULT_LINE = { "Shots on Goal": "2.5", "Points": "0.5", "Goals": "0.5", "Assists": "0.5", "Power Play Points": "0.5", "Saves": "25.5" };
export const TYPE_TO_MARKET = {
  "Shots on Goal": "player_shots_on_goal", "Points": "player_points", "Goals": "player_goals",
  "Assists": "player_assists", "Power Play Points": "player_power_play_points", "Saves": "player_total_saves",
};
export const MARKET_TO_TYPE = Object.fromEntries(Object.entries(TYPE_TO_MARKET).map(([k, v]) => [v, k]));
export const GAME_MARKETS = ["h2h", "spreads", "totals"];
export const GAME_PROPS = ["Moneyline", "Puck Line", "Total"];
export const CATEGORY_ORDER = [...SKATER_PROPS, ...GOALIE_PROPS, ...GAME_PROPS];
export const STAT_ORDER = CATEGORY_ORDER;
export const TREND_PROPS = ALL_PROPS;
export const isLineType = (t) => GAME_PROPS.includes(t);
export const BOOKS = [
  { key: "draftkings", label: "DraftKings" }, { key: "fanduel", label: "FanDuel" },
  { key: "betmgm", label: "BetMGM" }, { key: "caesars", label: "Caesars" },
  { key: "espnbet", label: "ESPN BET" }, { key: "fanatics", label: "Fanatics" },
];
export const BOOK_LABELS = { ...Object.fromEntries(BOOKS.map((b) => [b.key, b.label])), manual: "Manual" };
export const ODDS_TESTING_LIMIT = 400;

export function matchesQuery(e, q) {
  const s = String(q || "").trim().toLowerCase();
  if (!s) return true;
  return `${e.name || ""} ${e.game || ""} ${e.type || ""}`.toLowerCase().includes(s);
}
