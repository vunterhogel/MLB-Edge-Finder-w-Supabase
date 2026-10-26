import { SUPABASE_URL } from "../../core/odds";


/* ============================================================
   MLB EDGE FINDER v4
   ------------------------------------------------------------
   DATA (all browser-reachable):
     - statsapi.mlb.com : schedule, probables, posted lineups,
       season + last-15 logs, batter-vs-pitcher, team run env,
       live & final box scores (for live odds and settling).
     - api.open-meteo.com : per-ballpark game-time weather.
     - api.the-odds-api.com : live player-prop odds (DraftKings
       default, book selectable). Player-prop markets map 1:1 to
       our six stats. Odds are fetched PER GAME on demand to keep
       credit use intentional during testing.

   FORMULA TWEAKS in v4 (vs v3):
     1. DE-VIG: edge = model - no-vig implied (both sides used).
        Previously compared to raw vigged implied -> overstated
        edge by ~half the vig. EV still uses the real price.
     2. Dispersion recalibrated: TB 1.6, HRR 1.5, K 1.3, Outs 1.25.
     3. Recent blend only applies when L15 AB >= MIN_L15_AB (20).
     4. Light early-sample shrinkage of hitter rates toward league
        priors (gated by SHRINK_ENABLED).
     5. Board ranks against the BOOK'S line, not our default lines.

   TABS: Slate · Board (categorized, sortable) · My Bets
   (tracked, editable odds, persisted) · Stats (win% / ROI,
   settled from final box scores). My Bets + Stats persist to
   localStorage (works outside Claude / in your own deploy).

   Structured edge-finder, not a money printer. Projection priors
   are reasonable but uncalibrated until the Stats tab has a real
   sample to tune against.
   ============================================================ */

/* ---------- team + park reference (id-keyed, stable) ---------- */
export const TEAMS = {
  108: { ab: "LAA", name: "Angels" }, 109: { ab: "AZ", name: "Diamondbacks" },
  110: { ab: "BAL", name: "Orioles" }, 111: { ab: "BOS", name: "Red Sox" },
  112: { ab: "CHC", name: "Cubs" }, 113: { ab: "CIN", name: "Reds" },
  114: { ab: "CLE", name: "Guardians" }, 115: { ab: "COL", name: "Rockies" },
  116: { ab: "DET", name: "Tigers" }, 117: { ab: "HOU", name: "Astros" },
  118: { ab: "KC", name: "Royals" }, 119: { ab: "LAD", name: "Dodgers" },
  120: { ab: "WSH", name: "Nationals" }, 121: { ab: "NYM", name: "Mets" },
  133: { ab: "ATH", name: "Athletics" }, 134: { ab: "PIT", name: "Pirates" },
  135: { ab: "SD", name: "Padres" }, 136: { ab: "SEA", name: "Mariners" },
  137: { ab: "SF", name: "Giants" }, 138: { ab: "STL", name: "Cardinals" },
  139: { ab: "TB", name: "Rays" }, 140: { ab: "TEX", name: "Rangers" },
  141: { ab: "TOR", name: "Blue Jays" }, 142: { ab: "MIN", name: "Twins" },
  143: { ab: "PHI", name: "Phillies" }, 144: { ab: "ATL", name: "Braves" },
  145: { ab: "CWS", name: "White Sox" }, 146: { ab: "MIA", name: "Marlins" },
  147: { ab: "NYY", name: "Yankees" }, 158: { ab: "MIL", name: "Brewers" },
};
export const ABBR_TO_NAME = Object.fromEntries(Object.values(TEAMS).map((t) => [t.ab, t.name]));
// search a board entry / tracked bet by player name, team abbrev, or team nickname
export function matchesQuery(item, q) {
  if (!q) return true;
  const parts = [item.name || "", item.game || ""];
  for (const ab of String(item.game || "").split("@")) { const nm = ABBR_TO_NAME[ab.trim()]; if (nm) parts.push(nm); }
  return parts.join(" ").toLowerCase().includes(q.toLowerCase().trim());
}
export const PARKS = {
  108: { rf: 0.98, elev: 160, lat: 33.8003, lon: -117.8827, dome: false },
  109: { rf: 1.03, elev: 1100, lat: 33.4453, lon: -112.0667, dome: true },
  110: { rf: 1.02, elev: 33, lat: 39.2839, lon: -76.6217, dome: false },
  111: { rf: 1.07, elev: 20, lat: 42.3467, lon: -71.0972, dome: false },
  112: { rf: 1.02, elev: 600, lat: 41.9484, lon: -87.6553, dome: false },
  113: { rf: 1.09, elev: 550, lat: 39.0975, lon: -84.5066, dome: false },
  114: { rf: 0.98, elev: 660, lat: 41.4962, lon: -81.6852, dome: false },
  115: { rf: 1.18, elev: 5200, lat: 39.7559, lon: -104.9942, dome: false },
  116: { rf: 0.97, elev: 585, lat: 42.3390, lon: -83.0485, dome: false },
  117: { rf: 1.02, elev: 50, lat: 29.7570, lon: -95.3555, dome: true },
  118: { rf: 1.00, elev: 750, lat: 39.0517, lon: -94.4803, dome: false },
  119: { rf: 0.98, elev: 510, lat: 34.0739, lon: -118.2400, dome: false },
  120: { rf: 1.01, elev: 25, lat: 38.8730, lon: -77.0074, dome: false },
  121: { rf: 0.97, elev: 20, lat: 40.7571, lon: -73.8458, dome: false },
  133: { rf: 1.05, elev: 25, lat: 38.5802, lon: -121.5135, dome: false },
  134: { rf: 0.98, elev: 730, lat: 40.4469, lon: -80.0057, dome: false },
  135: { rf: 0.96, elev: 60, lat: 32.7073, lon: -117.1566, dome: false },
  136: { rf: 0.94, elev: 130, lat: 47.5914, lon: -122.3325, dome: false },
  137: { rf: 0.94, elev: 10, lat: 37.7786, lon: -122.3893, dome: false },
  138: { rf: 0.99, elev: 465, lat: 38.6226, lon: -90.1928, dome: false },
  139: { rf: 0.95, elev: 15, lat: 27.7683, lon: -82.6534, dome: true },
  140: { rf: 0.97, elev: 545, lat: 32.7473, lon: -97.0820, dome: true },
  141: { rf: 1.02, elev: 280, lat: 43.6414, lon: -79.3894, dome: true },
  142: { rf: 1.01, elev: 815, lat: 44.9817, lon: -93.2776, dome: false },
  143: { rf: 1.06, elev: 60, lat: 39.9061, lon: -75.1665, dome: false },
  144: { rf: 1.02, elev: 1050, lat: 33.8908, lon: -84.4678, dome: false },
  145: { rf: 1.01, elev: 595, lat: 41.8299, lon: -87.6338, dome: false },
  146: { rf: 0.97, elev: 10, lat: 25.7780, lon: -80.2197, dome: true },
  147: { rf: 1.03, elev: 55, lat: 40.8296, lon: -73.9262, dome: false },
  158: { rf: 1.01, elev: 635, lat: 43.0280, lon: -87.9712, dome: true },
};
export const LG_RPG = 4.4;
export const LG_KRATE = 0.22;   // league avg batter strikeouts per plate appearance
// opposing-starter skill layer (Priority 1): league reference rates + FIP constant
export const LG_FIP = 4.05, LG_KPCT = 0.22, LG_BBPCT = 0.082, FIP_CONST = 3.10;
export const STARTER_SHARE = 0.6;

// Optional Baseball Savant game-feed layer. Keep blank for direct fetch during local testing.
// For hosted/public deploys, route through a serverless proxy that accepts ?url=<encoded target>.
export const SAVANT_BASE = "https://baseballsavant.mlb.com";
export const STATCAST_PROXY_BASE = `${SUPABASE_URL}/functions/v1/statcast-proxy`;
export const STATCAST_MIN_BBE = 1;
// Season-to-date Statcast Search CSV layer. Uses Savant statcast_search/csv and caches
// player aggregates so pregame boards do not re-download the same player every expansion.
// Browser fetches to Savant may require STATCAST_PROXY_BASE in hosted deployments.
export const STATCAST_SEASON_TTL_MS = 6 * 60 * 60 * 1000; // 6h cache: current enough for daily slate work
export const STATCAST_SEASON_MIN_BBE_HITTER = 15;
export const STATCAST_SEASON_MIN_BBE_PITCHER = 25;
export const LG_XBA = 0.245, LG_XWOBA = 0.320, LG_HARDHIT = 0.385, LG_BARREL = 0.080, LG_FB = 0.240, LG_PULL_FB = 0.095;
export const LG_PITCHER_HR9 = 1.10, LG_PITCHER_XWOBA_ALLOWED = 0.320, LG_PITCHER_BARREL_ALLOWED = 0.080, LG_PITCHER_HARDHIT_ALLOWED = 0.385;


/* ---------- prop + odds config ---------- */
export const HITTER_PROPS = ["Hits", "Total Bases", "Home Run", "H+R+RBI"];
export const PITCHER_PROPS = ["Strikeouts", "Outs"];
export const ALL_PROPS = [...HITTER_PROPS, ...PITCHER_PROPS];
export const DEFAULT_LINE = { "Hits": "0.5", "Total Bases": "1.5", "Home Run": "0.5", "H+R+RBI": "1.5", "Strikeouts": "5.5", "Outs": "16.5" };
export const ODDS_SPORT = "baseball_mlb";
export const TYPE_TO_MARKET = {
  "Hits": "batter_hits", "Total Bases": "batter_total_bases", "Home Run": "batter_home_runs",
  "H+R+RBI": "batter_hits_runs_rbis", "Strikeouts": "pitcher_strikeouts", "Outs": "pitcher_outs",
};
export const MARKET_TO_TYPE = Object.fromEntries(Object.entries(TYPE_TO_MARKET).map(([k, v]) => [v, k]));
export const GAME_MARKETS = ["h2h", "spreads", "totals"];        // moneyline, run line, total
export const GAME_PROPS = ["Moneyline", "Run Line", "Total"];
export const CATEGORY_ORDER = [...HITTER_PROPS, ...PITCHER_PROPS, ...GAME_PROPS];
export const isLineType = (t) => GAME_PROPS.includes(t);
// Projection-vs-line signal thresholds (core/signals.ts), fit from Sep 2-7 settled data.
// TB / H+R+RBI: |delta| (both directions meaningful). Hits / K: direction-only (projection above the line).
// Outs, HR and game lines have no rule: the delta signal was unreliable or inverted for them.
export const SIGNAL_RULES = {
  "Total Bases": { mode: "abs", strong: 1.0, moderate: 0.75 },
  "H+R+RBI": { mode: "abs", strong: 1.0, moderate: 0.75 },
  "Hits": { mode: "over", strong: 0.5, moderate: 0 },
  "Strikeouts": { mode: "over", moderate: 0 },   // no strong tier: direction only
};
export const BOOKS = [
  { key: "draftkings", label: "DraftKings" }, { key: "fanduel", label: "FanDuel" },
  { key: "betmgm", label: "BetMGM" }, { key: "caesars", label: "Caesars" },
  { key: "espnbet", label: "ESPN BET" }, { key: "fanatics", label: "Fanatics" },
];
export const BOOK_LABELS = { ...Object.fromEntries(BOOKS.map((b) => [b.key, b.label])), manual: "Manual" };
export const ODDS_TESTING_LIMIT = 400;
