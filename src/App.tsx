import React, { useState, useEffect, useMemo, useRef } from "react";

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
const TEAMS = {
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
const ABBR_TO_NAME = Object.fromEntries(Object.values(TEAMS).map((t) => [t.ab, t.name]));
// search a board entry / tracked bet by player name, team abbrev, or team nickname
function matchesQuery(item, q) {
  if (!q) return true;
  const parts = [item.name || "", item.game || ""];
  for (const ab of String(item.game || "").split("@")) { const nm = ABBR_TO_NAME[ab.trim()]; if (nm) parts.push(nm); }
  return parts.join(" ").toLowerCase().includes(q.toLowerCase().trim());
}
const PARKS = {
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
const LG_RPG = 4.4;
const LG_KRATE = 0.22;   // league avg batter strikeouts per plate appearance
// opposing-starter skill layer (Priority 1): league reference rates + FIP constant
const LG_FIP = 4.05, LG_KPCT = 0.22, LG_BBPCT = 0.082, FIP_CONST = 3.10;
const STARTER_SHARE = 0.6; // a hitter faces the opposing STARTER for ~60% of the game; bullpen (team RA/G) covers the rest

// Supabase project — URL is safe to expose client-side; the Odds API key lives as a server-side secret.
// Get SUPABASE_ANON_KEY from: Supabase Dashboard → Project Settings → API → "anon public"
const SUPABASE_URL = "https://jkpctgapbsyzqjfiiuoe.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprcGN0Z2FwYnN5enFqZmlpdW9lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4NzE5MDMsImV4cCI6MjEwMzQ0NzkwM30.9UT8ILqf6Xpk9LNangxZKfQZmv6Woa7WlbzRVyxdttg"; // safe to expose — grants only public access
const ODDS_PROXY_URL = `${SUPABASE_URL}/functions/v1/odds-proxy`;

// Optional Baseball Savant game-feed layer. Keep blank for direct fetch during local testing.
// For hosted/public deploys, route through a serverless proxy that accepts ?url=<encoded target>.
const SAVANT_BASE = "https://baseballsavant.mlb.com";
const STATCAST_PROXY_BASE = `${SUPABASE_URL}/functions/v1/statcast-proxy`;
const STATCAST_MIN_BBE = 1;
// Season-to-date Statcast Search CSV layer. Uses Savant statcast_search/csv and caches
// player aggregates so pregame boards do not re-download the same player every expansion.
// Browser fetches to Savant may require STATCAST_PROXY_BASE in hosted deployments.
const STATCAST_SEASON_TTL_MS = 6 * 60 * 60 * 1000; // 6h cache: current enough for daily slate work
const STATCAST_SEASON_MIN_BBE_HITTER = 15;
const STATCAST_SEASON_MIN_BBE_PITCHER = 25;
const LG_XBA = 0.245, LG_XWOBA = 0.320, LG_HARDHIT = 0.385, LG_BARREL = 0.080, LG_FB = 0.240, LG_PULL_FB = 0.095;
const LG_PITCHER_HR9 = 1.10, LG_PITCHER_XWOBA_ALLOWED = 0.320, LG_PITCHER_BARREL_ALLOWED = 0.080, LG_PITCHER_HARDHIT_ALLOWED = 0.385;


/* ---------- prop + odds config ---------- */
const HITTER_PROPS = ["Hits", "Total Bases", "Home Run", "H+R+RBI"];
const PITCHER_PROPS = ["Strikeouts", "Outs"];
const ALL_PROPS = [...HITTER_PROPS, ...PITCHER_PROPS];
const DEFAULT_LINE = { "Hits": "0.5", "Total Bases": "1.5", "Home Run": "0.5", "H+R+RBI": "1.5", "Strikeouts": "5.5", "Outs": "16.5" };
const ODDS_SPORT = "baseball_mlb";
const TYPE_TO_MARKET = {
  "Hits": "batter_hits", "Total Bases": "batter_total_bases", "Home Run": "batter_home_runs",
  "H+R+RBI": "batter_hits_runs_rbis", "Strikeouts": "pitcher_strikeouts", "Outs": "pitcher_outs",
};
const MARKET_TO_TYPE = Object.fromEntries(Object.entries(TYPE_TO_MARKET).map(([k, v]) => [v, k]));
const GAME_MARKETS = ["h2h", "spreads", "totals"];        // moneyline, run line, total
const GAME_PROPS = ["Moneyline", "Run Line", "Total"];
const CATEGORY_ORDER = [...HITTER_PROPS, ...PITCHER_PROPS, ...GAME_PROPS];
const isLineType = (t) => GAME_PROPS.includes(t);
const BOOKS = [
  { key: "draftkings", label: "DraftKings" }, { key: "fanduel", label: "FanDuel" },
  { key: "betmgm", label: "BetMGM" }, { key: "caesars", label: "Caesars" },
  { key: "espnbet", label: "ESPN BET" }, { key: "fanatics", label: "Fanatics" },
];
const BOOK_LABELS = { ...Object.fromEntries(BOOKS.map((b) => [b.key, b.label])), manual: "Manual" };
const ODDS_TESTING_LIMIT = 400; // per-session safety rail against runaway loops (20k/mo key — generous)

/* ---------- stake sizing ---------- */
// Suggested stake = fractional Kelly. Kelly fraction f* = EV / b (b = profit per $1).
// 1 unit = 1% of bankroll, so full-Kelly units = f* * 100. We use QUARTER Kelly and
// cap it, because Kelly assumes the model probability is exactly right — and ours is
// not proven (and has shown overconfidence). Flat 1u stays available for comparison.
const KELLY_FRACTION = 0.25;          // quarter Kelly
const KELLY_BANKROLL_UNITS = 100;     // 1u = 1% of bankroll
const SUGGEST_MAX_UNITS = 3;          // hard cap on a single suggested stake
function suggestedUnits(modelP, odds) {
  if (modelP == null || isNaN(odds)) return 0;
  const b = odds > 0 ? odds / 100 : 100 / -odds;
  const ev = modelP * b - (1 - modelP);
  if (ev <= 0) return 0;              // no edge -> suggest no bet
  const f = ev / b;                   // Kelly fraction of bankroll
  const u = f * KELLY_BANKROLL_UNITS * KELLY_FRACTION;
  return clamp(Math.round(u * 4) / 4, 0, SUGGEST_MAX_UNITS); // round to 0.25u
}

/* ---------- engine constants (tunable) ---------- */
const RECENT_WEIGHT = 0.20;
const RECENT_MULT_STRENGTH = 0.0;          // extra hot/cold mult (off; recency already in blend)
const MIN_L15_AB = 20;                     // require this many recent AB before blending L15
const LINEUP_PA_MULT = [1.10, 1.08, 1.05, 1.03, 1.00, 0.97, 0.95, 0.92, 0.90];
const NB_PHI = { tb: 3.0, hrr: 2.0, k: 1.1, outs: 1.50 };
// tb: 3.0 calibrated to Aug data (actual var/mean=2.13, N=575 at line=1.5). NB(mean,phi=3) gives P(>=2)=0.345 vs actual 0.336.
//     Note: tb phi is now USED (switched from per-AB sim to NB for the P calculation).
// hrr: raised 1.85→2.0 to match actual Aug var/mean=2.0 (N=748). Slightly narrows overconfident high-end tails.
// k: lowered 1.5→1.1 because actual K var/mean=0.97 (near-Poisson). Wider NB was inflating P(over) when line>mean.
// outs: kept 1.50 as reference but Outs now uses Poisson family (actual phi=0.71, Poisson is better approximation).
// GAME_FACTOR_K: shape parameter for per-trial game-level offensive factor in the per-AB MC.
// All ABs in a single simulated game share one Gamma(k, 1/k) draw (mean=1, CV=1/√k).
// k=8 → CV≈35%: too aggressive — inflates P(0 hits) in ~8% of trials when gf<0.30.
// k=20 → CV≈22%: tighter, still models intra-game correlation without creating structural under bias.
const GAME_FACTOR_K = 20;
const RUNS_PHI = 2.0; // team runs/game overdispersion (variance ≈ RUNS_PHI × mean); used by game-line NB distribution
// early-sample shrinkage of hitter per-AB rates toward league priors
const SHRINK_ENABLED = true;
const LG_PRIOR = { hPerAB: 0.245, hrPerAB: 0.033, tbPerAB: 0.400, hrrG: 1.70 }; // rough MLB rates (hrrG = avg H+R+RBI/game)
const SHRINK_AB = { h: 100, hr: 250, tb: 150 };                     // regression strength (AB)
const SPOT_AB = [4.5, 4.4, 4.3, 4.2, 4.1, 4.0, 3.9, 3.8, 3.7];      // expected AB/game by lineup spot (starter)
const HRR_SHRINK_G = 10;   // games of league-avg prior mixed into H+R+RBI/game (thin-sample fallback)
const AB_SHRINK_G = 8;     // games of spot-AB prior mixed into AB/game
// OFFENSIVE CALIBRATION: tracked bets on 6/19 showed the model under-projects hitting
// by ~10% (actual/proj ≈ 1.10 across Hits/TB/H+R+RBI), which made nearly every UNDER a
// losing bet. This multiplier corrects the location bias. It is a calibration knob:
// retune across days toward the value that makes over and under win% both sit near break-even.
const OFF_CALIB = 1.0; // offensive calibration. Was 1.07 (fit to a tiny early sample); 450+ settled bets showed overs at 41% / unders 57%, i.e. offense was over-projected. Back to neutral.
// per-market calibration: each prop blends toward the sharp market price by a category-specific amount.
// HR gets the strongest market anchor (the model over-projects HR longshots); K/Outs stay more model-driven.
// Run Line anchored tighter than default (0.50 vs 0.60): game lines are the sharpest market; 6/25 data confirmed
// run line model overconfidence. Edge 0-3% bets won only 25% — use Board's min-edge filter (≥4%) as standing practice.
// CALIB_KEEP: blend weight toward model (1.0 = pure model, 0.0 = pure market novig). Lower = trust market more.
// 6/26 calibration updates: Hits 0.65→0.50 (heavy-juice overs winning only 59% at -220 avg; market knows more),
// H+R+RBI 0.50→0.42 (inverse edge-performance: high-edge bets lost worse than low-edge; model edge largely artificial),
// Home Run 0.35→0.25 (0/30 night, avg edge only 1.9%; push harder toward market on thin-edge HR props),
// Strikeouts 0.75→0.65 (day-to-day K variance much higher than model assumes; market better calibrated),
// Total Bases added 0.52 (was using CALIB_KEEP_DEFAULT 0.6; split the difference closer to market).
// 6/27 calibration updates: Total Bases 0.52→0.42 (28.6% TB over win rate on 6/27; TB is structurally more sensitive to
// pitcher suppression than Hits — getting TB requires hit AND extra bases, compounding error; also generating too many
// correlated per-game bets that all lose together when pitching dominates a matchup).
// Hits 0.50→0.44 (bilateral losses: juice overs winning 61% but losing to vig; plus-money unders going 35%, -13u combined;
// market is better calibrated in both directions — trust it more).
// 6/28 calibration updates:
// Hits 0.44→0.30 (plus-money hits 6/28 went 23.1%, -11.76u; overs at plus money 1-7 (12.5%), unders 5-13 (27.8%);
// model raw overconfidence vs market ~11.6% avg; only -179 to -130 juice range working (7-3, 70%); cutting blend
// aggressively so only genuine outlier model gaps survive any reasonable edge threshold).
// Total Bases 0.42→0.30 (three consecutive days of 35-40% win rates; compound probability error not improving;
// push hard toward market — model cannot reliably predict TB in pitcher-dominated games).
// H+R+RBI 0.42→0.35 (inverse edge-performance confirmed across all three days; 4-6% edge bucket 43.3%, -5.24u;
// model edge signal consistently uninformative — low-edge bets outperform high-edge bets).
// Outs 0.80→0.70 (false edge anomaly: opener/short-IP pitchers generating 20-26% edges; model extrapolates season
// avg IP without knowing game plan; market prices these 50-50 and is usually right; reducing multiplier caps
// these structurally misleading edges).
// 8/11 calibration updates:
// Hits 0.30→0.20: Aug data — 0.5 under going 42.1% (-11.6% ROI) and 1.5 over at 23.8% (-21.9% ROI); market
//   is better calibrated in both directions. 0.5 over still working (+1.7%) with strong raw signal (62.2%
//   win rate), so it survives the tighter blend. Pulling harder toward market eliminates weak-edge picks
//   where the model is directionally wrong.
// H+R+RBI 0.35→0.25: Aug data — 0.5 under going 45% (-13.2% ROI); market more pessimistic than model and
//   correct. 0.5 over remains strong (+11.7% ROI) and will keep generating edge at the lower blend weight.
//   Prevents tiny under edges from appearing where market has the right read.
const CALIB_KEEP = { "Hits": 0.30, "Total Bases": 0.45, "Home Run": 0.30, "H+R+RBI": 0.35, "Strikeouts": 0.55, "Outs": 0.55, "Run Line": 0.50 };
// 8/20 recalibration: raised hitter prop weights now that distributions are fixed (NB phi, Poisson Outs, K soft cap).
// K/Outs reduced slightly — model was already high-trust and we just patched known biases; slightly more market weight warranted.
// Prior sessions reduced these toward 0.10 as a band-aid. The real fixes are:
//   Hits/TB/HR: game-level correlated Gamma factor in simBatterGame (breaks false i.i.d. AB assumption).
//   H+R+RBI: NB_PHI.hrr → 3.0 (variance=3×mean, genuinely wider than original 1.85);
//             mean reverted to single formula (decomposed version inflated projections for good hitters).
const CALIB_KEEP_DEFAULT = 0.6; // moneyline / total and any uncategorized market
function keepFor(type) { return (type != null && CALIB_KEEP[type] != null) ? CALIB_KEEP[type] : CALIB_KEEP_DEFAULT; }
// K projection calibration: Sep 2-7 data (N=220): bias=-0.485 (model underprojects vs actual by 0.485 Ks).
// Prior 10% deflation (0.90) overcorrected past zero — model was already underestimating.
// Removing deflation (1.00). K_SOFT_CAP compression stays to handle elite-starter IP limits.
// K_SOFT_CAP / K_SOFT_COMPRESS: elite K starters (K/9>11) burn more pitches per inning → shorter actual IP.
const K_PROJ_CALIB = 1.00;
const K_SOFT_CAP = 5.5;       // K projections above this regress toward the cap
const K_SOFT_COMPRESS = 0.50; // 50% of excess above cap is kept (e.g., 7.80 → 5.5 + 1.15 = 6.65)
// Outs mean calibration: Sep 2-7 data (N=92): bias=-0.476 (model underprojects vs actual; mean proj=15.15, actual=15.63).
// Prior deflation (0.963) was based on Aug data showing overestimation — reversed sign in Sep. Flipped to 1.032.
// Actual Outs var/mean=0.71 (sub-Poisson; Poisson family retained).
const OUTS_PROJ_CALIB = 1.032;
// Sanity cap: if |proj_outs - line| > this threshold, pitcher role/IP data is stale
// (swingman evolved to starter, injury return on pitch limit, etc.). Force edge to 0.
// All extreme-edge Outs blowups in Aug data had |delta| > 3 outs. 3.5 catches these
// without aggressively suppressing legitimate moderate-delta under plays.
const OUTS_SANITY_DELTA = 3.5;

// PLATOON: league-average production multipliers, season-relative, by batter hand -> SP throwing hand.
// A hitter's season rate already blends both hands (mostly vs RHP), so these re-weight toward the
// hand actually faced. Same-handed (esp. LHB vs LHP) is a real penalty; opposite-handed is a boost.
// If the hitter has enough of his OWN vs-L/vs-R split data, we blend his split toward this prior.
const LG_PLATOON = { L: { L: 0.91, R: 1.035 }, R: { L: 1.045, R: 0.985 }, S: { L: 1.02, R: 1.00 } };
const PLATOON_SHRINK_AB = 50; // split AB before a hitter's own L/R split outweighs the league prior
function calculatePlatoonAdjustment(ctx) {
  if (ctx.kind !== "hitter") return 1;
  const throws = ctx.oppThrows, bats = ctx.bats;
  if (!throws || !bats) return 1;                                  // unknown handedness -> neutral
  const prior = (LG_PLATOON[bats] && LG_PLATOON[bats][throws] != null) ? LG_PLATOON[bats][throws] : 1;
  const sp = ctx.splits, s = ctx.season;
  if (sp && s && s.ab) {
    const vs = throws === "L" ? sp.vL : sp.vR;                     // hitter's own split vs this hand
    const seasonRate = s.h / s.ab;
    if (vs && vs.ab >= 10 && seasonRate > 0) {
      const obs = (vs.h / vs.ab) / seasonRate;                     // season-relative own split
      const w = vs.ab / (vs.ab + PLATOON_SHRINK_AB);              // more split AB -> trust own data
      return clamp(obs * w + prior * (1 - w), 0.80, 1.15);
    }
  }
  return clamp(prior, 0.80, 1.15);
}

/* ---------------------- core math ---------------------- */
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const fact = (n) => { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; };
const poiPmf = (k, l) => (l <= 0 ? (k === 0 ? 1 : 0) : Math.exp(-l) * Math.pow(l, k) / fact(k));
const poiCdf = (k, l) => { let s = 0; for (let i = 0; i <= k; i++) s += poiPmf(i, l); return s; };
const binPmf = (k, n, p) => {
  if (p <= 0) return k === 0 ? 1 : 0; if (p >= 1) return k === n ? 1 : 0;
  const c = fact(n) / (fact(k) * fact(n - k));
  return c * Math.pow(p, k) * Math.pow(1 - p, n - k);
};
const binCdf = (k, n, p) => { let s = 0; for (let i = 0; i <= k; i++) s += binPmf(i, n, p); return s; };

function lgamma(x) {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1; let a = c[0]; const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function nbParams(mean, phi) {
  const m = Math.max(mean, 1e-9);
  const v = Math.max(m * Math.max(phi, 1.0001), m + 1e-6);
  const r = (m * m) / (v - m);
  const p = r / (r + m);
  return { r, p, mean: m };
}
function negativeBinomialPMF(k, mean, phi) {
  if (k < 0) return 0;
  const { r, p } = nbParams(mean, phi);
  return Math.exp(lgamma(k + r) - lgamma(r) - lgamma(k + 1) + r * Math.log(p) + k * Math.log(1 - p));
}
function negativeBinomialCDF(k, mean, phi) { let s = 0; for (let i = 0; i <= k; i++) s += negativeBinomialPMF(i, mean, phi); return s; }
function negativeBinomialProbabilityOver(line, mean, phi) { return 1 - negativeBinomialCDF(Math.floor(line), mean, phi); }

let RNG = Math.random;
function mulberry32(a) {
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hashSeed(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
let _spareGaussian = null;
function gaussian() {
  if (_spareGaussian != null) { const s = _spareGaussian; _spareGaussian = null; return s; }
  let u, v, s; do { u = RNG() * 2 - 1; v = RNG() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
  const m = Math.sqrt(-2 * Math.log(s) / s); _spareGaussian = v * m; return u * m;
}
function sampleGamma(shape, scale) {
  if (shape < 1) { const u = RNG(); return sampleGamma(1 + shape, scale) * Math.pow(u, 1 / shape); }
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v; do { x = gaussian(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = RNG();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}
function samplePoisson(lam) {
  if (lam <= 0) return 0;
  if (lam < 30) { const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= RNG(); } while (p > L); return k - 1; }
  return Math.max(0, Math.round(lam + Math.sqrt(lam) * gaussian()));
}
function sampleNegBin(mean, phi) { const { r, p } = nbParams(mean, phi); const lam = sampleGamma(r, (1 - p) / p); return samplePoisson(lam); }
function runMonteCarlo(drawFn, line, side, seed, N = 50000) {
  const prev = RNG; RNG = mulberry32(seed >>> 0 || 12345); _spareGaussian = null;
  let over = 0; for (let i = 0; i < N; i++) { if (drawFn() > line) over++; }
  RNG = prev; _spareGaussian = null;
  const pOver = over / N; return side === "over" ? pOver : 1 - pOver;
}

/* ---------------------- odds + format ---------------------- */
const impliedProb = (o) => (o < 0 ? -o / (-o + 100) : 100 / (o + 100));
const probToAmerican = (p) => { if (p <= 0 || p >= 1) return "—"; return p > 0.5 ? `-${Math.round((p / (1 - p)) * 100)}` : `+${Math.round(((1 - p) / p) * 100)}`; };
const evPerUnit = (p, o) => { const b = o > 0 ? o / 100 : 100 / -o; return p * b - (1 - p); };
// calibration: blend the model toward the sharp market price, keeping keepFor(type) of the disagreement.
// This corrects overconfident favorites AND over-projected longshots (shrinking toward 0.5 would inflate longshots).
function calibrateToMarket(p, market, type) { return (p == null || market == null) ? p : clamp(market + keepFor(type) * (p - market), 0.001, 0.999); }
const pct = (x) => (x == null || isNaN(x) ? "—" : `${(x * 100).toFixed(1)}%`);
const fmtOdds = (o) => (o == null ? "—" : (o > 0 ? `+${o}` : `${o}`));
// no-vig probability for a side given both prices; falls back to raw if one side missing
function noVigProb(overOdds, underOdds, side) {
  if (overOdds == null && underOdds == null) return null;
  if (overOdds == null || underOdds == null) return impliedProb(side === "over" ? overOdds : underOdds);
  const io = impliedProb(overOdds), iu = impliedProb(underOdds), s = io + iu;
  const novigOver = s > 0 ? io / s : 0.5;
  return side === "over" ? novigOver : 1 - novigOver;
}

// Per-team run distribution. Negative Binomial (overdispersed) rather than Poisson:
// MLB team runs/game have variance ≈ 2× the mean (big innings), so NB fits the tails of
// totals and run lines far better than Poisson. Teams modeled independently (no in-game
// run correlation) — a known simplification, but the marginal overdispersion is the big win.
function runPmf(k, lambda) { return negativeBinomialPMF(k, Math.max(lambda, 1e-6), RUNS_PHI); }

function gameProbs(lh, la) {
  const N = 26; let pH = 0, pA = 0, pT = 0, h2 = 0, a2 = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const pr = runPmf(i, lh) * runPmf(j, la);
    if (i > j) { pH += pr; if (i - j >= 2) h2 += pr; }
    else if (j > i) { pA += pr; if (j - i >= 2) a2 += pr; }
    else pT += pr;
  }
  return { home: pH + pT / 2, away: pA + pT / 2, homeRL: h2, awayRL: a2, totalLambda: lh + la };
}
// Generalized version for LIVE game lines: final = current score + Poisson(remaining λ) per team.
// Pregame reduces to gameProbs (hc=ac=0, full λ). totalLine optional -> P(final total > line).
function jointGameProbs(lhEff, laEff, hc, ac, totalLine) {
  const N = 26; let pH = 0, pA = 0, pT = 0, h2 = 0, a2 = 0, over = 0, under = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const pr = runPmf(i, lhEff) * runPmf(j, laEff);
    const hs = hc + i, as = ac + j;
    if (hs > as) { pH += pr; if (hs - as >= 2) h2 += pr; }
    else if (as > hs) { pA += pr; if (as - hs >= 2) a2 += pr; }
    else pT += pr;
    if (totalLine != null) { const tot = hs + as; if (tot > totalLine) over += pr; else if (tot < totalLine) under += pr; } // gap (over+under<1) on integer lines is the push
  }
  return { home: pH + pT / 2, away: pA + pT / 2, homeRL: h2, awayRL: a2, over, under };
}
// P(final home-minus-away margin satisfies cmp), using current score + Poisson(remaining λ).
// Lets run-line cover be computed against the ACTUAL spread point (e.g. -4.5 live), not a fixed ±2.
function marginProb(lhEff, laEff, hc, ac, cmp) {
  const N = 26; let p = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    if (cmp((hc + i) - (ac + j))) p += runPmf(i, lhEff) * runPmf(j, laEff);
  }
  return p;
}

/* ============================================================
   PROJECTION ENGINE
   ============================================================ */
const blendRate = (seasonRate, recentRate) =>
  (recentRate == null || isNaN(recentRate)) ? seasonRate : seasonRate * (1 - RECENT_WEIGHT) + recentRate * RECENT_WEIGHT;
const parkHitMultiplier = (rf) => rf;
const parkHRMultiplier = (rf) => Math.pow(rf, 1.25);
// empirical-Bayes shrinkage of a per-AB rate toward a league prior
function shrinkRate(obsRate, ab, prior, kAB) {
  if (!SHRINK_ENABLED) return obsRate;
  if (!ab) return prior;                                   // no AB -> league prior (not zero)
  return (obsRate * ab + prior * kAB) / (ab + kAB);
}
// generic shrinkage of an observed value toward a prior, weighted by sample count
function shrinkValue(obs, count, prior, k) {
  const o = isFinite(obs) ? obs : prior;
  return (o * (count || 0) + prior * k) / ((count || 0) + k);
}

function calculateBaseProjection(ctx) {
  const s = ctx.season || {};
  if (ctx.kind === "pitcher") {
    const ipExp = clamp(s.expIp || 5.2, 2.5, 7.0);
    // Blend season K/9 with recent-starts K/9 (same 20% RECENT_WEIGHT as hitter L15).
    // recentLog.avgK is populated by fetchPitcherLog (last 5 starts) and attached to s by loadDetail.
    // Blending toward recent form reduces systematic overestimate when a pitcher's K rate is declining.
    const recentK9 = s.recentLog && s.recentLog.avgK != null ? s.recentLog.avgK : null;
    const blendedK9 = blendRate(s.k9 || 0, recentK9); // recent 20% weight, falls back to season if null
    const kG = clamp((blendedK9 / 9) * ipExp, 0, 13);
    return { kG, ipExp, outsExp: clamp(ipExp * 3, 0, 24), role: s.role || "starter" };
  }
  const g = s.g || 1;
  const l = ctx.l15 || null;
  const lOK = l && l.games && l.ab >= MIN_L15_AB;          // gate: enough recent AB
  // shrink season per-AB rates toward priors (stabilizes thin samples)
  const hPerAB_s = shrinkRate(s.ab ? s.h / s.ab : 0, s.ab, LG_PRIOR.hPerAB, SHRINK_AB.h);
  const hrPerAB_s = shrinkRate(s.ab ? s.hr / s.ab : 0, s.ab, LG_PRIOR.hrPerAB, SHRINK_AB.hr);
  const tbPerAB_s = shrinkRate(s.ab ? s.tb / s.ab : 0, s.ab, LG_PRIOR.tbPerAB, SHRINK_AB.tb);
  const abRaw = blendRate(s.ab / g, lOK ? l.ab / l.games : null);
  const spotAB = (ctx.lineupIndex != null && ctx.lineupIndex >= 0 && ctx.lineupIndex <= 8) ? SPOT_AB[ctx.lineupIndex] : 4.0;
  const abG = shrinkValue(abRaw, g, spotAB, AB_SHRINK_G);   // thin samples -> spot-based expected AB
  const hPerAB_l = lOK && l.ab ? l.h / l.ab : null;
  const hrPerAB_l = lOK && l.ab ? l.hr / l.ab : null;
  const tbPerAB_l = lOK && l.ab ? l.tb / l.ab : null;
  const hPerAB = blendRate(hPerAB_s, hPerAB_l) * OFF_CALIB;
  const hrPerAB = blendRate(hrPerAB_s, hrPerAB_l) * OFF_CALIB;
  const tbPerAB = blendRate(tbPerAB_s, tbPerAB_l) * OFF_CALIB;
  const hrrRaw = blendRate((s.h + (s.r || 0) + (s.rbi || 0)) / g, lOK ? (l.h + (l.r || 0) + (l.rbi || 0)) / l.games : null);
  return {
    hPerAB, hrPerAB, tbPerAB, abG,
    hrG: hrPerAB * abG,
    tbG: tbPerAB * abG,
    hrrG: shrinkValue(hrrRaw, g, LG_PRIOR.hrrG, HRR_SHRINK_G) * OFF_CALIB, // thin samples -> league-avg; * offensive calibration
  };
}
function calculateMatchupAdjustment(ctx) {
  const b = ctx.bvp, s = ctx.season;
  if (!b || !s || (b.ab || 0) < 20 || !s.ab) return 1;
  const bvpAvg = b.h / b.ab, seasonAvg = s.h / s.ab;
  if (!seasonAvg) return 1;
  // BvP is mostly noise in modern research; keep only a light touch (was 0.5, reduced ~60%). Caps retained.
  return clamp(1 + (bvpAvg / seasonAvg - 1) * 0.2, 0.92, 1.08);
}
function calculateParkAdjustment(ctx, type) {
  const rf = ctx.park ? ctx.park.rf : 1;
  if (ctx.kind === "pitcher") return 1;
  return type === "Home Run" ? parkHRMultiplier(rf) : parkHitMultiplier(rf);
}
function calculateWeatherAdjustment(ctx) {
  const w = ctx.weather;
  if (!w || (ctx.park && ctx.park.dome)) return 1;
  let m = 1;
  if (w.temp != null) { if (w.temp >= 85) m += 0.03; else if (w.temp <= 60) m -= 0.03; }
  if (w.wind != null && w.wind >= 12) m += 0.02;
  if (w.pop != null && w.pop >= 50) m -= 0.02;
  return clamp(m, 0.94, 1.06);
}
function calculateLineupAdjustment(ctx) {
  if (ctx.kind === "pitcher") return 1;
  const i = ctx.lineupIndex;
  if (i == null || i < 0 || i > 8) return 1;
  return LINEUP_PA_MULT[i];
}
function calculateRecentFormAdjustment(ctx) {
  if (RECENT_MULT_STRENGTH <= 0) return 1;
  const l = ctx.l15, s = ctx.season;
  if (!l || !s || !s.ab || !l.ab) return 1;
  const seasonProxy = (s.h / s.ab) + (s.tb / s.ab);
  if (!seasonProxy || l.ops == null) return 1;
  return clamp(1 + (l.ops - seasonProxy) * RECENT_MULT_STRENGTH, 0.95, 1.05);
}
function calculateTeamRunAdjustment(ctx) {
  // bullpen + overall staff proxy: opposing team's runs allowed per game vs league.
  // We deliberately do NOT use the hitter's own team strength: his season R/RBI already
  // embody his lineup, so re-applying it double-counts. This captures only today's matchup.
  const opp = ctx.oppRAPG;
  if (!opp) return 1;
  return clamp(opp / LG_RPG, 0.90, 1.12);   // weak opposing pitching -> boost, strong -> trim
}
// Priority 1 — opposing-starter skill layer. Blends the specific starter's FIP / K% / BB% (the arm the hitter
// actually faces for ~60% of the game) with the team RA/G bullpen proxy. Centered at 1.0: <1 vs strong starters,
// >1 vs weak ones. Falls back to the team proxy alone when the starter's sample is thin, so it degrades gracefully.
function calculateOppPitchingAdjustment(ctx) {
  if (ctx.kind === "pitcher") return 1;
  const teamMult = calculateTeamRunAdjustment(ctx);
  const sp = ctx.oppSP;
  if (!sp || !sp.bf || sp.bf < 80 || sp.fip == null) return teamMult;        // thin starter data -> team proxy only
  const kPct = sp.so / sp.bf, bbPct = sp.bb / sp.bf;
  const fipR = clamp(sp.fip / LG_FIP, 0.55, 1.4);                             // high FIP (weak) -> boost hitter; floor 0.7→0.55: elite pitchers (FIP~1.6) were only reaching 0.70, not enough suppression
  const kR = clamp(LG_KPCT / Math.max(kPct, 0.05), 0.55, 1.4);               // high K% (strong) -> suppress hitter; floor 0.7→0.55: same reason, 37%+ K% pitchers need deeper cuts
  const bbR = clamp(bbPct / LG_BBPCT, 0.7, 1.4);                             // high BB% (wild) -> slight boost
  let starterMult = clamp(0.70 * fipR + 0.20 * kR + 0.10 * bbR, 0.72, 1.15); // floor 0.85→0.72: allow elite starters to suppress ~28% (vs old 15% max)
  starterMult = clamp(starterMult * pitcherStatcastRunAdjustment(sp), 0.68, 1.20); // floor 0.82→0.68: post-Statcast blend can now go lower for truly elite profiles
  return clamp(STARTER_SHARE * starterMult + (1 - STARTER_SHARE) * teamMult, 0.72, 1.18); // final floor 0.84→0.72: 6/26 data confirmed CHC@MIL false edges from 0.84 being too high
}

// Optional Statcast quality-of-contact layer. It has two independent inputs:
//   1) LIVE /gf game-feed BBE for in-game bets (very small sample, tiny adjustment).
//   2) Season-to-date statcast_search/csv aggregates for pregame projections.
// If either source is missing, blocked, stale, or too thin, it contributes 1.00 and the
// existing model remains unchanged. This keeps Savant as an enhancer, not a dependency.
function calculateStatcastAdjustment(ctx) {
  const liveSc = ctx && ctx.statcastLive;
  const seasonSc = ctx && ctx.statcastSeason;
  const out = { hit: 1, tb: 1, hr: 1, run: 1, k: 1, outs: 1, label: null, seasonLabel: null, liveLabel: null };

  if (seasonSc && seasonSc.verdict === "season_confirmed" && (seasonSc.bbe || 0) >= STATCAST_SEASON_MIN_BBE_HITTER) {
    const w = clamp(seasonSc.bbe / 150, 0.30, 1.00);
    if (seasonSc.xba != null) out.hit *= clamp(1 + ((seasonSc.xba - LG_XBA) / 0.080) * 0.035 * w, 0.94, 1.07);
    if (seasonSc.xwoba != null) {
      out.tb *= clamp(1 + ((seasonSc.xwoba - LG_XWOBA) / 0.100) * 0.055 * w, 0.92, 1.10);
      out.run *= clamp(1 + ((seasonSc.xwoba - LG_XWOBA) / 0.100) * 0.050 * w, 0.93, 1.10);
    }
    if (seasonSc.hardHitRate != null) {
      out.tb *= clamp(1 + (seasonSc.hardHitRate - LG_HARDHIT) * 0.13 * w, 0.95, 1.08);
      out.hr *= clamp(1 + (seasonSc.hardHitRate - LG_HARDHIT) * 0.18 * w, 0.93, 1.10);
    }
    if (seasonSc.barrelRate != null) out.hr *= clamp(1 + (seasonSc.barrelRate - LG_BARREL) * 1.15 * w, 0.84, 1.22);
    if (seasonSc.fbRate != null) out.hr *= clamp(1 + (seasonSc.fbRate - LG_FB) * 0.28 * w, 0.92, 1.10);
    if (seasonSc.pullFbRate != null) out.hr *= clamp(1 + (seasonSc.pullFbRate - LG_PULL_FB) * 0.45 * w, 0.90, 1.12);
    out.seasonLabel = `season ${seasonSc.bbe} BBE${seasonSc.xwoba != null ? ` · xwOBA ${seasonSc.xwoba.toFixed(3)}` : ""}${seasonSc.barrelRate != null ? ` · Brl% ${(seasonSc.barrelRate * 100).toFixed(1)}` : ""}${seasonSc.hardHitRate != null ? ` · HH% ${(seasonSc.hardHitRate * 100).toFixed(0)}` : ""}`;
  }

  if (ctx && ctx.live && liveSc && liveSc.bbe && liveSc.bbe >= STATCAST_MIN_BBE) {
    const w = clamp(liveSc.bbe / 4, 0.25, 1);
    if (liveSc.avgXBA != null) out.hit *= clamp(1 + ((liveSc.avgXBA - LG_PRIOR.hPerAB) / 0.25) * 0.05 * w, 0.94, 1.06);
    if (liveSc.avgEV != null) out.tb *= clamp(1 + ((liveSc.avgEV - 88) / 12) * 0.05 * w, 0.94, 1.08);
    if (liveSc.hardHitRate != null) out.tb *= clamp(1 + (liveSc.hardHitRate - LG_HARDHIT) * 0.10 * w, 0.96, 1.06);
    if (liveSc.barrelishRate != null) out.hr *= clamp(1 + (liveSc.barrelishRate - LG_BARREL) * 0.35 * w, 0.90, 1.12);
    if (liveSc.avgEV != null) out.hr *= clamp(1 + ((liveSc.avgEV - 88) / 12) * 0.05 * w, 0.94, 1.08);
    out.liveLabel = `${liveSc.bbe} live BBE${liveSc.avgXBA != null ? ` · xBA ${liveSc.avgXBA.toFixed(3)}` : ""}${liveSc.avgEV != null ? ` · EV ${liveSc.avgEV.toFixed(1)}` : ""}`;
  }

  out.hit = clamp(out.hit, 0.90, 1.10);
  out.tb = clamp(out.tb, 0.88, 1.14);
  out.hr = clamp(out.hr, 0.78, 1.28);
  out.run = clamp(out.run, 0.90, 1.12);
  out.label = [out.seasonLabel, out.liveLabel].filter(Boolean).join(" | ") || null;
  return out;
}

function pitcherStatcastRunAdjustment(sp) {
  const sc = sp && sp.statcastSeason;
  if (!sc || sc.verdict !== "season_confirmed" || (sc.bbe || 0) < STATCAST_SEASON_MIN_BBE_PITCHER) return 1;
  const w = clamp(sc.bbe / 180, 0.30, 1.00);
  let m = 1;
  if (sc.xwobaAllowed != null) m *= clamp(1 + ((sc.xwobaAllowed - LG_PITCHER_XWOBA_ALLOWED) / 0.100) * 0.075 * w, 0.88, 1.14);
  if (sc.barrelAllowedRate != null) m *= clamp(1 + (sc.barrelAllowedRate - LG_PITCHER_BARREL_ALLOWED) * 1.05 * w, 0.88, 1.15);
  if (sc.hardHitAllowedRate != null) m *= clamp(1 + (sc.hardHitAllowedRate - LG_PITCHER_HARDHIT_ALLOWED) * 0.13 * w, 0.94, 1.08);
  if (sc.hr9 != null) m *= clamp(1 + ((sc.hr9 - LG_PITCHER_HR9) / LG_PITCHER_HR9) * 0.060 * w, 0.92, 1.10);
  return clamp(m, 0.86, 1.16); // >1 means easier run environment for hitters
}
function pitcherStatcastKAdjustment(ctx) {
  const sc = ctx && ctx.statcastSeason;
  if (!sc || sc.verdict !== "season_confirmed" || !sc.pitches || sc.pitches < 250) return 1;
  const w = clamp(sc.pitches / 1200, 0.25, 1);
  let m = 1;
  if (sc.whiffRate != null) m *= clamp(1 + (sc.whiffRate - 0.115) * 0.35 * w, 0.92, 1.10);
  if (sc.cswRate != null) m *= clamp(1 + (sc.cswRate - 0.285) * 0.25 * w, 0.94, 1.08);
  return clamp(m, 0.90, 1.12);
}
function pitcherStatcastOutsAdjustment(ctx) {
  const sc = ctx && ctx.statcastSeason;
  if (!sc || sc.verdict !== "season_confirmed" || (sc.bbe || 0) < STATCAST_SEASON_MIN_BBE_PITCHER) return 1;
  const runPenalty = pitcherStatcastRunAdjustment({ statcastSeason: sc });
  // Strong contact allowed shortens leash and raises blow-up risk; weak contact helps pitchers work deeper.
  return clamp(1 - (runPenalty - 1) * 0.18, 0.96, 1.04);
}
function applyStatcastToGameLambda(lambda, oppSP) { return clamp(lambda * pitcherStatcastRunAdjustment(oppSP), 2.0, 8.5); }


/* ---------------- live layer ---------------- */
function gameFractionRemaining(inning, inningState, outs) {
  if (!inning) return 1;
  const st = (inningState || "").toLowerCase();
  const topHalf = st.startsWith("top") || st.startsWith("mid");
  const outsCompleted = (inning - 1) * 6 + (topHalf ? 0 : 3) + (outs || 0);
  return clamp(1 - outsCompleted / 54, 0.02, 1);
}
function getCurrentStatTotal(totals, key) { return totals && totals[key] != null ? totals[key] : 0; }
function ipToOuts(ipStr) { if (ipStr == null) return 0; const f = parseFloat(ipStr); if (isNaN(f)) return 0; const w = Math.floor(f); return w * 3 + Math.round((f - w) * 10); }
function probabilityOver(family, line, side, seed, params) {
  let over;
  if (family === "binom") over = 1 - binCdf(Math.floor(line), params.n, params.p);
  else if (family === "poisson") over = 1 - poiCdf(Math.floor(line), params.mean);
  else over = runMonteCarlo(() => sampleNegBin(params.mean, params.phi), line, "over", seed);
  return side === "over" ? over : 1 - over;
}
function liveProbabilityOver(family, seed, params, currentTotal, line) {
  const adj = line - (currentTotal || 0);
  if (adj < 0) return 1;                      // already cleared the line
  return probabilityOver(family, adj, "over", seed, params);
}

/* ---- per-AB batter model ----
   The strategic core for hitters: derive each batter's per-AB outcome
   probabilities (out / 1B / 2B / 3B / HR) from his own rates, scaled by
   park / weather / matchup, then Monte-Carlo his expected at-bats. Hits,
   Total Bases, and Home Runs are all tallied from the SAME simulation, so
   the three props stay mutually consistent and every contextual factor
   flows through. Lineup spot scales the number of AB (more PA at the top). */
const BATTER_SIM_N = 15000;
function batterPerAB(ctx) {
  const base = calculateBaseProjection(ctx);
  const parkHit = calculateParkAdjustment(ctx, "Hits");
  const parkHR = calculateParkAdjustment(ctx, "Home Run");
  const w = calculateWeatherAdjustment(ctx);
  const m = calculateMatchupAdjustment(ctx);
  const pl = calculatePlatoonAdjustment(ctx);
  const lineup = calculateLineupAdjustment(ctx);
  const opp = calculateOppPitchingAdjustment(ctx);   // Priority 1: who's actually pitching (was missing from Hits/HR/TB)
  const sc = calculateStatcastAdjustment(ctx);       // optional live Savant /gf xBA + quality-of-contact layer
  let pHit = clamp(base.hPerAB * parkHit * w * m * pl * opp * sc.hit, 0.001, 0.95);
  let pHR = clamp(base.hrPerAB * parkHR * w * m * pl * opp * sc.hr, 0, 0.30);
  if (pHR > pHit) pHR = pHit;
  const nonHRhit = Math.max(pHit - pHR, 1e-6);
  const tbCtx = base.tbPerAB * parkHit * w * m * pl * opp * sc.tb;
  const nonHRbases = Math.max(tbCtx - 4 * pHR, nonHRhit);     // bases from non-HR hits
  const avgB = clamp(nonHRbases / nonHRhit, 1.0, 2.6);        // avg bases per non-HR hit
  const tripleFrac = 0.02;
  const doubleFrac = clamp(avgB - 1 - 2 * tripleFrac, 0, 1 - tripleFrac);
  const singleFrac = clamp(1 - doubleFrac - tripleFrac, 0, 1);
  const sum = singleFrac + doubleFrac + tripleFrac || 1;
  return {
    expAB: Math.max(base.abG * lineup, 0),
    pHR,
    pSingle: nonHRhit * (singleFrac / sum),
    pDouble: nonHRhit * (doubleFrac / sum),
    pTriple: nonHRhit * (tripleFrac / sum),
    pHit, parkHit, parkHR, w, m, pl, lineup, sc,
  };
}
// simulate one game's AB outcomes; returns {hits, tb, hr}
function simBatterGame(r) {
  const nAB = Math.floor(r.expAB) + (RNG() < (r.expAB - Math.floor(r.expAB)) ? 1 : 0);
  let hits = 0, tb = 0, hr = 0;
  // Game-level offensive factor: one Gamma draw per trial, shared across all ABs.
  // Models pitcher-day variance — when a pitcher is dealing all ABs are harder, not just one.
  // This breaks the false i.i.d. assumption that over-states P(≥1 hit) at heavy juice lines.
  const gf = sampleGamma(GAME_FACTOR_K, 1.0 / GAME_FACTOR_K); // mean=1, CV=1/√GAME_FACTOR_K
  const pHitG = Math.min(0.98, r.pHit * gf);
  const pHRG  = Math.min(pHitG, r.pHR * gf);
  const nonHRhitG = Math.max(pHitG - pHRG, 1e-6);
  const nonHRbase = Math.max(r.pHit - r.pHR, 1e-6);  // original non-HR hit prob
  const nhScale = nonHRhitG / nonHRbase;              // scale factor for hit-type fractions
  const pSingG = r.pSingle * nhScale;
  const pDblG  = r.pDouble * nhScale;
  const pTplG  = r.pTriple * nhScale;
  const cOut = 1 - pHitG;
  for (let i = 0; i < nAB; i++) {
    const x = RNG();
    if (x < cOut) continue;                                   // out
    hits++;
    if (x < cOut + pSingG) tb += 1;
    else if (x < cOut + pSingG + pDblG) tb += 2;
    else if (x < cOut + pSingG + pDblG + pTplG) tb += 3;
    else { tb += 4; hr++; }
  }
  return { hits, tb, hr };
}
// P(over line) for a batter stat, via the shared per-AB sim
function simBatterProb(rates, statKey, line, side, seed, currentTotal, fr, N = BATTER_SIM_N) {
  const prev = RNG; RNG = mulberry32(seed >>> 0 || 12345); _spareGaussian = null;
  const r = { ...rates, expAB: rates.expAB * (fr == null ? 1 : fr) };
  let over = 0;
  for (let i = 0; i < N; i++) {
    const g = simBatterGame(r);
    const v = (currentTotal || 0) + (statKey === "hits" ? g.hits : statKey === "tb" ? g.tb : g.hr);
    if (v > line) over++;
  }
  RNG = prev; _spareGaussian = null;
  const pOver = over / N;
  return side === "over" ? pOver : 1 - pOver;
}


function projectProp(ctx, type, line) {
  ctx = ctx || {};
  const s = ctx.season || {};
  const sig = `${s.ab || 0}-${s.h || 0}-${s.hr || 0}-${s.tb || 0}-${(s.k9 || 0).toFixed ? (s.k9 || 0).toFixed(2) : s.k9}`;
  const seed = hashSeed(`${type}|${line}|${sig}`);   // per-player + per-line stream
  const live = ctx.live && ctx.live.fractionRemaining != null ? ctx.live : null;
  const fr = live ? live.fractionRemaining : 1;
  const totals = (live && live.totals) || {};
  let pOver = null, proj = null, calc = null;

  if (type === "Hits" || type === "Home Run" || type === "Total Bases") {
    const r = batterPerAB(ctx);
    const statKey = type === "Hits" ? "hits" : type === "Home Run" ? "hr" : "tb";
    const ePerAB = type === "Hits" ? r.pHit : type === "Home Run" ? r.pHR : (r.pSingle + 2 * r.pDouble + 3 * r.pTriple + 4 * r.pHR);
    const curKey = type === "Home Run" ? "hr" : statKey === "tb" ? "tb" : "h";
    const cur = live ? getCurrentStatTotal(totals, curKey) : 0;
    const expAB = r.expAB * (live ? fr : 1);
    proj = cur + expAB * ePerAB;
    // TB uses NegBin (phi=3.0): per-AB sim underdispersed (actual var/mean=2.13). NB matches empirical P(>=2).
    // Hits and HR retain the per-AB sim (both well-calibrated).
    pOver = statKey === "tb"
      ? (live
          ? liveProbabilityOver("nb", seed, { mean: Math.max(expAB * ePerAB, 1e-6), phi: NB_PHI.tb }, cur, line)
          : probabilityOver("nb", line, "over", seed, { mean: Math.max(proj, 1e-6), phi: NB_PHI.tb }))
      : simBatterProb(r, statKey, line, "over", seed, cur, live ? fr : 1);
    const dist = statKey === "tb" ? "NegBin·TB" : "Per-AB sim 15k";
    const params = `${expAB.toFixed(1)} AB × ${ePerAB.toFixed(3)}/AB`;
    const baseStr = `${(calculateBaseProjection(ctx).hPerAB).toFixed(3)} H/AB, ${(r.pHR).toFixed(3)} HR/AB`;
    calc = live
      ? liveCalc(dist, `${params} rem`, cur, proj, baseStr, fr)
      : fullCalc(dist, params, proj, baseStr, [["park", type === "Home Run" ? r.parkHR : r.parkHit], ["weather", r.w], ["matchup", r.m], ["hand", r.pl], ["lineup→AB", r.lineup], ["statcast", type === "Home Run" ? r.sc.hr : type === "Total Bases" ? r.sc.tb : r.sc.hit]]);
  } else if (type === "H+R+RBI") {
    const base = calculateBaseProjection(ctx);
    const M = { park: calculateParkAdjustment(ctx, type), weather: calculateWeatherAdjustment(ctx), matchup: calculateMatchupAdjustment(ctx), platoon: calculatePlatoonAdjustment(ctx), lineup: calculateLineupAdjustment(ctx), recent: calculateRecentFormAdjustment(ctx), team: calculateOppPitchingAdjustment(ctx), statcast: calculateStatcastAdjustment(ctx).run };
    // Single-formula mean: season H+R+RBI rate × all contextual adjustments.
    // Decomposed (projHits + projRRI) was reverted: it inflated projections for good hitters because
    // mcRates.pHit already baked in all positive adjustments, then rriPerG added more on top.
    // The single formula is consistent with every other NB prop and doesn't double-count upside.
    const mean = Math.max(base.hrrG * M.park * M.weather * M.matchup * M.platoon * M.lineup * M.recent * M.team * M.statcast, 1e-6);
    if (live) { const cur = getCurrentStatTotal(totals, "h") + getCurrentStatTotal(totals, "r") + getCurrentStatTotal(totals, "rbi"); pOver = liveProbabilityOver("nb", seed, { mean: mean * fr, phi: NB_PHI.hrr }, cur, line); proj = cur + mean * fr; calc = liveCalc("Neg.Binom·MC", `μ=${(mean * fr).toFixed(2)} rem, φ=${NB_PHI.hrr}`, cur, proj, `${base.hrrG.toFixed(3)} (H+R+RBI)/g blend`, fr); }
    else { pOver = probabilityOver("nb", line, "over", seed, { mean, phi: NB_PHI.hrr }); proj = mean; calc = fullCalc("Neg.Binom·MC", `μ=${mean.toFixed(2)}, φ=${NB_PHI.hrr}`, proj, `${base.hrrG.toFixed(3)} (H+R+RBI)/g`, [["park", M.park], ["weather", M.weather], ["matchup", M.matchup], ["hand", M.platoon], ["lineup", M.lineup], ["opp pitching", M.team], ["statcast", M.statcast]]); }
  } else if (type === "Strikeouts") {
    const base = calculateBaseProjection(ctx);
    const oppK = ctx.oppKRate ? clamp(ctx.oppKRate / LG_KRATE, 0.75, 1.30) : 1; // widened 0.85-1.18→0.75-1.30: contact lineups now meaningfully suppress K projection
    const kSc = pitcherStatcastKAdjustment(ctx);
    const kRaw = base.kG * oppK * kSc * K_PROJ_CALIB;
    // Soft cap: regress elite K projections — high K/9 pitchers pitch fewer innings than expIp implies.
    const mean = Math.max(kRaw <= K_SOFT_CAP ? kRaw : K_SOFT_CAP + (kRaw - K_SOFT_CAP) * K_SOFT_COMPRESS, 1e-6);
    const kPerOut = (ctx.season && ctx.season.k9 ? ctx.season.k9 / 9 : 0) * oppK * kSc;
    if (live) { const curK = getCurrentStatTotal(totals, "k"); const curOuts = getCurrentStatTotal(totals, "outs"); const remOuts = Math.max(0, base.outsExp - curOuts); const remK = kPerOut * (remOuts / 3); pOver = liveProbabilityOver("nb", seed, { mean: Math.max(remK, 1e-6), phi: NB_PHI.k }, curK, line); proj = curK + remK; calc = liveCalc("Neg.Binom·MC", `μ=${remK.toFixed(2)} rem K, φ=${NB_PHI.k}`, curK, proj, `${(ctx.season && ctx.season.k9 || 0).toFixed(1)} K/9 · ${(remOuts / 3).toFixed(1)} IP left · opp K×${oppK.toFixed(2)}`, fr); }
    else { pOver = probabilityOver("nb", line, "over", seed, { mean, phi: NB_PHI.k }); proj = mean; calc = fullCalc("Neg.Binom·MC", `μ=${mean.toFixed(2)}, φ=${NB_PHI.k}`, proj, `${(ctx.season && ctx.season.k9 || 0).toFixed(1)} K/9 × ~${(base.ipExp || 5.2).toFixed(1)} IP`, [["opp K rate", oppK], ["statcast K", kSc]]); }
  } else if (type === "Outs") {
    const base = calculateBaseProjection(ctx);
    const outSc = pitcherStatcastOutsAdjustment(ctx);
    const mean = Math.max(base.outsExp * outSc * OUTS_PROJ_CALIB, 1e-6);
    // Poisson family: actual Outs var/mean=0.71 (tighter than NB). Poisson(phi=1) is much closer than NB(phi=1.5).
    if (live) { const curOuts = getCurrentStatTotal(totals, "outs"); const remOuts = Math.max(0, base.outsExp * outSc * OUTS_PROJ_CALIB - curOuts); pOver = liveProbabilityOver("poisson", seed, { mean: Math.max(remOuts, 1e-6) }, curOuts, line); proj = curOuts + remOuts; calc = liveCalc("Poisson·Outs", `μ=${remOuts.toFixed(1)} rem outs`, curOuts, proj, `~${(base.ipExp || 5.2).toFixed(1)} IP start`, fr); }
    else { pOver = probabilityOver("poisson", line, "over", seed, { mean }); proj = mean; calc = fullCalc("Poisson·Outs", `μ=${mean.toFixed(1)}`, proj, `~${(base.ipExp || 5.2).toFixed(1)} IP × 3`, [["statcast outs", outSc], ["calib", OUTS_PROJ_CALIB]]); }
  }
  return { pOver, proj, calc };
}
function fullCalc(dist, params, proj, baseStr, mults) { return { dist, params, proj, baseStr, mults, live: null }; }
function liveCalc(dist, params, current, projFinal, baseStr, fr) { return { dist, params, proj: projFinal, baseStr, mults: [], live: { current, fr } }; }

/* full evaluation of a single priced bet (model + market). */
function evalBet(b, pre) {
  const { pOver, proj, calc } = pre || projectProp(b.ctx, b.type, parseFloat(b.line));
  const rawP = b.side === "over" ? pOver : 1 - pOver;
  const odds = Number(b.odds);
  const imp = isNaN(odds) ? null : impliedProb(odds);
  const novig = (b.overOdds != null || b.underOdds != null) ? noVigProb(b.overOdds, b.underOdds, b.side) : imp;
  const fairRef = novig != null ? novig : imp;     // edge vs no-vig market when available
  // Outs sanity cap: if model projection deviates from market line by >OUTS_SANITY_DELTA,
  // pitcher IP data is likely stale (swingman evolved to starter, injury return, etc.).
  // Force modelP = fairRef so edge collapses to 0 rather than generating a false signal.
  const lineNum = parseFloat(b.line);
  const outsSanityFailed = b.type === "Outs" && proj != null && !isNaN(lineNum) && Math.abs(proj - lineNum) > OUTS_SANITY_DELTA;
  const modelP = outsSanityFailed ? fairRef : calibrateToMarket(rawP, fairRef, b.type);
  const bmult = isNaN(odds) ? 0 : (odds > 0 ? odds / 100 : 100 / -odds);
  const edge = (modelP != null && fairRef != null) ? modelP - fairRef : null;
  const ev = (modelP != null && !isNaN(odds)) ? evPerUnit(modelP, odds) : null;
  return { modelP, rawModelP: rawP, proj, calc, imp, novig, edge, ev, b: bmult, fair: modelP != null ? probToAmerican(modelP) : "—", devigged: b.overOdds != null && b.underOdds != null, outsSanityFailed };
}

/* ---------------------- statsapi ---------------------- */
const SA = "https://statsapi.mlb.com/api/v1";
async function jget(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status}`); return r.json(); }
async function fetchSchedule(date) {
  const d = await jget(`${SA}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,lineups,team,venue,linescore`);
  const games = (d.dates && d.dates[0] && d.dates[0].games) || [];
  return games.map(mapGame);
}
function classify(g) {
  const st = g.status && g.status.abstractGameState, det = (g.status && g.status.detailedState) || "";
  if (st === "Final" || det.includes("Final") || det === "Game Over") return "FINAL";
  if (st === "Live" || det.includes("Progress") || det === "Warmup") return "LIVE";
  const hl = (g.lineups && g.lineups.homePlayers && g.lineups.homePlayers.length) || 0;
  const al = (g.lineups && g.lineups.awayPlayers && g.lineups.awayPlayers.length) || 0;
  if (hl >= 9 && al >= 9) return "POSTED";
  if (hl >= 9 || al >= 9) return "PARTIAL";
  if ((g.teams.home && g.teams.home.probablePitcher) || (g.teams.away && g.teams.away.probablePitcher)) return "PENDING";
  return "SCHEDULED";
}
function mapGame(g) {
  const homeId = g.teams.home.team.id, awayId = g.teams.away.team.id;
  const rec = (t) => (t && t.leagueRecord ? `${t.leagueRecord.wins}-${t.leagueRecord.losses}` : "");
  const ls = g.linescore || {}; const num = (x) => (typeof x === "number" ? x : null);
  return {
    pk: g.gamePk, homeId, awayId,
    home: (TEAMS[homeId] && TEAMS[homeId].ab) || g.teams.home.team.abbreviation || "HOME",
    away: (TEAMS[awayId] && TEAMS[awayId].ab) || g.teams.away.team.abbreviation || "AWAY",
    homeName: (TEAMS[homeId] && TEAMS[homeId].name) || g.teams.home.team.name || "",
    awayName: (TEAMS[awayId] && TEAMS[awayId].name) || g.teams.away.team.name || "",
    homeRec: rec(g.teams.home), awayRec: rec(g.teams.away),
    time: g.gameDate ? new Date(g.gameDate).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "TBD",
    venue: (g.venue && g.venue.name) || "",
    status: classify(g),
    homeScore: num(g.teams.home.score) ?? num(ls.teams && ls.teams.home && ls.teams.home.runs),
    awayScore: num(g.teams.away.score) ?? num(ls.teams && ls.teams.away && ls.teams.away.runs),
    inning: num(ls.currentInning), inningState: ls.inningState || ls.inningHalf || null, outs: num(ls.outs),
    homeSP: g.teams.home.probablePitcher ? { id: g.teams.home.probablePitcher.id, name: g.teams.home.probablePitcher.fullName } : null,
    awaySP: g.teams.away.probablePitcher ? { id: g.teams.away.probablePitcher.id, name: g.teams.away.probablePitcher.fullName } : null,
    homeLineup: ((g.lineups && g.lineups.homePlayers) || []).map((p) => ({ id: p.id, name: p.fullName })),
    awayLineup: ((g.lineups && g.lineups.awayPlayers) || []).map((p) => ({ id: p.id, name: p.fullName })),
    manual: false,
  };
}
async function fetchHitterSeason(id, season) {
  const d = await jget(`${SA}/people/${id}/stats?stats=season&group=hitting&season=${season}`);
  const s = d.stats && d.stats[0] && d.stats[0].splits && d.stats[0].splits[0] && d.stats[0].splits[0].stat;
  if (!s) return null;
  return { g: +s.gamesPlayed || 0, ab: +s.atBats || 0, h: +s.hits || 0, hr: +s.homeRuns || 0, tb: +s.totalBases || 0, r: +s.runs || 0, rbi: +s.rbi || 0, bb: +s.baseOnBalls || 0, so: +s.strikeOuts || 0, pa: +s.plateAppearances || 0, avg: s.avg, obp: s.obp, slg: s.slg, ops: s.ops };
}
async function fetchHitterLog(id, season, n = 15) {
  const d = await jget(`${SA}/people/${id}/stats?stats=gameLog&group=hitting&season=${season}`);
  const sp = ((d.stats && d.stats[0] && d.stats[0].splits) || []).slice(-n);
  let ab = 0, h = 0, hr = 0, tb = 0, r = 0, rbi = 0;
  for (const x of sp) { ab += +x.stat.atBats || 0; h += +x.stat.hits || 0; hr += +x.stat.homeRuns || 0; tb += +x.stat.totalBases || 0; r += +x.stat.runs || 0; rbi += +x.stat.rbi || 0; }
  return { games: sp.length, ab, h, hr, tb, r, rbi, avg: ab ? h / ab : 0, ops: ab ? ((h / ab) + (tb / ab)) : 0 };
}
async function fetchBvP(batterId, pitcherId, season) {
  try {
    const d = await jget(`${SA}/people/${batterId}/stats?stats=vsPlayer&group=hitting&opposingPlayerId=${pitcherId}&season=${season}&sportId=1`);
    const splits = (d.stats && d.stats[0] && d.stats[0].splits) || [];
    const tot = splits.find((s) => !s.season) || splits[splits.length - 1] || splits[0];
    const s = tot && tot.stat; if (!s) return null;
    return { ab: +s.atBats || 0, h: +s.hits || 0, hr: +s.homeRuns || 0, avg: s.avg };
  } catch { return null; }
}
// batter hand (L/R/S) and pitcher throwing hand (L/R) for a set of player ids, one call
async function fetchHands(ids) {
  try {
    const d = await jget(`${SA}/people?personIds=${ids.join(",")}`);
    const out = {};
    for (const p of d.people || []) out[p.id] = { bats: (p.batSide && p.batSide.code) || null, throws: (p.pitchHand && p.pitchHand.code) || null };
    return out;
  } catch { return {}; }
}
// hitter's season line vs LHP and vs RHP (platoon splits)
async function fetchHitterSplits(id, season) {
  try {
    const d = await jget(`${SA}/people/${id}/stats?stats=statSplits&sitCodes=vl,vr&group=hitting&season=${season}&sportId=1`);
    const splits = (d.stats && d.stats[0] && d.stats[0].splits) || [];
    const mk = (x) => ({
      ab: +x.stat.atBats || 0, h: +x.stat.hits || 0, tb: +x.stat.totalBases || 0,
      bb: +x.stat.baseOnBalls || 0, so: +x.stat.strikeOuts || 0, pa: +x.stat.plateAppearances || 0,
      hr: +x.stat.homeRuns || 0, obp: x.stat.obp || null, slg: x.stat.slg || null,
    });
    const byCode = (code) => splits.find((s) => (s.split && s.split.code === code) || s.sitCode === code);
    let vL = byCode("vl"), vR = byCode("vr");
    vL = vL ? mk(vL) : null; vR = vR ? mk(vR) : null;
    if (!vL && !vR && splits.length >= 2) { vL = mk(splits[0]); vR = mk(splits[1]); } // fallback: assume [vl, vr] order
    if (!vL && !vR) return null;
    return { vL, vR };
  } catch { return null; }
}
async function fetchPitcherSplits(id, season) {
  try {
    const d = await jget(`${SA}/people/${id}/stats?stats=statSplits&sitCodes=vl,vr&group=pitching&season=${season}&sportId=1`);
    const splits = (d.stats && d.stats[0] && d.stats[0].splits) || [];
    const mk = (x) => ({
      bf: +x.stat.battersFaced || 0, so: +x.stat.strikeOuts || 0, bb: +x.stat.baseOnBalls || 0,
      ip: parseFloat(x.stat.inningsPitched) || 0, h: +x.stat.hits || 0,
      hr: +x.stat.homeRuns || 0, er: +x.stat.earnedRuns || 0, era: x.stat.era || null,
    });
    const byCode = (code) => splits.find((s) => (s.split && s.split.code === code) || s.sitCode === code);
    let vL = byCode("vl"), vR = byCode("vr");
    vL = vL ? mk(vL) : null; vR = vR ? mk(vR) : null;
    if (!vL && !vR && splits.length >= 2) { vL = mk(splits[0]); vR = mk(splits[1]); }
    if (!vL && !vR) return null;
    return { vL, vR };
  } catch { return null; }
}
function mapSearchPlayer(p) {
  const team = p.currentTeam || {};
  const pos = p.primaryPosition || {};
  return {
    id: p.id,
    name: p.fullName || p.nameFirstLast || "",
    teamId: team.id || null,
    team: team.name || "",
    teamAbbr: team.id && TEAMS[team.id] ? TEAMS[team.id].ab : (team.abbreviation || ""),
    position: pos.abbreviation || pos.code || "",
    positionName: pos.name || "",
    bats: p.batSide && p.batSide.code ? p.batSide.code : null,
    throws: p.pitchHand && p.pitchHand.code ? p.pitchHand.code : null,
    active: p.active,
    height: p.height || "",
    weight: p.weight || "",
    birthDate: p.birthDate || "",
    debut: p.mlbDebutDate || "",
  };
}
function likelyMlbPlayer(p) {
  return p && p.id && p.name && (p.team || p.position || p.active !== false);
}
async function searchPlayers(q, season) {
  const query = String(q || "").trim();
  if (!query) return [];
  try {
    const d = await jget(`${SA}/people/search?names=${encodeURIComponent(query)}&sportIds=1&hydrate=currentTeam`);
    const people = (d.people || []).map(mapSearchPlayer).filter(likelyMlbPlayer);
    if (people.length) return people.slice(0, 12);
  } catch { /* fall through to active-player list */ }
  const d = await jget(`${SA}/sports/1/players?season=${season}&hydrate=currentTeam`);
  const nq = normName(query);
  return (d.people || [])
    .map(mapSearchPlayer)
    .filter((p) => likelyMlbPlayer(p) && normName(p.name).includes(nq))
    .slice(0, 12);
}
async function fetchPlayerBio(id) {
  try {
    const d = await jget(`${SA}/people/${id}?hydrate=currentTeam`);
    const p = d.people && d.people[0];
    return p ? mapSearchPlayer(p) : null;
  } catch {
    try {
      const d = await jget(`${SA}/people?personIds=${id}&hydrate=currentTeam`);
      const p = d.people && d.people[0];
      return p ? mapSearchPlayer(p) : null;
    } catch { return null; }
  }
}
function primaryPlayerKind(player, hitterSeason, pitcherSeason) {
  if (pitcherSeason && (!hitterSeason || (player && String(player.position).toUpperCase() === "P"))) return "pitcher";
  if (player && String(player.position).toUpperCase() === "P") return "pitcher";
  return "hitter";
}
function displayRate(x) {
  if (x == null || !isFinite(x)) return "—";
  return Number(x).toFixed(3).replace(/^0/, "");
}
function displayNum(x, d = 1) {
  if (x == null || !isFinite(x)) return "—";
  return Number(x).toFixed(d);
}
function safeDiv(a, b) { return b ? a / b : null; }
function outsToIp(outs) {
  if (outs == null || !isFinite(outs)) return "—";
  const o = Math.max(0, Math.round(outs));
  return `${Math.floor(o / 3)}.${o % 3}`;
}
async function fetchPlayerGameLogs(id, season, group, n = 20) {
  try {
    const d = await jget(`${SA}/people/${id}/stats?stats=gameLog&group=${group}&season=${season}`);
    const splits = ((d.stats && d.stats[0] && d.stats[0].splits) || [])
      .slice()
      .sort((a, b) => Date.parse(a.date || "") - Date.parse(b.date || ""))
      .slice(-n)
      .reverse();
    return splits.map((x) => ({
      date: x.date || "",
      gamePk: x.game && x.game.gamePk,
      opponent: (x.opponent && (x.opponent.abbreviation || x.opponent.name)) || "",
      homeAway: x.isHome ? "vs" : "@",
      stat: x.stat || {},
    }));
  } catch { return []; }
}
function aggregateHittingWindow(logs, n) {
  const rows = (logs || []).slice(0, n);
  let ab = 0, h = 0, hr = 0, tb = 0, r = 0, rbi = 0, bb = 0, so = 0, pa = 0;
  for (const x of rows) {
    const s = x.stat || {};
    ab += +s.atBats || 0; h += +s.hits || 0; hr += +s.homeRuns || 0; tb += +s.totalBases || 0;
    r += +s.runs || 0; rbi += +s.rbi || 0; bb += +s.baseOnBalls || 0; so += +s.strikeOuts || 0; pa += +s.plateAppearances || 0;
  }
  return { games: rows.length, ab, h, hr, tb, r, rbi, bb, so, pa, avg: safeDiv(h, ab), tbG: safeDiv(tb, rows.length), hrrG: safeDiv(h + r + rbi, rows.length), kRate: safeDiv(so, pa || ab + bb) };
}
function aggregatePitchingWindow(logs, n) {
  const rows = (logs || []).slice(0, n);
  let outs = 0, so = 0, er = 0, h = 0, bb = 0, hr = 0, bf = 0;
  for (const x of rows) {
    const s = x.stat || {};
    outs += ipToOuts(s.inningsPitched);
    so += +s.strikeOuts || 0; er += +s.earnedRuns || 0; h += +s.hits || 0; bb += +s.baseOnBalls || 0; hr += +s.homeRuns || 0; bf += +s.battersFaced || 0;
  }
  return { games: rows.length, outs, ip: outs / 3, so, er, h, bb, hr, bf, era: outs ? er * 27 / outs : null, k9: outs ? so * 27 / outs : null, bb9: outs ? bb * 27 / outs : null };
}
async function fetchPlayerAnalysisProfile(player, season, throughDate) {
  const id = player && player.id;
  if (!id) throw new Error("No player selected.");
  const [bio, hitterSeason, pitcherBase, hitterLogs, pitcherLogs, hitterSplits, pitcherRecentLog, pitcherSplits] = await Promise.all([
    fetchPlayerBio(id),
    fetchHitterSeason(id, season).catch(() => null),
    fetchPitcherSeason(id, season).catch(() => null),
    fetchPlayerGameLogs(id, season, "hitting", 20),
    fetchPlayerGameLogs(id, season, "pitching", 20),
    fetchHitterSplits(id, season).catch(() => null),
    fetchPitcherLog(id, season).catch(() => null),
    fetchPitcherSplits(id, season).catch(() => null),
  ]);
  const pitcherSeason = pitcherBase ? { ...pitcherBase } : null;
  if (pitcherSeason && pitcherRecentLog) {
    pitcherSeason.recentLog = pitcherRecentLog;
    pitcherSeason.expIp = expectedStartIP(pitcherSeason.ip, pitcherSeason.gs, pitcherSeason.gp, pitcherRecentLog);
  }
  const merged = { ...player, ...(bio || {}) };
  const kind = primaryPlayerKind(merged, hitterSeason, pitcherSeason);
  let statcastBatter = null, statcastPitcher = null;
  if (hitterSeason || kind === "hitter") statcastBatter = await fetchPlayerSeasonStatcast(id, "batter", season, throughDate).catch((e) => ({ verdict: `blocked:${e.message || "csv"}`, source: "savant_csv" }));
  if (pitcherSeason || kind === "pitcher") statcastPitcher = await fetchPlayerSeasonStatcast(id, "pitcher", season, throughDate).catch((e) => ({ verdict: `blocked:${e.message || "csv"}`, source: "savant_csv" }));
  return {
    player: merged,
    kind,
    hitterSeason,
    pitcherSeason,
    hitterLogs,
    pitcherLogs,
    hitterSplits,
    pitcherSplits,
    statcastBatter,
    statcastPitcher: attachPitcherHr9FromStatsApi(statcastPitcher, pitcherSeason),
    hittingWindows: [5, 10, 20].map((n) => ({ n, ...aggregateHittingWindow(hitterLogs, n) })),
    pitchingWindows: [5, 10, 20].map((n) => ({ n, ...aggregatePitchingWindow(pitcherLogs, n) })),
  };
}
async function fetchPitcherSeason(id, season) {
  const d = await jget(`${SA}/people/${id}/stats?stats=season&group=pitching&season=${season}`);
  const s = d.stats && d.stats[0] && d.stats[0].splits && d.stats[0].splits[0] && d.stats[0].splits[0].stat;
  if (!s) return null;
  const ip = parseFloat(s.inningsPitched) || 0, gs = +s.gamesStarted || 0, gp = +s.gamesPlayed || 0, so = +s.strikeOuts || 0;
  const bb = +s.baseOnBalls || 0, bf = +s.battersFaced || 0, hrA = +s.homeRuns || 0, hbp = +s.hitBatsmen || 0, h = +s.hits || 0;
  const fip = ip ? ((13 * hrA + 3 * (bb + hbp) - 2 * so) / ip) + FIP_CONST : null; // skill-only run prevention, park/defense neutral
  return { era: s.era, so, bb, bf, hrA, h, ip, gs, gp, fip, k9: ip ? (so * 9 / ip) : 0, expIp: expectedStartIP(ip, gs, gp, null), role: pitcherRole(gs, gp) };
}
// Fetch a pitcher's last N starts (game log filtered to starts) to get a recent rolling IP/start.
// Mirrors the hitter L15 layer: season average is dragged down by early short starts / April ramp;
// recent starts reflect the pitcher's current mid-season workload. Falls back gracefully (null) if blocked.
async function fetchPitcherLog(id, season, n = 5) {
  try {
    const d = await jget(`${SA}/people/${id}/stats?stats=gameLog&group=pitching&season=${season}`);
    const splits = ((d.stats && d.stats[0] && d.stats[0].splits) || [])
      .filter((s) => +(s.stat.gamesStarted || 0) > 0)   // starts only
      .slice(-n);
    if (!splits.length) return null;
    const totalIp = splits.reduce((s, x) => s + (parseFloat(x.stat.inningsPitched) || 0), 0);
    const totalSo = splits.reduce((s, x) => s + (+x.stat.strikeOuts || 0), 0);
    // avgK = recent K/9 over last n starts — blended with season K/9 in calculateBaseProjection
    const avgK = totalIp > 0 ? (totalSo * 9) / totalIp : null;
    return { games: splits.length, avgIp: totalIp / splits.length, avgK };
  } catch { return null; }
}
function expectedStartIP(ip, gs, gp, recentLog) {
  const perStart = gs > 0 ? ip / gs : 0;
  const reliefHeavy = gp > 0 && gs / gp < 0.6;
  // Layer 1 (8/27): override stale reliefHeavy flag when recent starts confirm genuine starter workload.
  // Swingmen who transitioned mid-season (Manaea-type) show gs/gp < 0.6 from early relief appearances,
  // but their last 3+ starts averaging 4.5+ IP prove they are now being used as starters.
  // Without this, the reliefHeavy branch hard-codes 4.0 IP → ~12 outs → blows the sanity cap on Outs.
  const recentlyStarting = !!(recentLog && recentLog.games >= 3 && recentLog.avgIp >= 4.5);
  let exp;
  if (recentlyStarting) {
    // Recent data is authoritative. For reliefHeavy pitchers use 5.0 as season anchor
    // (season per-start is dragged down by early relief stints); for true starters just use perStart.
    const anchor = reliefHeavy ? 5.0 : Math.max(perStart, 4.5);
    exp = 0.65 * recentLog.avgIp + 0.35 * anchor;   // 65% recent, 35% season anchor
  } else if (gs >= 4 && perStart >= 3 && perStart <= 7 && !reliefHeavy) {
    // Normal starter path: increased recent weight 30%→50% for mid-season responsiveness.
    const blendedPerStart = (recentLog && recentLog.games >= 3)
      ? 0.50 * perStart + 0.50 * recentLog.avgIp
      : perStart;
    exp = 0.60 * blendedPerStart + 0.40 * 6.10;
  } else if (reliefHeavy) {
    exp = 4.0;
  } else {
    exp = 5.0;
  }
  return clamp(exp, 2.5, 6.8);
}
function pitcherRole(gs, gp) { if (gp > 0 && gs / gp < 0.6) return "swing"; if (gs >= 4) return "starter"; return "limited"; }
async function fetchTeamRPG(teamId, season) {
  try {
    const h = await jget(`${SA}/teams/${teamId}/stats?stats=season&group=hitting&season=${season}&sportId=1`);
    const p = await jget(`${SA}/teams/${teamId}/stats?stats=season&group=pitching&season=${season}&sportId=1`);
    const hs = h.stats && h.stats[0] && h.stats[0].splits && h.stats[0].splits[0] && h.stats[0].splits[0].stat;
    const ps = p.stats && p.stats[0] && p.stats[0].splits && p.stats[0].splits[0] && p.stats[0].splits[0].stat;
    const gp = +(hs && hs.gamesPlayed) || 0, runs = +(hs && hs.runs) || 0;
    const pgp = +(ps && ps.gamesPlayed) || 0, ra = +(ps && ps.runs) || 0;
    const pa = +(hs && hs.plateAppearances) || +(hs && hs.atBats) || 0;
    const so = +(hs && hs.strikeOuts) || 0;                       // team's OWN offense K's
    return { rpg: gp ? runs / gp : LG_RPG, rapg: pgp ? ra / pgp : LG_RPG, kRate: pa ? so / pa : LG_KRATE };
  } catch { return { rpg: LG_RPG, rapg: LG_RPG, kRate: LG_KRATE }; }
}
async function fetchWeather(lat, lon) {
  try {
    const d = await jget(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation_probability,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=2&timezone=auto`);
    const i = new Date().getHours(); const h = d.hourly;
    return { temp: Math.round(h.temperature_2m && h.temperature_2m[i]), pop: h.precipitation_probability && h.precipitation_probability[i], wind: Math.round(h.wind_speed_10m && h.wind_speed_10m[i]) };
  } catch { return null; }
}
function parseBoxPlayers(box) {
  const players = {};
  for (const side of ["home", "away"]) {
    const pl = (box && box.teams && box.teams[side] && box.teams[side].players) || {};
    for (const key in pl) {
      const person = pl[key].person; if (!person) continue;
      const bat = (pl[key].stats && pl[key].stats.batting) || {};
      const pit = (pl[key].stats && pl[key].stats.pitching) || {};
      const hits = +bat.hits || 0, dbl = +bat.doubles || 0, tpl = +bat.triples || 0, hr = +bat.homeRuns || 0;
      const pa = +bat.plateAppearances || 0, ab = +bat.atBats || 0, r = +bat.runs || 0, rbi = +bat.rbi || 0;
      const bf = +pit.battersFaced || 0, outs = ipToOuts(pit.inningsPitched), k = +pit.strikeOuts || 0;
      players[person.id] = {
        h: hits, tb: hits + dbl + 2 * tpl + 3 * hr, r, rbi, hr, k, outs,
        batted: pa > 0 || ab > 0 || hits > 0 || r > 0 || rbi > 0,   // did the hitter actually appear?
        pitched: bf > 0 || outs > 0 || k > 0,                        // did the pitcher actually appear?
      };
    }
  }
  return players;
}
async function fetchLiveBox(pk) { try { return parseBoxPlayers(await jget(`${SA}/game/${pk}/boxscore`)); } catch { return null; } }
async function fetchGameResult(pk) {
  try {
    const d = await jget(`https://statsapi.mlb.com/api/v1.1/game/${pk}/feed/live`);
    const status = d.gameData && d.gameData.status && d.gameData.status.abstractGameState;
    const ls = (d.liveData && d.liveData.linescore) || {};
    const homeRuns = ls.teams && ls.teams.home ? ls.teams.home.runs : null;
    const awayRuns = ls.teams && ls.teams.away ? ls.teams.away.runs : null;
    return { final: status === "Final", players: parseBoxPlayers((d.liveData && d.liveData.boxscore) || {}), homeRuns, awayRuns };
  } catch { return { final: false, players: {}, homeRuns: null, awayRuns: null }; }
}

/* ---------------------- Baseball Savant / Statcast optional layer ---------------------- */
function proxifyStatcast(url) { return STATCAST_PROXY_BASE ? `${STATCAST_PROXY_BASE}?url=${encodeURIComponent(url)}` : url; }
function numOrNull(v) { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
const STATCAST_KEYS = ["hit_speed", "hit_angle", "hit_distance", "xba", "estimated_ba", "start_speed", "spin_rate", "spinRate", "launch_speed", "launchSpeed", "launch_angle", "launchAngle"];
function scanForKeys(obj, keys, found, depth = 0) {
  if (depth > 6 || obj == null || typeof obj !== "object") return;
  for (const k of Object.keys(obj)) {
    if (keys.includes(k) && obj[k] != null && obj[k] !== "") found.add(k);
    const v = obj[k];
    if (Array.isArray(v)) for (let i = 0; i < Math.min(v.length, 5); i++) scanForKeys(v[i], keys, found, depth + 1);
    else if (v && typeof v === "object") scanForKeys(v, keys, found, depth + 1);
  }
}
function findBattedBallArray(feed) {
  if (Array.isArray(feed && feed.exit_velocity) && feed.exit_velocity.length) return feed.exit_velocity;
  let best = [];
  const visit = (o, depth) => {
    if (depth > 6 || o == null || typeof o !== "object") return;
    if (Array.isArray(o)) {
      const looksRight = o.some((it) => it && typeof it === "object" && ("hit_speed" in it || "xba" in it || "estimated_ba" in it || "launchSpeed" in it || "launch_speed" in it));
      if (looksRight && o.length > best.length) best = o;
      o.slice(0, 5).forEach((it) => visit(it, depth + 1));
    } else {
      for (const k of Object.keys(o)) visit(o[k], depth + 1);
    }
  };
  visit(feed, 0);
  return best;
}
function extractBattedBalls(feed) {
  const arr = findBattedBallArray(feed);
  return arr.map((e) => ({
    batterId: numOrNull(e.batter ?? e.batter_id),
    batterName: e.batter_name ?? e.name ?? "",
    pitcherId: numOrNull(e.pitcher ?? e.pitcher_id),
    inning: numOrNull(e.inning),
    result: e.result ?? e.events ?? "",
    exitVelocity: numOrNull(e.hit_speed ?? e.launch_speed ?? e.launchSpeed),
    launchAngle: numOrNull(e.hit_angle ?? e.launch_angle ?? e.launchAngle),
    distance: numOrNull(e.hit_distance ?? e.total_distance ?? e.totalDistance),
    xba: numOrNull(e.xba ?? e.estimated_ba ?? e.xBA),
  })).filter((b) => b.batterId != null && (b.exitVelocity != null || b.launchAngle != null || b.xba != null));
}
function verifyStatcast(feed) {
  if (!feed || typeof feed !== "object" || Object.keys(feed).length === 0) return { hasFeed: false, advancedFieldsFound: [], battedBallsWithExitVelo: 0, battedBallsWithXBA: 0, verdict: "empty" };
  const found = new Set(); scanForKeys(feed, STATCAST_KEYS, found, 0);
  const balls = extractBattedBalls(feed);
  const withEV = balls.filter((b) => b.exitVelocity != null).length;
  const withXBA = balls.filter((b) => b.xba != null).length;
  const verdict = withXBA > 0 ? "statcast_confirmed" : (withEV > 0 || found.size > 0 ? "tracking_only" : "boxscore_only");
  return { hasFeed: true, advancedFieldsFound: Array.from(found), battedBallsWithExitVelo: withEV, battedBallsWithXBA: withXBA, sample: balls[0], verdict };
}
function aggregateStatcastByBatter(battedBalls) {
  const out = {};
  for (const b of battedBalls || []) {
    if (b.batterId == null) continue;
    const id = String(b.batterId);
    const r = out[id] || { bbe: 0, withXBA: 0, xbaSum: 0, withEV: 0, evSum: 0, hardHit: 0, barrelish: 0, balls: [] };
    r.bbe += 1; r.balls.push(b);
    if (b.xba != null) { r.withXBA += 1; r.xbaSum += b.xba; }
    if (b.exitVelocity != null) { r.withEV += 1; r.evSum += b.exitVelocity; if (b.exitVelocity >= 95) r.hardHit += 1; }
    if (b.exitVelocity != null && b.launchAngle != null && b.exitVelocity >= 98 && b.launchAngle >= 8 && b.launchAngle <= 32) r.barrelish += 1;
    out[id] = r;
  }
  for (const id in out) {
    const r = out[id];
    r.avgXBA = r.withXBA ? r.xbaSum / r.withXBA : null;
    r.avgEV = r.withEV ? r.evSum / r.withEV : null;
    r.hardHitRate = r.withEV ? r.hardHit / r.withEV : null;
    r.barrelishRate = r.bbe ? r.barrelish / r.bbe : null;
  }
  return out;
}
async function fetchGameStatcast(gamePk) {
  const url = `${SAVANT_BASE}/gf?game_pk=${gamePk}`;
  const feed = await jget(proxifyStatcast(url));
  const battedBalls = extractBattedBalls(feed);
  const verification = verifyStatcast(feed);
  return { gamePk, verification, battedBalls, byBatter: aggregateStatcastByBatter(battedBalls) };
}
function emptyStatcast(reason = "not_fetched") { return { verification: { hasFeed: false, advancedFieldsFound: [], battedBallsWithExitVelo: 0, battedBallsWithXBA: 0, verdict: reason }, battedBalls: [], byBatter: {} }; }


function statcastCacheGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.ts || Date.now() - obj.ts > STATCAST_SEASON_TTL_MS) return null;
    return obj.data || null;
  } catch { return null; }
}
function statcastCacheSet(key, data) { try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch {} }
function csvCell(v) { return v == null ? "" : String(v); }
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (q) { if (c === '"' && n === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else { if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ""; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ""; } else if (c !== '\r') cell += c; }
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => r.some((x) => x !== "")).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}
function seasonStartFor(year) { return `${year}-03-01`; }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function statcastSearchUrl({ playerId, playerType, startDate, endDate }) {
  const lookup = playerType === "pitcher" ? `pitchers_lookup%5B%5D=${encodeURIComponent(playerId)}` : `batters_lookup%5B%5D=${encodeURIComponent(playerId)}`;
  return `${SAVANT_BASE}/statcast_search/csv?all=true&hfPT=&hfAB=&hfBBT=&hfPR=&hfZ=&stadium=&hfBBL=&hfNewZones=&hfGT=R%7C&hfSea=&hfSit=&player_type=${playerType}&hfOuts=&opponent=&pitcher_throws=&batter_stands=&hfSA=&game_date_gt=${startDate}&game_date_lt=${endDate}&${lookup}&team=&position=&hfRO=&home_road=&hfFlag=&metric_1=&hfInn=&min_pitches=0&min_results=0&group_by=name&sort_col=pitches&player_event_sort=h_launch_speed&sort_order=desc&min_abs=0&type=details&`;
}
function isBattedBall(row) { return row && row.type === "X" && (row.launch_speed !== "" || row.launch_angle !== "" || row.bb_type !== ""); }
function isWhiff(desc) { desc = String(desc || "").toLowerCase(); return desc.includes("swinging_strike") || desc.includes("swinging strike") || desc.includes("foul_tip") || desc.includes("foul tip"); }
function isCalledOrWhiff(desc) { desc = String(desc || "").toLowerCase(); return isWhiff(desc) || desc.includes("called_strike") || desc.includes("called strike"); }
function aggregateSeasonStatcast(rows, playerType) {
  let pitches = 0, bbe = 0, evN = 0, evSum = 0, xbaN = 0, xbaSum = 0, xwN = 0, xwSum = 0;
  let hard = 0, barrels = 0, fb = 0, pullFb = 0, hr = 0, whiff = 0, csw = 0;
  for (const r of rows || []) {
    pitches += 1;
    const desc = r.description || "";
    if (isWhiff(desc)) whiff += 1;
    if (isCalledOrWhiff(desc)) csw += 1;
    const ev = numOrNull(r.launch_speed), la = numOrNull(r.launch_angle), lsa = numOrNull(r.launch_speed_angle);
    const xba = numOrNull(r.estimated_ba_using_speedangle), xw = numOrNull(r.estimated_woba_using_speedangle);
    const bbType = String(r.bb_type || "");
    const events = String(r.events || "").toLowerCase();
    if (events === "home_run") hr += 1;
    if (isBattedBall(r)) {
      bbe += 1;
      if (ev != null) { evN += 1; evSum += ev; if (ev >= 95) hard += 1; }
      if (xba != null) { xbaN += 1; xbaSum += xba; }
      if (xw != null) { xwN += 1; xwSum += xw; }
      if (lsa === 6) barrels += 1;
      // Conservative fallback barrel detector when launch_speed_angle is absent.
      else if (ev != null && la != null && ev >= 98 && la >= 8 && la <= 32) barrels += 1;
      const isAir = bbType === "fly_ball" || bbType === "popup";
      if (isAir) {
        fb += 1;
        const stand = String(r.stand || "").toUpperCase();
        const hcX = numOrNull(r.hc_x);
        // Savant hit coordinates are not a perfect spray-angle feed; this is only a light pull/air proxy.
        if (hcX != null && ((stand === "R" && hcX < 125) || (stand === "L" && hcX > 125))) pullFb += 1;
      }
    }
  }
  const base = {
    verdict: bbe > 0 ? "season_confirmed" : (pitches > 0 ? "tracking_only" : "empty"),
    source: "savant_csv", playerType, pitches, bbe,
    avgEV: evN ? evSum / evN : null,
    hardHitRate: evN ? hard / evN : null,
    barrelRate: bbe ? barrels / bbe : null,
    fbRate: bbe ? fb / bbe : null,
    pullFbRate: bbe ? pullFb / bbe : null,
    xba: xbaN ? xbaSum / xbaN : null,
    xwoba: xwN ? xwSum / xwN : null,
    whiffRate: pitches ? whiff / pitches : null,
    cswRate: pitches ? csw / pitches : null,
  };
  if (playerType === "pitcher") {
    base.xwobaAllowed = base.xwoba;
    base.barrelAllowedRate = base.barrelRate;
    base.hardHitAllowedRate = base.hardHitRate;
    base.hrAllowed = hr;
  }
  return base;
}
async function fetchPlayerSeasonStatcast(playerId, playerType, season, throughDate) {
  if (!playerId) return { verdict: "empty", source: "none" };
  const endDate = throughDate || todayISO();
  const startDate = seasonStartFor(season || endDate.slice(0, 4));
  const key = `mlbEF:statcastSeason:v2:${playerType}:${playerId}:${startDate}:${endDate}`;
  const cached = statcastCacheGet(key); if (cached) return { ...cached, cached: true };
  try {
    const url = statcastSearchUrl({ playerId, playerType, startDate, endDate });
    const res = await fetch(proxifyStatcast(url));
    if (!res.ok) throw new Error(`csv ${res.status}`);
    const txt = await res.text();
    const rows = parseCsv(txt);
    if (rows.length && rows[0].error) throw new Error(rows[0].error);
    const data = aggregateSeasonStatcast(rows, playerType);
    data.rows = rows.length; data.cached = false;
    statcastCacheSet(key, data);
    return data;
  } catch (e) {
    return { verdict: `blocked:${e.message || "csv"}`, source: "savant_csv", playerType, pitches: 0, bbe: 0 };
  }
}
/* ---- Season Statcast via league LEADERBOARDS (hitters) ----
   One daily pull of two batter leaderboards covers every qualified hitter,
   replacing ~18 per-player pitch-dump downloads per game. Column-tolerant, so a
   minor header rename won't break it. Players below the leaderboard minimum (or
   not yet listed) fall back to the per-player CSV path. If the leaderboard fetch
   is CORS-blocked, every hitter falls back too -> identical to current behavior,
   never worse. Pitchers stay on the per-player path to keep whiff%/CSW%. */
   function statcastLeaderboardUrl(board, type, year) {
    // board: "expected_statistics" | "statcast" (exit velocity & barrels)
    return `${SAVANT_BASE}/leaderboard/${board}?type=${type}&year=${year}&position=&team=&min=1&csv=true`;
  }
  function lbPick(row, candidates) {
    for (const c of candidates) if (row[c] !== undefined && row[c] !== "") return row[c];
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
    const keys = Object.keys(row);
    for (const c of candidates) { const want = norm(c); const hit = keys.find((k) => norm(k) === want); if (hit && row[hit] !== "") return row[hit]; }
    return null;
  }
  function lbPctToFraction(v) { const n = numOrNull(v); if (n == null) return null; return n > 1.5 ? n / 100 : n; } // boards give 0-100
  function mergeLeaderboard(store, rows, board) {
    for (const r of rows || []) {
      const id = numOrNull(lbPick(r, ["player_id", "playerid", "entity_id", "mlbam_id", "id"]));
      if (id == null) continue;
      const k = String(id);
      const rec = store[k] || { id, source: "savant_leaderboard" };
      if (board === "expected_statistics") {
        rec.xba = numOrNull(lbPick(r, ["est_ba", "xba", "estimated_ba", "expected_ba"]));
        rec.xwoba = numOrNull(lbPick(r, ["est_woba", "xwoba", "estimated_woba", "expected_woba"]));
        rec.pa = numOrNull(lbPick(r, ["pa", "plate_appearances"]));
        rec.bip = numOrNull(lbPick(r, ["bip", "batted_balls", "balls_in_play"]));
      } else { // exit velocity & barrels
        rec.avgEV = numOrNull(lbPick(r, ["avg_hit_speed", "avg_ev", "avg_exit_velocity", "exit_velocity_avg"]));
        rec.attempts = numOrNull(lbPick(r, ["attempts", "bbe", "batted_balls", "total_bip"]));
        rec.hardHitRate = lbPctToFraction(lbPick(r, ["ev95percent", "ev95per", "hard_hit_percent", "hardhit_percent", "hard_hit_rate"]));
        rec.barrelRate = lbPctToFraction(lbPick(r, ["brl_percent", "barrels_per_bbe_percent", "barrel_batted_rate", "barrel_percent"]));
      }
      store[k] = rec;
    }
  }
  async function fetchHitterStatcastLeaderboards(season) {
    const yr = String(season || todayISO().slice(0, 4));
    const cacheKey = `mlbEF:statcastLB:v1:batter:${yr}`;            // shares the 6h TTL via statcastCacheGet
    const cached = statcastCacheGet(cacheKey);
    if (cached) return cached;
    const store = {};
    const boards = ["expected_statistics", "statcast"];           // xBA/xwOBA, then EV/hard-hit/barrel
    const results = await Promise.allSettled(boards.map(async (board) => {
      const res = await fetch(proxifyStatcast(statcastLeaderboardUrl(board, "batter", yr)));
      if (!res.ok) throw new Error(`${board} ${res.status}`);
      const rows = parseCsv(await res.text());
      if (rows.length && rows[0].error) throw new Error(rows[0].error);
      mergeLeaderboard(store, rows, board);
      return board;
    }));
    const ok = results.some((r) => r.status === "fulfilled") && Object.keys(store).length > 0;
    const bundle = { batter: store, ok, fetchedAt: Date.now(), errors: results.filter((r) => r.status === "rejected").map((r) => String((r.reason && r.reason.message) || r.reason)) };
    if (ok) statcastCacheSet(cacheKey, bundle);
    return bundle;
  }
  function lbToSeasonStatcast(rec) {
    const bbe = rec.attempts != null ? rec.attempts : (rec.bip != null ? rec.bip : 0);
    return {
      verdict: (rec.xba != null || rec.xwoba != null || rec.avgEV != null) ? "season_confirmed" : "empty",
      source: "savant_leaderboard", playerType: "batter",
      pitches: rec.pa != null ? Math.round(rec.pa * 3.9) : 0,
      bbe,
      avgEV: rec.avgEV != null ? rec.avgEV : null,
      hardHitRate: rec.hardHitRate != null ? rec.hardHitRate : null,
      barrelRate: rec.barrelRate != null ? rec.barrelRate : null,
      fbRate: null, pullFbRate: null,                              // not on these boards -> HR mult uses HH/barrel only
      xba: rec.xba != null ? rec.xba : null,
      xwoba: rec.xwoba != null ? rec.xwoba : null,
      whiffRate: null, cswRate: null,
      cached: true,
    };
  }
  async function resolveHitterSeasonStatcast(lb, playerId, season, throughDate) {
    const rec = lb && lb.batter && lb.batter[String(playerId)];
    if (rec && (rec.xba != null || rec.xwoba != null || rec.avgEV != null)) return lbToSeasonStatcast(rec);
    return fetchPlayerSeasonStatcast(playerId, "batter", season, throughDate); // fallback: below min / not listed / board blocked
  }
function attachPitcherHr9FromStatsApi(sc, seasonStats) {
  if (!sc || !seasonStats) return sc;
  const ip = seasonStats.ip || 0;
  return { ...sc, hr9: ip ? ((seasonStats.hrA || 0) * 9 / ip) : null };
}
function statcastCoverageSummary(hitters, spStats, liveStatcast) {
  const hs = Object.values(hitters || {}).map((h) => h.statcastSeason).filter(Boolean);
  const ps = Object.values(spStats || {}).map((p) => p && p.statcastSeason).filter(Boolean);
  const confirmedH = hs.filter((x) => x.verdict === "season_confirmed").length;
  const confirmedP = ps.filter((x) => x.verdict === "season_confirmed").length;
  const lbH = hs.filter((x) => x.source === "savant_leaderboard").length;
  const ppH = hs.filter((x) => x.source === "savant_csv").length;
  const lbP = ps.filter((x) => x.source === "savant_leaderboard").length;
  const ppP = ps.filter((x) => x.source === "savant_csv").length;
  const totalXBA = hs.reduce((a, x) => a + (x.xba != null ? x.bbe || 0 : 0), 0);
  const totalEV = hs.reduce((a, x) => a + (x.avgEV != null ? x.bbe || 0 : 0), 0) + ps.reduce((a, x) => a + (x.avgEV != null ? x.bbe || 0 : 0), 0);
  const liveVerdict = liveStatcast && liveStatcast.verification ? liveStatcast.verification.verdict : "not_fetched";
  const verdict = confirmedH || confirmedP ? "season_confirmed" : liveVerdict;
  const sources = `hitters LB ${lbH}/perPlayer ${ppH} · SP perPlayer ${ppP}${lbP ? `/LB ${lbP}` : ""}`;
  return { hasFeed: !!(confirmedH || confirmedP), verdict, sources, advancedFieldsFound: ["launch_speed", "launch_angle", "estimated_ba_using_speedangle", "estimated_woba_using_speedangle", "launch_speed_angle", "bb_type"], battedBallsWithExitVelo: totalEV, battedBallsWithXBA: totalXBA, seasonHitters: `${confirmedH}/${hs.length}`, seasonPitchers: `${confirmedP}/${ps.length}`, liveVerdict };
}

/* ---------------------- The Odds API ---------------------- */
function normName(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z ]/g, " ").replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/\s+/g, " ").trim();
}
function oddsProxyFetch(path: string, query: string) {
  const url = `${ODDS_PROXY_URL}?path=${encodeURIComponent(path)}&query=${encodeURIComponent(query)}`;
  return fetch(url, { headers: { "apikey": SUPABASE_ANON_KEY } });
}
async function fetchOddsEvents() {
  const r = await oddsProxyFetch(`/sports/${ODDS_SPORT}/events`, "dateFormat=iso");
  const remaining = r.headers.get("x-requests-remaining");
  if (!r.ok) throw new Error(`events ${r.status}`);
  const data = await r.json();
  return { events: data || [], remaining: remaining != null ? +remaining : null };
}
async function fetchEventOdds(eventId, book) {
  const markets = [...Object.values(TYPE_TO_MARKET), ...GAME_MARKETS].join(","); // props + moneyline/run line/total
  const r = await oddsProxyFetch(`/sports/${ODDS_SPORT}/events/${eventId}/odds`, `regions=us&markets=${markets}&oddsFormat=american&bookmakers=${book}`);
  const remaining = r.headers.get("x-requests-remaining");
  if (!r.ok) throw new Error(`odds ${r.status}`);
  const data = await r.json();
  return { data, remaining: remaining != null ? +remaining : null };
}
function matchEvent(events, g) {
  const hn = normName(g.homeName), an = normName(g.awayName);
  return (events || []).find((e) => normName(e.home_team).includes(hn) && normName(e.away_team).includes(an));
}
// -> [{ type, player, point, over, under }]
// Robust to: Over/Under markets, Yes/No markets (HR), missing point (->0.5),
// and the side appearing in EITHER the name or description field.
const sideOf = (s) => { s = (s || "").toLowerCase().trim(); if (s === "over" || s === "yes") return "over"; if (s === "under" || s === "no") return "under"; return null; };
function parseEventOdds(data, bookKey) {
  const bm = (data.bookmakers || []).find((b) => b.key === bookKey) || (data.bookmakers || [])[0];
  if (!bm) return [];
  const rows = [];
  for (const mk of bm.markets || []) {
    const type = MARKET_TO_TYPE[mk.key]; if (!type) continue;
    const byKey = {};
    for (const o of mk.outcomes || []) {
      let side = sideOf(o.name), player = o.description;
      if (!side && sideOf(o.description)) { side = sideOf(o.description); player = o.name; }   // fields flipped
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
// game lines (moneyline / run line / total) for the chosen book
function parseGameOdds(data, bookKey, g) {
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
// match a tracked bet to its current price from freshly-pulled odds (props rows + game lines gl)
function matchCurrentOdds(bet, rows, gl) {
  const t = bet.type, ln = Number(bet.line);
  if (t === "Moneyline") return gl && gl.h2h ? (bet.side === "home" ? gl.h2h.home : gl.h2h.away) ?? null : null;
  if (t === "Total") { if (!gl || !gl.totals || gl.totals.point == null || Math.abs(gl.totals.point - ln) > 1e-6) return null; return (bet.side === "over" ? gl.totals.over : gl.totals.under) ?? null; }
  if (t === "Run Line") { if (!gl || !gl.spreads) return null; const pt = bet.side === "home" ? gl.spreads.homePoint : gl.spreads.awayPoint; if (pt == null || Math.abs(pt - ln) > 1e-6) return null; return (bet.side === "home" ? gl.spreads.home : gl.spreads.away) ?? null; }
  const bn = normName(bet.name);
  const r = (rows || []).find((x) => x.type === t && normName(x.player) === bn && Math.abs(x.point - ln) < 1e-6);
  if (!r) return null;
  return (bet.side === "over" ? r.over : r.under) ?? null;
}
// build moneyline / total / run-line board entries from our model + market odds
function buildGameLineEntries(g, d, gl, book) {
  const entries = [];
  const lambdaH = d.lambdaH, lambdaA = d.lambdaA;
  const liveFr = (d.live && d.live.fractionRemaining != null) ? d.live.fractionRemaining : null;
  const isLive = liveFr != null && g.homeScore != null && g.awayScore != null;
  const hc = isLive ? g.homeScore : 0, ac = isLive ? g.awayScore : 0;       // current runs
  const lhEff = isLive ? lambdaH * liveFr : lambdaH;                        // remaining run expectancy
  const laEff = isLive ? lambdaA * liveFr : lambdaA;
  const projH = hc + lhEff, projA = ac + laEff;                            // projected FINAL runs
  const total = projH + projA;
  const totalPt = gl.totals && gl.totals.point != null ? gl.totals.point : null;
  const gp = jointGameProbs(lhEff, laEff, hc, ac, totalPt);
  const base = `model line: ${g.away} ${projA.toFixed(1)} – ${projH.toFixed(1)} ${g.home}${isLive ? ` · LIVE ${(liveFr * 100).toFixed(0)}% left, score ${ac}-${hc}` : ""}`;
  const mk = (name, type, line, side, odds, oppOdds, modelP0, proj, params) => {
    if (odds == null) return null;
    const imp = impliedProb(odds);
    const novig = oppOdds != null ? (imp / (imp + impliedProb(oppOdds))) : imp;
    const modelP = calibrateToMarket(modelP0, novig, type);
    const bm = odds > 0 ? odds / 100 : 100 / -odds;
    return {
      id: `${g.pk}-line-${type}-${side}`, gamePk: g.pk, game: `${g.away}@${g.home}`, name, type, line: String(line), side, odds, overOdds: null, underOdds: null, book,
      modelP, rawModelP: modelP0, proj, calc: { dist: isLive ? "Two-Poisson · live" : "Two-Poisson", params, proj, baseStr: base, mults: [], live: null },
      imp, novig, edge: modelP - novig, ev: evPerUnit(modelP, odds), b: bm, fair: probToAmerican(modelP), devigged: oppOdds != null,
    };
  };
  if (gl.h2h) {
    const e1 = mk(`${g.home} ML`, "Moneyline", "", "home", gl.h2h.home, gl.h2h.away, gp.home, projH, "P(home win)");
    const e2 = mk(`${g.away} ML`, "Moneyline", "", "away", gl.h2h.away, gl.h2h.home, gp.away, projA, "P(away win)");
    if (e1) entries.push(e1); if (e2) entries.push(e2);
  }
  if (totalPt != null) {
    const pt = totalPt;
    const e1 = mk(`Total ${pt}`, "Total", pt, "over", gl.totals.over, gl.totals.under, gp.over, total, `P(final total>${pt})`);
    const e2 = mk(`Total ${pt}`, "Total", pt, "under", gl.totals.under, gl.totals.over, gp.under, total, `P(final total<${pt})`);
    if (e1) entries.push(e1); if (e2) entries.push(e2);
  }
  if (gl.spreads && gl.spreads.homePoint != null) {
    const hp = gl.spreads.homePoint, ap = gl.spreads.awayPoint;
    // home covers hp if (home final - away final) > -hp ; away covers ap if margin < ap
    const pHome = marginProb(lhEff, laEff, hc, ac, (m) => m > -hp);
    const pAway = ap != null ? marginProb(lhEff, laEff, hc, ac, (m) => m < ap) : 1 - pHome;
    const e1 = mk(`${g.home} ${hp > 0 ? "+" : ""}${hp}`, "Run Line", hp, "home", gl.spreads.home, gl.spreads.away, pHome, projH - projA, `P(home margin > ${-hp})`);
    const e2 = mk(`${g.away} ${ap > 0 ? "+" : ""}${ap}`, "Run Line", ap, "away", gl.spreads.away, gl.spreads.home, pAway, projA - projH, `P(home margin < ${ap})`);
    if (e1) entries.push(e1); if (e2) entries.push(e2);
  }
  return entries;
}
// raw diagnostic: which books + market keys the API actually returned, and a HR sample
function oddsDebug(data, bookKey) {
  const bms = data.bookmakers || [];
  const bm = bms.find((b) => b.key === bookKey) || bms[0];
  const rawKeys = bm ? (bm.markets || []).map((m) => m.key) : [];
  const hrMk = bm && (bm.markets || []).find((m) => m.key === "batter_home_runs");
  const hrSample = hrMk && hrMk.outcomes && hrMk.outcomes[0] ? hrMk.outcomes[0] : null;
  return { books: bms.map((b) => b.key), usedBook: bm ? bm.key : null, rawKeys, hasHR: !!hrMk, hrSample };
}

/* ---------------------- persistence ---------------------- */
// Bump MODEL_VERSION whenever a structural change is made to the prediction engine.
// Every board log entry is tagged with this string so historical CSV exports remain
// stratifiable by model version for calibration analysis.
const MODEL_VERSION = "v4.2-2026-06-29";
const LS_BETS = "mlbef_mybets_v1";
function loadBets() { try { return JSON.parse(localStorage.getItem(LS_BETS)) || []; } catch { return []; } }
function saveBets(b) { try { localStorage.setItem(LS_BETS, JSON.stringify(b)); } catch { /* storage unavailable */ } }
const LS_CREDITS = "mlbef_credits_v1";
function loadCredits() { try { const v = localStorage.getItem(LS_CREDITS); return v == null || v === "" ? null : +v; } catch { return null; } }

/* ---- Board Snapshot Logger ----
 * Logs EVERY board candidate (not just tracked bets) on each board load.
 * This is the foundational data layer for calibration analysis, CLV measurement,
 * and training residual models. Without full-board logging we only have selection-
 * biased data from manually tracked bets, which is useless for model evaluation.
 *
 * Schema: one row per (player × prop type × line × side × date).
 * Settlement update: when settleBets() runs, actual results are written back.
 * Retention: last 60 days / 100k rows, enforced on every append.
 */
const LS_BOARD_LOG = "mlbef_boardlog_v1"; // legacy localStorage key (auto-migrated to IndexedDB)
const BOARD_LOG_MAX_ROWS = 100000;
const BOARD_LOG_RETENTION_DAYS = 60;

/* Board log storage: IndexedDB (localStorage's ~5MB quota silently dropped rows past ~10.5k).
   An in-memory cache keeps all readers synchronous; writes persist async to IndexedDB. */
const BOARD_DB_NAME = "mlbef_boardlog_db";
const BOARD_DB_STORE = "kv";
const BOARD_DB_KEY = "boardLog";

let boardLogCache = [];
let boardLogSaveError = null; // surfaced in UI — never silently drop data again

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BOARD_DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(BOARD_DB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(BOARD_DB_STORE, "readonly").objectStore(BOARD_DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}
async function idbSet(key, val) {
  const db = await idbOpen();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(BOARD_DB_STORE, "readwrite");
      tx.objectStore(BOARD_DB_STORE).put(val, key);
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    });
  } finally { db.close(); }
}
async function idbDel(key) {
  const db = await idbOpen();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(BOARD_DB_STORE, "readwrite");
      tx.objectStore(BOARD_DB_STORE).delete(key);
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

// One-time init: load from IndexedDB; if empty, migrate any legacy localStorage log.
const boardLogReady = (async () => {
  try {
    let rows = await idbGet(BOARD_DB_KEY);
    if (!Array.isArray(rows) || !rows.length) {
      try {
        const legacy = JSON.parse(localStorage.getItem(LS_BOARD_LOG) || "null");
        if (Array.isArray(legacy) && legacy.length) {
          rows = legacy;
          await idbSet(BOARD_DB_KEY, rows);
          localStorage.removeItem(LS_BOARD_LOG); // frees ~5MB of localStorage quota
        }
      } catch { /* corrupted legacy data — start fresh */ }
    }
    boardLogCache = Array.isArray(rows) ? rows : [];
  } catch (err) {
    boardLogSaveError = `Board log storage unavailable: ${String((err && err.message) || err)}`;
  }
  return boardLogCache;
})();

function loadBoardLog() {
  return boardLogCache;
}
function saveBoardLog(log) {
  boardLogCache = log;
  idbSet(BOARD_DB_KEY, log)
    .then(() => { boardLogSaveError = null; })
    .catch((err) => { boardLogSaveError = `Board log save FAILED: ${String((err && err.message) || err)}`; });
}
function getBoardLogSaveError() {
  return boardLogSaveError;
}
async function appendBoardLog(entries, modelVersion, date) {
  if (!entries || !entries.length) return;
  await boardLogReady; // never append before the persisted log has loaded
  const existing = loadBoardLog();
  const existingIds = new Set(existing.map((e) => e.logId));
  const now = new Date().toISOString();
  const cutoffMs = Date.now() - BOARD_LOG_RETENTION_DAYS * 86400000;

  const newRows = entries
    .filter((e) => e.modelP != null && e.novig != null)
    .map((e) => {
      const logId = `${date}|${e.id}`;
      return {
        logId,
        loggedAt: now,
        modelVersion,
        date,
        // market
        game: e.game,
        gamePk: String(e.gamePk),
        playerId: String(e.playerId ?? ""),
        name: e.name,
        type: e.type,
        line: e.line,
        side: e.side,
        odds: e.odds,
        novig: e.novig != null ? +e.novig.toFixed(4) : null,
        // model
        rawModelP: e.rawModelP != null ? +e.rawModelP.toFixed(4) : null,
        calibratedP: e.modelP != null ? +e.modelP.toFixed(4) : null,
        edge: e.edge != null ? +e.edge.toFixed(4) : null,
        ev: e.ev != null ? +e.ev.toFixed(4) : null,
        proj: e.proj != null ? +e.proj.toFixed(3) : null,
        // settlement (filled later)
        settled: false,
        actualStat: null,
        result: null,        // "won" | "lost" | "push" | "void"
        closingNovig: null,  // from refreshLines() when bet started
        clv: null,           // closingNovig - novig (positive = we beat the close)
      };
    })
    .filter((e) => !existingIds.has(e.logId));

  if (!newRows.length) return;

  // Merge, apply retention window, enforce row cap
  const merged = [...existing, ...newRows]
    .filter((e) => {
      try { return Date.parse(e.loggedAt) >= cutoffMs; } catch { return true; }
    });
  saveBoardLog(merged.length > BOARD_LOG_MAX_ROWS ? merged.slice(-BOARD_LOG_MAX_ROWS) : merged);
}
async function settleBoardLog(settledBets) {
  // Called after settleBets() resolves; writes actual results back into board log rows.
  if (!settledBets || !settledBets.length) return;
  await boardLogReady;
  const log = loadBoardLog();
  if (!log.length) return;
  // Build lookup: date|gamePk|playerId|type|line|side -> { actual, status }
  const lookup = {};
  for (const b of settledBets) {
    if (b.status === "open") continue;
    const key = `${b.date}|${b.gamePk}|${b.playerId}|${b.type}|${b.line}|${b.side}`;
    lookup[key] = { actual: b.actual, result: b.status };
  }
  let changed = false;
  const updated = log.map((e) => {
    if (e.settled) return e;
    const key = `${e.date}|${e.gamePk}|${e.playerId}|${e.type}|${e.line}|${e.side}`;
    const hit = lookup[key];
    if (!hit) return e;
    changed = true;
    return { ...e, settled: true, actualStat: hit.actual, result: hit.result };
  });
  if (changed) saveBoardLog(updated);
}

/* settling helpers */
function actualFor(type, ps) {
  if (!ps) return null;
  switch (type) {
    case "Hits": return ps.h; case "Total Bases": return ps.tb; case "Home Run": return ps.hr;
    case "H+R+RBI": return ps.h + ps.r + ps.rbi; case "Strikeouts": return ps.k; case "Outs": return ps.outs;
  }
  return null;
}
function gradeBet(side, point, actual) {
  if (actual == null) return null;
  if (actual === point) return "push";
  const over = actual > point;
  if (side === "over") return over ? "won" : "lost";
  return over ? "lost" : "won";
}
// grade a moneyline / total / run-line bet from the final score
function gradeLine(type, side, point, homeRuns, awayRuns) {
  if (homeRuns == null || awayRuns == null) return { status: null, actual: null };
  if (type === "Moneyline") {
    const homeWin = homeRuns > awayRuns;
    const win = side === "home" ? homeWin : !homeWin;
    return { status: win ? "won" : "lost", actual: `${awayRuns}-${homeRuns}` };
  }
  if (type === "Total") {
    const tot = homeRuns + awayRuns;
    if (tot === point) return { status: "push", actual: tot };
    const over = tot > point;
    return { status: (side === "over" ? over : !over) ? "won" : "lost", actual: tot };
  }
  if (type === "Run Line") {
    const margin = side === "home" ? (homeRuns - awayRuns) : (awayRuns - homeRuns);
    if (margin + point === 0) return { status: "push", actual: `${awayRuns}-${homeRuns}` };
    return { status: (margin + point) > 0 ? "won" : "lost", actual: `${awayRuns}-${homeRuns}` };
  }
  return { status: null, actual: null };
}
function profitUnits(status, odds, units = 1) {
  const u = units == null || isNaN(units) ? 1 : units;
  if (status === "won") return u * (odds > 0 ? odds / 100 : 100 / -odds);
  if (status === "lost") return -u;
  return 0;
}
function findPlayerInSlate(playerId, games) {
  const id = String(playerId);
  for (const g of games || []) {
    const awayHit = (g.awayLineup || []).find((p) => String(p.id) === id);
    if (awayHit) return { game: g, kind: "hitter", side: "away", lineupIndex: (g.awayLineup || []).findIndex((p) => String(p.id) === id), player: awayHit, oppSP: g.homeSP };
    const homeHit = (g.homeLineup || []).find((p) => String(p.id) === id);
    if (homeHit) return { game: g, kind: "hitter", side: "home", lineupIndex: (g.homeLineup || []).findIndex((p) => String(p.id) === id), player: homeHit, oppSP: g.awaySP };
    if (g.awaySP && String(g.awaySP.id) === id) return { game: g, kind: "pitcher", side: "away", player: g.awaySP, oppTeam: g.home };
    if (g.homeSP && String(g.homeSP.id) === id) return { game: g, kind: "pitcher", side: "home", player: g.homeSP, oppTeam: g.away };
  }
  return null;
}

/* ---------------------- status + small UI ---------------------- */
const STATUS = {
  POSTED: { t: "LINEUP POSTED", c: "bg-emerald-500 text-slate-950" },
  PARTIAL: { t: "PARTIAL", c: "bg-teal-600 text-white" },
  PENDING: { t: "PENDING · PROBABLES", c: "bg-amber-500 text-slate-950" },
  SCHEDULED: { t: "NO DATA YET", c: "bg-slate-700 text-slate-300" },
  LIVE: { t: "LIVE", c: "bg-rose-500 text-white" },
  FINAL: { t: "FINAL", c: "bg-slate-600 text-slate-200" },
  MANUAL: { t: "MANUAL", c: "bg-violet-500 text-white" },
};
function Chip({ s }) { const m = STATUS[s] || STATUS.SCHEDULED; return <span className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wide ${m.c}`}>{m.t}</span>; }
const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };
const STAT_ORDER = CATEGORY_ORDER;

function ScoreLine({ g }) {
  const a = g.awayScore, h = g.homeScore;
  if (g.status === "FINAL") {
    const extra = g.inning && g.inning > 9 ? `/F${g.inning}` : "";
    return <div className="text-[12px] truncate" style={mono}><span className={a > h ? "text-slate-100 font-bold" : "text-slate-400"}>{g.away} {a}</span><span className="text-slate-600">, </span><span className={h > a ? "text-slate-100 font-bold" : "text-slate-400"}>{g.home} {h}</span><span className="text-slate-500"> · Final{extra}</span></div>;
  }
  const st = (g.inningState || "").toLowerCase();
  const half = st.startsWith("mid") ? "Mid" : st.startsWith("end") ? "End" : (st.startsWith("top") ? "Top" : "Bot");
  return <div className="text-[12px] truncate" style={mono}><span className="text-slate-200">{g.away} {a}</span><span className="text-slate-600">, </span><span className="text-slate-200">{g.home} {h}</span><span className="text-rose-400"> · {half} {g.inning}{g.outs != null ? ` · ${g.outs} out` : ""}</span></div>;
}

/* ============================================================ */
export default function App() {
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const [date, setDate] = useState(todayStr());
  const season = date.slice(0, 4);
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [stamp, setStamp] = useState(null);
  const [tab, setTab] = useState("slate");
  const [open, setOpen] = useState(null);
  const [detail, setDetail] = useState({});
  const [book, setBook] = useState("draftkings");
  const [board, setBoard] = useState({});            // pk -> entries[]
  const [oddsLoading, setOddsLoading] = useState(null);
  const [credits, setCredits] = useState(loadCredits());
  const [oddsFetches, setOddsFetches] = useState(0);
  const [boardLogCount, setBoardLogCount] = useState(() => loadBoardLog().length);
  const [boardLogSettling, setBoardLogSettling] = useState(false);
  const [boardLogSettleMsg, setBoardLogSettleMsg] = useState("");
  const [boardSort, setBoardSort] = useState("ev_desc");
  const [minEdge, setMinEdge] = useState("");
  const [minModel, setMinModel] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const [boardSearch, setBoardSearch] = useState("");
  const [showMoreBoard, setShowMoreBoard] = useState(false);
  const [showProjBar, setShowProjBar] = useState(true);
  const [gameFilter, setGameFilter] = useState("all");
  const [sideFilter, setSideFilter] = useState("all");
  const [minOdds, setMinOdds] = useState("");
  const [maxOdds, setMaxOdds] = useState("");
  const [minDelta, setMinDelta] = useState("");
  const [maxDelta, setMaxDelta] = useState("");
  const [dirAligned, setDirAligned] = useState(false); // only show plays where proj direction matches bet side
  const [signalFilter, setSignalFilter] = useState("all"); // all | moderate | strong — delta gate signal tier
  const [coverage, setCoverage] = useState({});   // pk -> { game, book, returned[], matched[] }
  const [classFilter, setClassFilter] = useState("all");   // all | props | lines
  const [analysisQuery, setAnalysisQuery] = useState("");
  const [analysisSearching, setAnalysisSearching] = useState(false);
  const [analysisResults, setAnalysisResults] = useState([]);
  const [analysisProfile, setAnalysisProfile] = useState(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisErr, setAnalysisErr] = useState("");
  const [betStatusFilter, setBetStatusFilter] = useState("all"); // all|open|won|lost
  const [betSort, setBetSort] = useState("recent");        // recent|ev_desc|ev_asc|edge_desc|edge_asc
  const [betDateFilter, setBetDateFilter] = useState("all"); // all | a specific YYYY-MM-DD
  const [betGameFilters, setBetGameFilters] = useState<string[]>([]);   // [] = all; multi-select games
  const [betTypeFilters, setBetTypeFilters] = useState<string[]>([]);   // [] = all; multi-select categories
  const [betBookFilters, setBetBookFilters] = useState<string[]>([]);   // [] = all; multi-select sportsbooks
  const [betSideFilter, setBetSideFilter] = useState("all");  // all | over | under | home | away
  const [betSearch, setBetSearch] = useState("");
  const [showMoreBets, setShowMoreBets] = useState(false);
  const [betMinModel, setBetMinModel] = useState("");        // min model % on My Bets
  const [betMinEdge, setBetMinEdge] = useState("");          // min edge % on My Bets
  const [betMaxEdge, setBetMaxEdge] = useState("");          // max edge % on My Bets
  const [betMinOdds, setBetMinOdds] = useState("");
  const [betMaxOdds, setBetMaxOdds] = useState("");
  const [betMinDelta, setBetMinDelta] = useState("");        // min proj delta (proj - line)
  const [betMaxDelta, setBetMaxDelta] = useState("");        // max proj delta
  const [betDirAligned, setBetDirAligned] = useState(false);// only show bets where proj direction matched side
  const [stakeMode, setStakeMode] = useState("flat");      // flat | kelly (default for NEW tracked bets)
  const [statsStartDate, setStatsStartDate] = useState("");  // YYYY-MM-DD, inclusive
  const [statsEndDate, setStatsEndDate] = useState("");      // YYYY-MM-DD, inclusive
  const [myBets, setMyBets] = useState(loadBets());
  const [draft, setDraft] = useState(null);
  const [showManual, setShowManual] = useState(false);
  const [settleMsg, setSettleMsg] = useState("");
  const [lineMsg, setLineMsg] = useState("");
  const [refreshingLines, setRefreshingLines] = useState(false);
  const eventsRef = useRef({ date: null, events: null });
  const inflight = useRef(new Set());

  useEffect(() => { saveBets(myBets); }, [myBets]);
  // When myBets changes and any bets have settled, write results back into the board log
  // so ALL board candidates (not just tracked bets) get graded via settleBoardLog.
  useEffect(() => { void settleBoardLog(myBets); }, [myBets]);
  // Clear game multi-select when date changes — previously selected games may belong to a different date.
  useEffect(() => { setBetGameFilters([]); }, [betDateFilter]);
  // Board log persists in IndexedDB and loads async — sync the count once ready.
  useEffect(() => { boardLogReady.then((rows) => setBoardLogCount(rows.length)); }, []);
  useEffect(() => { if (credits != null) { try { localStorage.setItem(LS_CREDITS, String(credits)); } catch { /* ignore */ } } }, [credits]);
  async function refreshCredits() { try { const ev = await fetchOddsEvents(); if (ev.remaining != null) setCredits(ev.remaining); } catch { /* ignore */ } }
  useEffect(() => { refreshCredits(); /* free /events call, no quota cost; eslint-disable-next-line */ }, []);

  async function loadSchedule(d) {
    setLoading(true); setErr(""); setOpen(null); setDetail({}); setBoard({}); setCoverage({});
    eventsRef.current = { date: null, events: null };
    try {
      const gs = await fetchSchedule(d); setGames(gs); setStamp(new Date());
      if (!gs.length) setErr("No games on this date.");
    } catch (e) { setErr(`Schedule fetch blocked (${e.message}).`); setGames([]); }
    finally { setLoading(false); }
  }
  useEffect(() => { loadSchedule(date); /* eslint-disable-next-line */ }, [date]);

  async function loadDetail(g) {
    if (detail[g.pk] && detail[g.pk].ready) return detail[g.pk];
    if (inflight.current.has(g.pk)) return null;
    inflight.current.add(g.pk);
    setDetail((p) => ({ ...p, [g.pk]: { loading: true } }));
    const scLB = await fetchHitterStatcastLeaderboards(season).catch(() => ({ batter: {}, ok: false }));   // ➕ ADD THIS LINE
    const park = PARKS[g.homeId] || { rf: 1, elev: 0, lat: null, lon: null, dome: false };
    const hitters = {};
    const allH = [
      ...g.awayLineup.map((x, i) => ({ ...x, side: "away", idx: i, oppSP: g.homeSP })),
      ...g.homeLineup.map((x, i) => ({ ...x, side: "home", idx: i, oppSP: g.awaySP })),
    ];
    const tasks = [];
    for (const h of allH) {
      const r = { name: h.name, side: h.side, idx: h.idx, oppName: h.oppSP ? h.oppSP.name : null, season: null, l15: null, bvp: null, splits: null, bats: null, oppThrows: null, statcastLive: null, statcastSeason: null };
      hitters[h.id] = r;
      tasks.push(fetchHitterSeason(h.id, season).then((s) => { r.season = s; }).catch(() => {}));
      tasks.push(fetchHitterLog(h.id, season).then((l) => { r.l15 = l; }).catch(() => {}));
      tasks.push(fetchHitterSplits(h.id, season).then((sp) => { r.splits = sp; }).catch(() => {}));
      tasks.push(resolveHitterSeasonStatcast(scLB, h.id, season, date).then((sc) => { r.statcastSeason = sc; }).catch(() => {}));
      if (h.oppSP) tasks.push(fetchBvP(h.id, h.oppSP.id, season).then((bp) => { r.bvp = bp; }).catch(() => {}));
    }
    let hands = {};
    const handIds = [...allH.map((h) => h.id), ...(g.homeSP ? [g.homeSP.id] : []), ...(g.awaySP ? [g.awaySP.id] : [])];
    if (handIds.length) tasks.push(fetchHands(handIds).then((hh) => { hands = hh; }).catch(() => {}));
    const spStats = {};
    // fetchPitcherLog (last-5-starts IP avg) added alongside season + Statcast to fix outs under-projection.
    // expIp is recomputed here with the recent log so calculateBaseProjection always sees an up-to-date value.
    if (g.homeSP) tasks.push(Promise.all([fetchPitcherSeason(g.homeSP.id, season), fetchPlayerSeasonStatcast(g.homeSP.id, "pitcher", season, date), fetchPitcherLog(g.homeSP.id, season)]).then(([s, sc, log]) => { if (s) { s.statcastSeason = attachPitcherHr9FromStatsApi(sc, s); if (log) { s.recentLog = log; s.expIp = expectedStartIP(s.ip, s.gs, s.gp, log); } spStats[g.homeSP.id] = s; } }).catch(() => {}));
    if (g.awaySP) tasks.push(Promise.all([fetchPitcherSeason(g.awaySP.id, season), fetchPlayerSeasonStatcast(g.awaySP.id, "pitcher", season, date), fetchPitcherLog(g.awaySP.id, season)]).then(([s, sc, log]) => { if (s) { s.statcastSeason = attachPitcherHr9FromStatsApi(sc, s); if (log) { s.recentLog = log; s.expIp = expectedStartIP(s.ip, s.gs, s.gp, log); } spStats[g.awaySP.id] = s; } }).catch(() => {}));
    let teamH = { rpg: LG_RPG, rapg: LG_RPG, kRate: LG_KRATE }, teamA = { rpg: LG_RPG, rapg: LG_RPG, kRate: LG_KRATE }, wx = null, liveBox = null, statcast = emptyStatcast();
    tasks.push(fetchTeamRPG(g.homeId, season).then((r) => { teamH = r; }).catch(() => {}));
    tasks.push(fetchTeamRPG(g.awayId, season).then((r) => { teamA = r; }).catch(() => {}));
    if (park.lat) tasks.push(fetchWeather(park.lat, park.lon).then((w) => { wx = w; }).catch(() => {}));
    if (g.status === "LIVE") tasks.push(fetchLiveBox(g.pk).then((b) => { liveBox = b; }).catch(() => {}));
    if (g.status === "LIVE" || g.status === "FINAL") tasks.push(fetchGameStatcast(g.pk).then((sc) => { statcast = sc; }).catch((e) => { statcast = emptyStatcast(`blocked:${e.message || "gf"}`); }));
    await Promise.allSettled(tasks);
    for (const h of allH) { const r = hitters[h.id]; if (r) { r.bats = hands[h.id] ? hands[h.id].bats : null; r.oppThrows = (h.oppSP && hands[h.oppSP.id]) ? hands[h.oppSP.id].throws : null; r.statcastLive = statcast && statcast.byBatter ? statcast.byBatter[String(h.id)] : null; } }
    // Game-line run expectancy now reuses the SAME opposing-pitching layer as the props:
    // the specific starter's FIP/K%/BB% + Statcast contact quality, innings-weighted with the
    // bullpen (team RA/G) proxy via STARTER_SHARE. Replaces the old flat team-RA/G defense factor,
    // so game lines and player props move together off one consistent pitching read.
    const offH = clamp((teamH.rpg || LG_RPG) / LG_RPG, 0.7, 1.4);   // home offense strength
    const offA = clamp((teamA.rpg || LG_RPG) / LG_RPG, 0.7, 1.4);   // away offense strength
    const oppPitchForHome = calculateOppPitchingAdjustment({ kind: "hitter", oppSP: g.awaySP ? spStats[g.awaySP.id] : null, oppRAPG: teamA.rapg });
    const oppPitchForAway = calculateOppPitchingAdjustment({ kind: "hitter", oppSP: g.homeSP ? spStats[g.homeSP.id] : null, oppRAPG: teamH.rapg });
    const lambdaH = +clamp(LG_RPG * offH * oppPitchForHome * park.rf, 2.0, 8.5).toFixed(2);
    const lambdaA = +clamp(LG_RPG * offA * oppPitchForAway * park.rf, 2.0, 8.5).toFixed(2);
    const statcastCoverage = statcastCoverageSummary(hitters, spStats, statcast);
    const live = g.status === "LIVE" ? { fractionRemaining: gameFractionRemaining(g.inning, g.inningState, g.outs), totalsById: liveBox || {} } : null;
    const obj = { ready: true, loading: false, hitters, spStats, weather: wx, park, statcast, statcastCoverage, lambdaH, lambdaA, kRateHome: teamH.kRate, kRateAway: teamA.kRate, rapgHome: teamH.rapg, rapgAway: teamA.rapg, live };
    setDetail((p) => ({ ...p, [g.pk]: obj }));
    inflight.current.delete(g.pk);
    return obj;
  }
  async function expand(g) {
    if (open === g.pk) { setOpen(null); return; }
    setOpen(g.pk);
    if (!g.manual) await loadDetail(g);
  }
  /* model game line is read-only (computed from team run env × park) */

  /* ---- context builders ---- */
  function liveSnap(d, pid) { if (!d.live) return null; return { fractionRemaining: d.live.fractionRemaining, totals: (d.live.totalsById && d.live.totalsById[pid]) || {} }; }
  function hitterCtx(d, h, pid) {
    return { kind: "hitter", season: h.season, l15: h.l15, bvp: h.bvp, splits: h.splits, bats: h.bats, oppThrows: h.oppThrows, lineupIndex: h.idx, park: d.park, weather: d.weather, statcastLive: h.statcastLive || null, statcastSeason: h.statcastSeason || null, teamLambda: h.side === "home" ? d.lambdaH : d.lambdaA, oppRAPG: h.side === "home" ? d.rapgAway : d.rapgHome, oppSP: (h.oppSP && d.spStats[h.oppSP.id]) || null, live: liveSnap(d, pid) };
  }
  function pitcherCtx(d, sp, isHome) { const ps = d.spStats[sp.id]; return { kind: "pitcher", season: ps, statcastSeason: ps && ps.statcastSeason, park: d.park, weather: d.weather, teamLambda: isHome ? d.lambdaH : d.lambdaA, oppKRate: isHome ? d.kRateAway : d.kRateHome, live: liveSnap(d, sp.id) }; }

  async function runAnalysisSearch() {
    const q = analysisQuery.trim();
    if (!q) return;
    setAnalysisSearching(true); setAnalysisErr("");
    try {
      const res = await searchPlayers(q, season);
      setAnalysisResults(res);
      if (!res.length) setAnalysisErr(`No MLB players matched "${q}".`);
    } catch (e) {
      setAnalysisResults([]);
      setAnalysisErr(`Player search failed (${String((e && e.message) || e)}).`);
    } finally { setAnalysisSearching(false); }
  }
  async function selectAnalysisPlayer(player) {
    setAnalysisLoading(true); setAnalysisErr(""); setAnalysisProfile(null);
    try {
      const profile = await fetchPlayerAnalysisProfile(player, season, date);
      setAnalysisProfile(profile);
      const spot = findPlayerInSlate(profile.player.id, games);
      if (spot && !spot.game.manual) await loadDetail(spot.game);
    } catch (e) {
      setAnalysisErr(`Could not load player profile (${String((e && e.message) || e)}).`);
    } finally { setAnalysisLoading(false); }
  }

  function goToAnalysis(player) {
    setAnalysisQuery(player.name || "");
    setAnalysisResults([]);
    setTab("analysis");
    selectAnalysisPlayer(player);
  }

  /* ---- odds fetch for one game -> board entries ---- */
  async function getOdds(g) {
    if (oddsFetches >= ODDS_TESTING_LIMIT) { setErr(`Per-session fetch cap (${ODDS_TESTING_LIMIT}) reached — reload to reset, or raise ODDS_TESTING_LIMIT.`); return; }
    setOddsLoading(g.pk); setErr("");
    try {
      const d = await loadDetail(g);
      if (!d) { setOddsLoading(null); return; }
      if (!eventsRef.current.events || eventsRef.current.date !== date) {
        const ev = await fetchOddsEvents(); eventsRef.current = { date, events: ev.events }; if (ev.remaining != null) setCredits(ev.remaining);
      }
      const ev = matchEvent(eventsRef.current.events, g);
      if (!ev) { setErr(`No odds event matched ${g.away}@${g.home}.`); setOddsLoading(null); return; }
      const res = await fetchEventOdds(ev.id, book); if (res.remaining != null) setCredits(res.remaining);
      setOddsFetches((n) => n + 1);
      const dbg = oddsDebug(res.data, book);
      const rows = parseEventOdds(res.data, book);
      // name -> {ctx} for hitters and pitchers in this game
      const hitterByName = {};
      for (const pid in d.hitters) { const h = d.hitters[pid]; if (h && h.name) hitterByName[normName(h.name)] = { ctx: hitterCtx(d, h, pid), name: h.name, id: pid }; }
      const pitcherByName = {};
      if (g.awaySP && d.spStats[g.awaySP.id]) pitcherByName[normName(g.awaySP.name)] = { ctx: pitcherCtx(d, g.awaySP, false), name: g.awaySP.name, id: g.awaySP.id };
      if (g.homeSP && d.spStats[g.homeSP.id]) pitcherByName[normName(g.homeSP.name)] = { ctx: pitcherCtx(d, g.homeSP, true), name: g.homeSP.name, id: g.homeSP.id };
      const entries = [];
      for (const row of rows) {
        const isPitcher = row.type === "Strikeouts" || row.type === "Outs";
        const found = (isPitcher ? pitcherByName : hitterByName)[normName(row.player)];
        if (!found) continue; // player not in our loaded data (bench, name mismatch)
        const pre = projectProp(found.ctx, row.type, parseFloat(row.point)); // one sim per prop
        for (const side of ["over", "under"]) {
          const odds = side === "over" ? row.over : row.under;
          if (odds == null) continue;
          const bet = { gamePk: g.pk, game: `${g.away}@${g.home}`, playerId: found.id, name: found.name, type: row.type, line: String(row.point), side, odds, overOdds: row.over, underOdds: row.under, ctx: found.ctx, book };
          const ev2 = evalBet(bet, pre);
          entries.push({ id: `${g.pk}-${found.id}-${row.type}-${row.point}-${side}`, ...bet, ...ev2 });
        }
      }
      const gl = parseGameOdds(res.data, book, g);          // moneyline / run line / total
      const lineEntries = buildGameLineEntries(g, d, gl, book);
      entries.push(...lineEntries);
      const returned = [...new Set(rows.map((r) => r.type)), ...lineEntries.map((e) => e.type)];
      const matched = [...new Set(entries.map((e) => e.type))];
      setCoverage((c) => ({ ...c, [g.pk]: { game: `${g.away}@${g.home}`, book, returned, matched, rawKeys: dbg.rawKeys, hasHR: dbg.hasHR, hrSample: dbg.hrSample, books: dbg.books, usedBook: dbg.usedBook, statcast: d.statcastCoverage || (d.statcast && d.statcast.verification) } }));
      setBoard((b) => ({ ...b, [g.pk]: entries }));
      if (!entries.length) setErr(`Got odds for ${g.away}@${g.home} but matched no players (try closer to lineup lock, or another book).`);
    } catch (e) {
      setErr(`Odds fetch failed (${e.message}). Check the key/credits or CORS.`);
    } finally { setOddsLoading(null); }
  }

  /* ---- board (flattened, filtered, grouped, sorted) ---- */
  const boardEntries = useMemo(() => Object.values(board).flat(), [board]);
  const analysisSpot = useMemo(() => analysisProfile ? findPlayerInSlate(analysisProfile.player.id, games) : null, [analysisProfile, games]);
  const analysisDetail = analysisSpot ? detail[analysisSpot.game.pk] : null;
  const analysisCtx = useMemo(() => {
    if (!analysisProfile || !analysisSpot || !analysisDetail || !analysisDetail.ready) return null;
    const pid = String(analysisProfile.player.id);
    if (analysisSpot.kind === "hitter") {
      const rec = analysisDetail.hitters && analysisDetail.hitters[pid];
      return rec ? hitterCtx(analysisDetail, rec, pid) : null;
    }
    const g = analysisSpot.game;
    const isHome = analysisSpot.side === "home";
    const sp = isHome ? g.homeSP : g.awaySP;
    if (!sp || !analysisDetail.spStats || !analysisDetail.spStats[sp.id]) return null;
    return pitcherCtx(analysisDetail, sp, isHome);
  }, [analysisProfile, analysisSpot, analysisDetail]);
  const analysisProjections = useMemo(() => {
    if (!analysisCtx) return [];
    const props = analysisCtx.kind === "pitcher" ? PITCHER_PROPS : HITTER_PROPS;
    return props.map((type) => {
      const line = DEFAULT_LINE[type] || "0.5";
      const pr = projectProp(analysisCtx, type, parseFloat(line));
      return { type, line, ...pr, overP: pr.pOver, underP: 1 - pr.pOver, overFair: probToAmerican(pr.pOver), underFair: probToAmerican(1 - pr.pOver) };
    });
  }, [analysisCtx]);
  const analysisBoardEntries = useMemo(() => {
    if (!analysisProfile) return [];
    const pid = String(analysisProfile.player.id);
    return boardEntries.filter((e) => String(e.playerId) === pid);
  }, [analysisProfile, boardEntries]);
  const analysisBoardGameCount = analysisSpot ? ((board[analysisSpot.game.pk] || []).length) : 0;

  // Board Snapshot Logger: fires whenever the board updates (new game loaded or refreshed).
  // Logs ALL candidates — not just ones above the edge threshold — so we have unbiased
  // data for calibration analysis, CLV measurement, and residual model training.
  useEffect(() => {
    if (boardEntries.length > 0) {
      appendBoardLog(boardEntries, MODEL_VERSION, date).then(() => {
        setBoardLogCount(loadBoardLog().length);
        const err = getBoardLogSaveError();
        if (err) setBoardLogSettleMsg(err);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardEntries]);

  const boardGames = useMemo(() => {
    const seen = {}; const out = [];
    for (const e of boardEntries) if (!seen[e.gamePk]) { seen[e.gamePk] = 1; out.push({ pk: String(e.gamePk), label: e.game }); }
    return out;
  }, [boardEntries]);
  const amToB = (o) => (o > 0 ? o / 100 : 100 / -o);
  const grouped = useMemo(() => {
    const minE = parseFloat(minEdge);
    const minM = parseFloat(minModel);
    const minB = minOdds === "" || isNaN(Number(minOdds)) ? null : amToB(Number(minOdds));
    const maxB = maxOdds === "" || isNaN(Number(maxOdds)) ? null : amToB(Number(maxOdds));
    const minD = parseFloat(minDelta);
    const maxD = parseFloat(maxDelta);
    const getDelta = (e) => (e.proj ?? 0) - parseFloat(e.line ?? 0);
    const f = boardEntries.filter((e) => {
      if (e.modelP == null) return false;
      if (e.modelP >= 0.999 || e.modelP <= 0.001) return false; // already-decided live prop / blowout line: price is stale + unbettable, edge is fake
      if (!isNaN(minE) && !(e.edge != null && e.edge * 100 >= minE)) return false;
      if (!isNaN(minM) && !(e.modelP * 100 >= minM)) return false;
      if (catFilter !== "all" && e.type !== catFilter) return false;
      if (gameFilter !== "all" && String(e.gamePk) !== gameFilter) return false;
      if (sideFilter !== "all" && e.side !== sideFilter) return false;
      if (classFilter === "props" && isLineType(e.type)) return false;
      if (classFilter === "lines" && !isLineType(e.type)) return false;
      if (minB != null || maxB != null) { const b = amToB(Number(e.odds)); if (minB != null && b < minB) return false; if (maxB != null && b > maxB) return false; }
      if (!isNaN(minD) && getDelta(e) < minD) return false;
      if (!isNaN(maxD) && getDelta(e) > maxD) return false;
      if (dirAligned) { const d = getDelta(e); if (e.side === "over" && d <= 0) return false; if (e.side === "under" && d >= 0) return false; }
      if (signalFilter !== "all") { const sig = getDeltaSignal(e.type, e.proj, e.line); if (signalFilter === "strong" && sig !== "strong") return false; if (signalFilter === "moderate" && sig == null) return false; }
      if (!matchesQuery(e, boardSearch)) return false;
      return true;
    });
    const cmp = {
      ev_desc: (a, b) => (b.ev ?? -9) - (a.ev ?? -9), ev_asc: (a, b) => (a.ev ?? 9) - (b.ev ?? 9),
      edge_desc: (a, b) => (b.edge ?? -9) - (a.edge ?? -9), edge_asc: (a, b) => (a.edge ?? 9) - (b.edge ?? 9),
      proj_desc: (a, b) => (b.proj ?? -9) - (a.proj ?? -9), proj_asc: (a, b) => (a.proj ?? 9e9) - (b.proj ?? 9e9),
      delta_desc: (a, b) => getDelta(b) - getDelta(a), delta_asc: (a, b) => getDelta(a) - getDelta(b),
    }[boardSort];
    const out = {};
    for (const t of STAT_ORDER) { const arr = f.filter((e) => e.type === t).sort(cmp); if (arr.length) out[t] = arr; }
    return out;
  }, [boardEntries, boardSort, minEdge, minModel, catFilter, classFilter, gameFilter, sideFilter, minOdds, maxOdds, minDelta, maxDelta, dirAligned, signalFilter, boardSearch]);
  const filtersActive = classFilter !== "all" || catFilter !== "all" || gameFilter !== "all" || sideFilter !== "all" || minEdge !== "" || minModel !== "" || minOdds !== "" || maxOdds !== "" || minDelta !== "" || maxDelta !== "" || dirAligned || signalFilter !== "all" || boardSearch !== "";
  function clearFilters() { setClassFilter("all"); setCatFilter("all"); setGameFilter("all"); setSideFilter("all"); setMinEdge(""); setMinModel(""); setMinOdds(""); setMaxOdds(""); setMinDelta(""); setMaxDelta(""); setDirAligned(false); setSignalFilter("all"); setBoardSearch(""); }

  /* ---- my bets ---- */
  function trackBet(e) {
    const exists = myBets.some((b) => b.key === e.id);
    if (exists) return;
    const sug = suggestedUnits(e.modelP, Number(e.odds));
    const units = stakeMode === "kelly" ? (sug > 0 ? sug : 1) : 1;
    const gtrk = games.find((x) => x.pk === e.gamePk);
    const liveBet = !!((e.calc && e.calc.live) || (gtrk && gtrk.status === "LIVE")); // was the game in progress when placed?
    const rec = { key: e.id, date, gamePk: e.gamePk, game: e.game, playerId: e.playerId, name: e.name, type: e.type, line: e.line, side: e.side, odds: e.odds, book: e.book, modelP: e.modelP, proj: e.proj, novig: e.novig, units, suggested: sug, status: "open", actual: null, live: liveBet };
    setMyBets((p) => [rec, ...p]);
  }
  function updateBetOdds(key, odds) { setMyBets((p) => p.map((b) => b.key === key ? { ...b, odds: odds === "" ? "" : Number(odds) } : b)); }
  function updateBetUnits(key, units) { setMyBets((p) => p.map((b) => b.key === key ? { ...b, units: units === "" ? "" : Math.max(0, Number(units)) } : b)); }
  function removeBet(key) { setMyBets((p) => p.filter((b) => b.key !== key)); }
  function resetStats() {
    if (typeof window !== "undefined" && !window.confirm("Clear ALL tracked bets (open + settled)? This cannot be undone. Export a CSV first if you want a copy.")) return;
    setMyBets([]); setSettleMsg("");
  }
  function addManualBet() {
    if (!draft || draft.odds === "") return;
    const key = `m-${Date.now()}`;
    let modelP = null, proj = null;
    if (draft.ctx) { const pr = projectProp(draft.ctx, draft.type, parseFloat(draft.line)); modelP = draft.side === "over" ? pr.pOver : 1 - pr.pOver; proj = pr.proj; }
    const sug = suggestedUnits(modelP, Number(draft.odds));
    const units = stakeMode === "kelly" ? (sug > 0 ? sug : 1) : 1;
    const rec = { key, date, gamePk: draft.pk, game: draft.game, playerId: draft.playerId, name: draft.name, type: draft.type, line: draft.line, side: draft.side, odds: Number(draft.odds), book: "manual", modelP, proj, novig: null, units, suggested: sug, status: "open", actual: null };
    setMyBets((p) => [rec, ...p]); setDraft(null);
  }

  async function settleBets() {
    const openByGame = {};
    for (const b of myBets) if (b.status === "open") (openByGame[b.gamePk] = openByGame[b.gamePk] || []).push(b);
    const pks = Object.keys(openByGame);
    if (!pks.length) { setSettleMsg("No open bets to settle."); return; }
    setSettleMsg("Settling…");
    const results = {};
    for (const pk of pks) { results[pk] = await fetchGameResult(pk); }
    let graded = 0;
    setMyBets((prev) => prev.map((b) => {
      if (b.status !== "open") return b;
      const res = results[b.gamePk]; if (!res || !res.final) return b;
      if (isLineType(b.type)) {
        const { status, actual } = gradeLine(b.type, b.side, parseFloat(b.line), res.homeRuns, res.awayRuns);
        if (!status) return b; graded++; return { ...b, status, actual };
      }
      const ps = res.players[b.playerId];
      const isPitcherProp = b.type === "Strikeouts" || b.type === "Outs";
      const participated = ps && (isPitcherProp ? ps.pitched : ps.batted);
      if (!participated) { graded++; return { ...b, status: "void", actual: "DNP" }; } // scratched / didn't play -> no action
      const actual = actualFor(b.type, ps);
      const st = gradeBet(b.side, parseFloat(b.line), actual);
      if (st == null) return b;
      graded++; return { ...b, status: st, actual };
    }));
    setSettleMsg(`Settled ${graded} bet(s). Unsettled games are still in progress.`);
  }

  // ── Full Board Log Settlement ──────────────────────────────────────────────
  // Grades EVERY board log candidate for every finished game — not just tracked bets.
  // Uses the MLB Stats API (free, no Odds API credits consumed).
  // This is what transforms the board log from "model output archive" into a genuine
  // calibration dataset: every prop the model evaluated gets an actual outcome attached.
  async function settleFullBoardLog() {
    await boardLogReady;
    const log = loadBoardLog();
    const unsettled = log.filter((e) => !e.settled);
    if (!unsettled.length) { setBoardLogSettleMsg("Board log is fully settled — nothing to do."); return; }

    // Unique gamePks across unsettled entries
    const pks = [...new Set(unsettled.map((e) => e.gamePk))];
    setBoardLogSettling(true);
    setBoardLogSettleMsg(`Fetching results for ${pks.length} game(s)…`);

    try {
      // Fetch game results — MLB Stats API, completely free
      const results = {};
      for (const pk of pks) {
        results[pk] = await fetchGameResult(Number(pk));
      }

      let graded = 0;
      const updated = log.map((e) => {
        if (e.settled) return e;
        const res = results[e.gamePk];
        if (!res || !res.final) return e; // game still in progress — leave unsettled

        // Game line props (Moneyline, Total, Run Line)
        if (isLineType(e.type)) {
          const { status, actual } = gradeLine(e.type, e.side, parseFloat(e.line || "0"), res.homeRuns, res.awayRuns);
          if (!status) return e;
          graded++;
          return { ...e, settled: true, actualStat: actual, result: status };
        }

        // Player props — look up by playerId (stored as string; MLB API uses numbers)
        const ps = res.players[e.playerId] || res.players[Number(e.playerId)];
        const isPitcher = e.type === "Strikeouts" || e.type === "Outs";
        const participated = ps && (isPitcher ? ps.pitched : ps.batted);

        if (!participated) {
          // Player didn't appear (scratch, DNP) — void
          graded++;
          return { ...e, settled: true, actualStat: null, result: "void" };
        }

        const actual = actualFor(e.type, ps);
        const status = gradeBet(e.side, parseFloat(String(e.line)), actual);
        if (status == null) return e;
        graded++;
        return { ...e, settled: true, actualStat: actual, result: status };
      });

      saveBoardLog(updated);
      const totalSettled = updated.filter((e) => e.settled).length;
      setBoardLogCount(updated.length);
      setBoardLogSettleMsg(
        `Graded ${graded} board log entr${graded === 1 ? "y" : "ies"} across ${pks.length} game(s). ` +
        `${totalSettled.toLocaleString()} / ${updated.length.toLocaleString()} total entries now settled.`
      );
    } catch (err) {
      setBoardLogSettleMsg(`Settlement failed: ${String((err && (err as Error).message) || err)}`);
    } finally {
      setBoardLogSettling(false);
    }
  }

  // pull the current market price for each open tracked bet (line movement / CLV). ~9 credits per game with open bets.
  async function refreshLines() {
    const open = myBets.filter((b) => b.status === "open" && b.book && b.book !== "manual");
    if (!open.length) { setLineMsg("No open tracked bets with a book to refresh (manual bets have no book to pull)."); return; }
    const byGame = {};
    for (const b of open) { (byGame[b.gamePk] = byGame[b.gamePk] || []).push(b); }
    setRefreshingLines(true); setLineMsg("Refreshing lines…");
    try {
      let events = eventsRef.current && eventsRef.current.events;
      if (!events) { const ev = await fetchOddsEvents(); events = ev.events || []; eventsRef.current = { date, events }; if (ev.remaining != null) setCredits(ev.remaining); }
      const updates = {}; let matched = 0, missed = 0, games_ = 0, frozen = 0;
      const at = new Date().toISOString();
      for (const pkStr in byGame) {
        const bets = byGame[pkStr]; const pk = Number(pkStr);
        const g = games.find((x) => x.pk === pk);
        const ev = g ? matchEvent(events, g) : null;
        if (!ev) { for (const b of bets) { updates[b.key] = { oddsCheckedAt: at, currentOdds: null, lineMissing: true }; missed++; } continue; }
        // has first pitch passed? prefer the book's commence_time; fall back to slate status
        const started = ev.commence_time ? (Date.parse(ev.commence_time) <= Date.now()) : (g && (g.status === "LIVE" || g.status === "FINAL"));
        // pregame bets freeze at the closing line once the game starts (live re-prices aren't comparable). live bets keep updating.
        for (const b of bets) { if (!b.live && started && b.currentOdds != null && !b.closing) { updates[b.key] = { closing: true, oddsCheckedAt: at }; frozen++; } }
        const toPull = bets.filter((b) => b.live || !started);
        if (!toPull.length) continue; // nothing to fetch for this game (all pregame bets are frozen) -> saves credits
        // ONE fetch per game covering every book we track on it. Up to 10 books = 1 region cost, so this halves credits vs per-book calls.
        const books = [...new Set(toPull.map((b) => b.book))];
        const res = await fetchEventOdds(ev.id, books.join(",")); games_++;
        if (res.remaining != null) setCredits(res.remaining);
        const parsed = {};
        for (const bk of books) parsed[bk] = { rows: parseEventOdds(res.data, bk), gl: parseGameOdds(res.data, bk, g) };
        for (const b of toPull) {
          const p = parsed[b.book];
          const cur = p ? matchCurrentOdds(b, p.rows, p.gl) : null;
          if (cur != null) { updates[b.key] = { currentOdds: cur, oddsCheckedAt: at, lineMissing: false, closing: false }; matched++; }
          else { updates[b.key] = { oddsCheckedAt: at, currentOdds: null, lineMissing: true }; missed++; }
        }
      }
      setMyBets((prev) => prev.map((b) => updates[b.key] ? { ...b, ...updates[b.key] } : b));
      setLineMsg(`Updated ${matched} line(s) across ${games_} game(s)${frozen ? ` · ${frozen} frozen at close (game started)` : ""}${missed ? ` · ${missed} not found (scratched, settled, or line moved off your number)` : ""}.`);
    } catch (e) { setLineMsg(`Line refresh failed: ${String((e && e.message) || e)}`); }
    setRefreshingLines(false);
  }

  /* draft from a board entry's player (manual line/odds) */
  function draftFromGame(g, kind, pid, name) {
    const d = detail[g.pk]; let ctx = null;
    if (d && d.ready) {
      if (kind === "hitter" && d.hitters[pid]) ctx = hitterCtx(d, d.hitters[pid], pid);
      else if (kind === "pitcher") { const isHome = g.homeSP && g.homeSP.id === pid; const sp = isHome ? g.homeSP : g.awaySP; if (sp && d.spStats[sp.id]) ctx = pitcherCtx(d, sp, isHome); }
    }
    setDraft({ pk: g.pk, game: `${g.away}@${g.home}`, playerId: pid, name, kind, type: kind === "pitcher" ? "Strikeouts" : "Hits", line: kind === "pitcher" ? "5.5" : "0.5", side: "over", odds: "", ctxKind: kind, ctx });
  }

  /* manual game add (failsafe) */
  const [mg, setMg] = useState({ away: "", home: "", time: "" });
  function addManualGame() {
    if (!mg.away || !mg.home) return;
    setGames((p) => [...p, { pk: "m" + Date.now(), manual: true, status: "MANUAL", home: mg.home.toUpperCase(), away: mg.away.toUpperCase(), homeName: "", awayName: "", time: mg.time || "TBD", venue: "Manual", homeSP: null, awaySP: null, homeLineup: [], awayLineup: [], homeId: null, awayId: null }]);
    setMg({ away: "", home: "", time: "" });
  }

  /* live recompute of My Bets EV (odds editable) */
  const myBetsView = useMemo(() => {
    let arr = myBets.map((b, i) => {
      const odds = Number(b.odds);
      const modelP = b.modelP, imp = isNaN(odds) ? null : impliedProb(odds);
      const fairRef = b.novig != null ? b.novig : imp;
      const edge = (modelP != null && fairRef != null) ? modelP - fairRef : null;
      const ev = (modelP != null && !isNaN(odds)) ? evPerUnit(modelP, odds) : null;
      const units = b.units != null ? b.units : 1;        // back-compat for older bets
      const suggested = b.suggested != null ? b.suggested : suggestedUnits(modelP, odds);
      // CLV: positive = market moved toward your side since you bet (your side's price shortened) = you beat the line
      const clv = (b.currentOdds != null && !isNaN(odds)) ? impliedProb(b.currentOdds) - impliedProb(odds) : null;
      return { ...b, imp, edge, ev, units, suggested, clv, _i: i };
    });
    if (betStatusFilter === "settled") arr = arr.filter((b) => b.status !== "open");
    else if (betStatusFilter !== "all") arr = arr.filter((b) => b.status === betStatusFilter);
    if (betDateFilter !== "all") arr = arr.filter((b) => b.date === betDateFilter);
    if (betGameFilters.length) arr = arr.filter((b) => betGameFilters.includes(b.game));
    if (betTypeFilters.length) arr = arr.filter((b) => betTypeFilters.includes(b.type));
    if (betBookFilters.length) arr = arr.filter((b) => betBookFilters.includes(b.book));
    if (betSideFilter !== "all") arr = arr.filter((b) => b.side === betSideFilter);
    if (betSearch.trim()) arr = arr.filter((b) => matchesQuery(b, betSearch));
    const bmM = parseFloat(betMinModel);
    if (!isNaN(bmM)) arr = arr.filter((b) => b.modelP != null && b.modelP * 100 >= bmM);
    const bmE = parseFloat(betMinEdge);
    if (!isNaN(bmE)) arr = arr.filter((b) => b.edge != null && b.edge * 100 >= bmE);
    const bxE = parseFloat(betMaxEdge);
    if (!isNaN(bxE)) arr = arr.filter((b) => b.edge != null && b.edge * 100 <= bxE);
    const minOB = betMinOdds === "" || isNaN(Number(betMinOdds)) ? null : amToB(Number(betMinOdds));
    const maxOB = betMaxOdds === "" || isNaN(Number(betMaxOdds)) ? null : amToB(Number(betMaxOdds));
    if (minOB != null || maxOB != null) arr = arr.filter((b) => { const bb = amToB(Number(b.odds)); if (isNaN(bb)) return false; if (minOB != null && bb < minOB) return false; if (maxOB != null && bb > maxOB) return false; return true; });
    const getBetDelta = (b) => (b.proj ?? 0) - parseFloat(b.line ?? 0);
    const bmD = parseFloat(betMinDelta);
    const bxD = parseFloat(betMaxDelta);
    if (!isNaN(bmD)) arr = arr.filter((b) => getBetDelta(b) >= bmD);
    if (!isNaN(bxD)) arr = arr.filter((b) => getBetDelta(b) <= bxD);
    if (betDirAligned) arr = arr.filter((b) => { const d = getBetDelta(b); return b.side === "over" ? d > 0 : d < 0; });
    const cmp = {
      recent: (a, b) => a._i - b._i,
      game: (a, b) => String(a.game || "").localeCompare(String(b.game || "")) || a._i - b._i,
      model_desc: (a, b) => (b.modelP ?? -9) - (a.modelP ?? -9), model_asc: (a, b) => (a.modelP ?? 9) - (b.modelP ?? 9),
      ev_desc: (a, b) => (b.ev ?? -9) - (a.ev ?? -9), ev_asc: (a, b) => (a.ev ?? 9) - (b.ev ?? 9),
      edge_desc: (a, b) => (b.edge ?? -9) - (a.edge ?? -9), edge_asc: (a, b) => (a.edge ?? 9) - (b.edge ?? 9),
      clv_desc: (a, b) => (b.clv ?? -9) - (a.clv ?? -9), clv_asc: (a, b) => (a.clv ?? 9) - (b.clv ?? 9),
      delta_desc: (a, b) => getBetDelta(b) - getBetDelta(a), delta_asc: (a, b) => getBetDelta(a) - getBetDelta(b),
    }[betSort] || ((a, b) => a._i - b._i);
    return arr.sort(cmp);
  }, [myBets, betStatusFilter, betSort, betDateFilter, betGameFilters, betTypeFilters, betBookFilters, betSideFilter, betMinModel, betMinEdge, betMaxEdge, betMinOdds, betMaxOdds, betMinDelta, betMaxDelta, betDirAligned, betSearch]);
  const betDates = useMemo(() => [...new Set(myBets.map((b) => b.date).filter(Boolean))].sort().reverse(), [myBets]);
  // Scope game list to the selected date so TEX@LAA from 8/9 doesn't appear when filtering to 8/11.
  const betGames = useMemo(() => {
    const base = betDateFilter !== "all" ? myBets.filter((b) => b.date === betDateFilter) : myBets;
    return [...new Set(base.map((b) => b.game).filter(Boolean))].sort();
  }, [myBets, betDateFilter]);
  const betTypes = useMemo(() => [...new Set(myBets.map((b) => b.type).filter(Boolean))].sort(), [myBets]);
  const betBooks = useMemo(() => [...new Set(myBets.map((b) => b.book).filter(Boolean))].sort(), [myBets]);
  const betSides = useMemo(() => [...new Set(myBets.map((b) => b.side).filter(Boolean))].sort(), [myBets]);
  const trackedByGame = useMemo(() => { const m = {}; for (const b of myBets) if (b.status === "open") m[b.gamePk] = (m[b.gamePk] || 0) + 1; return m; }, [myBets]);
  const betFiltersActive = betStatusFilter !== "all" || betGameFilters.length > 0 || betTypeFilters.length > 0 || betBookFilters.length > 0 || betSideFilter !== "all" || betDateFilter !== "all" || betMinModel !== "" || betMinEdge !== "" || betMaxEdge !== "" || betMinOdds !== "" || betMaxOdds !== "" || betMinDelta !== "" || betMaxDelta !== "" || betDirAligned || betSearch !== "";
  function clearBetFilters() { setBetStatusFilter("all"); setBetGameFilters([]); setBetTypeFilters([]); setBetBookFilters([]); setBetSideFilter("all"); setBetDateFilter("all"); setBetMinModel(""); setBetMinEdge(""); setBetMaxEdge(""); setBetMinOdds(""); setBetMaxOdds(""); setBetMinDelta(""); setBetMaxDelta(""); setBetDirAligned(false); setBetSearch(""); }

  const statsDates = useMemo(() => [...new Set(myBets.map((b) => b.date).filter(Boolean))].sort(), [myBets]);
  const stats = useMemo(() => {
    let settled = myBets.filter((b) => b.status === "won" || b.status === "lost" || b.status === "push" || b.status === "void");
    if (statsStartDate) settled = settled.filter((b) => b.date && b.date >= statsStartDate);
    if (statsEndDate) settled = settled.filter((b) => b.date && b.date <= statsEndDate);
    const unitsOf = (b) => (b.units != null && !isNaN(b.units) ? Number(b.units) : 1);
    const agg = (arr) => {
      const w = arr.filter((b) => b.status === "won").length, l = arr.filter((b) => b.status === "lost").length, ps = arr.filter((b) => b.status === "push").length, v = arr.filter((b) => b.status === "void").length;
      // stake-weighted (uses each bet's units). push + void are no-action: 0 profit, not staked.
      const net = arr.reduce((s, b) => s + profitUnits(b.status, Number(b.odds), unitsOf(b)), 0);
      const staked = arr.filter((b) => b.status !== "push" && b.status !== "void").reduce((s, b) => s + unitsOf(b), 0);
      // flat 1u baseline (for comparison)
      const flatNet = arr.reduce((s, b) => s + profitUnits(b.status, Number(b.odds), 1), 0);
      const flatRisked = w + l;
      return {
        n: arr.length, w, l, ps, v, winPct: flatRisked ? w / flatRisked : null,
        net, staked, roi: staked ? net / staked : null,
        flatNet, flatRoi: flatRisked ? flatNet / flatRisked : null,
      };
    };
    const byType = {}; for (const t of STAT_ORDER) { const a = settled.filter((b) => b.type === t); if (a.length) byType[t] = agg(a); }
    return { overall: agg(settled), byType, openCount: myBets.filter((b) => b.status === "open").length };
  }, [myBets, statsStartDate, statsEndDate]);

  /* ---------- CSV export (bets + stats summary) ---------- */
  function exportCSV() {
    const esc = (v) => { if (v == null) return ""; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const pctOr = (x) => (x == null ? "" : (x * 100).toFixed(1));
    const o = stats.overall;
    const lines = [];
    lines.push("SUMMARY");
    lines.push(["metric", "value"].join(","));
    lines.push(["settled", o.n].join(","));
    lines.push(["record", `${o.w}-${o.l}${o.ps ? `-${o.ps}` : ""}`].join(","));
    lines.push(["win_pct", o.winPct != null ? (o.winPct * 100).toFixed(1) + "%" : ""].join(","));
    lines.push(["net_units_staked", o.net.toFixed(2)].join(","));
    lines.push(["roi_staked_pct", o.roi != null ? (o.roi * 100).toFixed(1) + "%" : ""].join(","));
    lines.push(["net_units_flat1u", o.flatNet.toFixed(2)].join(","));
    lines.push(["roi_flat1u_pct", o.flatRoi != null ? (o.flatRoi * 100).toFixed(1) + "%" : ""].join(","));
    lines.push(["open", stats.openCount].join(","));
    lines.push("");
    lines.push("BY TYPE");
    lines.push(["type", "won", "lost", "push", "win_pct", "net_staked", "net_flat1u"].join(","));
    for (const t of STAT_ORDER) { const s = stats.byType[t]; if (!s) continue; lines.push([esc(t), s.w, s.l, s.ps, s.winPct != null ? (s.winPct * 100).toFixed(1) : "", s.net.toFixed(2), s.flatNet.toFixed(2)].join(",")); }
    lines.push("");
    lines.push("BETS");
    lines.push(["date", "game", "name", "type", "line", "side", "odds", "book", "model_pct", "proj", "novig_pct", "edge_pct", "ev_pct", "units", "suggested", "status", "actual", "profit_units", "current_odds", "clv_pts"].join(","));
    // export EVERY tracked bet (open + settled), independent of the My Bets view filters
    const allBets = [...myBets].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    for (const b of allBets) {
      const odds = Number(b.odds);
      const imp = isNaN(odds) ? null : impliedProb(odds);
      const fairRef = b.novig != null ? b.novig : imp;
      const edge = (b.modelP != null && fairRef != null) ? b.modelP - fairRef : null;
      const ev = (b.modelP != null && !isNaN(odds)) ? evPerUnit(b.modelP, odds) : null;
      const units = b.units != null ? b.units : 1;
      const profit = (b.status === "won" || b.status === "lost") ? profitUnits(b.status, odds, units).toFixed(2) : "";
      const clv = (b.currentOdds != null && !isNaN(odds)) ? ((impliedProb(b.currentOdds) - impliedProb(odds)) * 100).toFixed(1) : "";
      lines.push([
        esc(b.date), esc(b.game), esc(b.name), esc(b.type), esc(b.line), esc(b.side), esc(b.odds), esc(b.book),
        b.modelP != null ? (b.modelP * 100).toFixed(1) : "", b.proj != null ? Number(b.proj).toFixed(2) : "",
        b.novig != null ? (b.novig * 100).toFixed(1) : "", pctOr(edge), pctOr(ev),
        units, b.suggested != null ? b.suggested : "", esc(b.status), esc(b.actual), profit,
        b.currentOdds != null ? b.currentOdds : "", clv,
      ].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url; a.download = `mlb-edge-finder-${stamp}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  // Board log CSV export — every candidate ever shown on the board (not just tracked bets).
  // This is the primary calibration dataset: modelVersion, rawModelP, calibratedP, novig, edge,
  // proj, settled flag, actualStat, result, and CLV (once closing line capture is wired).
  function exportBoardLogCSV() {
    const log = loadBoardLog();
    if (!log.length) { alert("No board log entries yet. Load a game to start logging."); return; }
    const esc = (v) => { if (v == null) return ""; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const headers = ["logId","loggedAt","modelVersion","date","game","gamePk","playerId","name","type","line","side","odds","novig","rawModelP","calibratedP","edge","ev","proj","settled","actualStat","result","closingNovig","clv"];
    const rows = [headers.join(",")];
    for (const e of log) {
      rows.push([
        esc(e.logId), esc(e.loggedAt), esc(e.modelVersion), esc(e.date),
        esc(e.game), esc(e.gamePk), esc(e.playerId), esc(e.name),
        esc(e.type), esc(e.line), esc(e.side), esc(e.odds),
        e.novig ?? "", e.rawModelP ?? "", e.calibratedP ?? "",
        e.edge ?? "", e.ev ?? "", e.proj ?? "",
        e.settled ? "true" : "false",
        e.actualStat ?? "", esc(e.result), e.closingNovig ?? "", e.clv ?? "",
      ].join(","));
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url; a.download = `mlb-board-log-${stamp}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function clearBoardLog() {
    if (!window.confirm(`Clear ALL board log entries? This cannot be undone. Export a CSV first.`)) return;
    boardLogCache = [];
    void idbDel(BOARD_DB_KEY);
    try { localStorage.removeItem(LS_BOARD_LOG); } catch { /* ignore */ }
    setBoardLogCount(0);
  }

  // lossless backup of the bet log so it survives a host/browser change (localStorage does not)
  function backupBets() {
    const data = JSON.stringify({ app: "mlb-edge-finder", v: 1, exported: new Date().toISOString(), bets: myBets }, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `mlb-edge-finder-bets-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function restoreBets(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const incoming = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.bets) ? parsed.bets : null);
        if (!incoming) { setSettleMsg("Restore failed: not a valid bet backup file."); return; }
        const have = new Set(myBets.map((b) => b.key));
        const toAdd = incoming.filter((b) => b && b.key != null && !have.has(b.key));
        setMyBets((cur) => { const k = new Set(cur.map((b) => b.key)); return [...cur, ...toAdd.filter((b) => !k.has(b.key))]; });
        setSettleMsg(`Restored ${toAdd.length} bet(s) from backup (${incoming.length} in file; duplicates skipped).`);
      } catch { setSettleMsg("Restore failed: could not parse the JSON file."); }
    };
    reader.readAsText(file);
  }

  /* ============================ UI ============================ */
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <div className="max-w-5xl mx-auto px-4 pb-28">
        <header className="pt-6 pb-3 sticky top-0 bg-slate-950 z-20 border-b border-slate-800">
          <div className="flex items-end justify-between flex-wrap gap-3">
            <div>
              <h1 className="text-2xl font-black tracking-tight">MLB <span className="text-emerald-400">EDGE</span> FINDER</h1>
              <p className="text-[11px] text-slate-500 mt-0.5" style={mono}>live odds · de-vigged edge · Monte-Carlo props</p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <select value={book} onChange={(e) => setBook(e.target.value)} className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm">
                {BOOKS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
              </select>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-sm" />
              <button onClick={() => loadSchedule(date)} className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm rounded-lg px-3 py-1.5">{loading ? "…" : "Refresh"}</button>
            </div>
          </div>
          <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
            <div className="flex gap-1 flex-wrap">
              {[["slate", "Slate"], ["board", `Board${boardEntries.length ? ` (${boardEntries.length})` : ""}`], ["analysis", "Player Analysis"], ["mybets", `My Bets${myBets.length ? ` (${myBets.length})` : ""}`], ["stats", "Stats"]].map(([k, l]) => (
                <button key={k} onClick={() => setTab(k)} className={`px-3.5 py-1.5 rounded-lg text-sm font-semibold ${tab === k ? "bg-slate-800 text-emerald-400" : "text-slate-400 hover:text-slate-200"}`}>{l}</button>
              ))}
            </div>
            <div className="flex items-center gap-3 text-[10px] text-slate-500" style={mono}>
              <span>odds credits: <b className={credits != null && credits < 1000 ? "text-amber-400" : "text-slate-300"}>{credits != null ? credits.toLocaleString() : "—"}</b><span className="text-slate-600"> / mo</span></span>
              {stamp && <span>pulled {stamp.toLocaleTimeString()}</span>}
            </div>
          </div>
        </header>

        {err && <div className="mt-3 text-sm text-amber-300 bg-amber-950/40 border border-amber-800/50 rounded-lg px-3 py-2">{err}</div>}

        {/* ---------------- SLATE ---------------- */}
        {tab === "slate" && (
          <div className="mt-3 space-y-2">
            {games.map((g) => {
              const d = detail[g.pk]; const isOpen = open === g.pk; const hasOdds = (board[g.pk] || []).length;
              return (
                <div key={g.pk} className="bg-slate-900/70 border border-slate-800 rounded-xl overflow-hidden">
                  <div className="w-full flex items-center gap-3 px-4 py-3">
                    <button onClick={() => expand(g)} className="flex-1 flex items-center gap-3 text-left min-w-0">
                      <div className="text-[11px] text-slate-500 w-16 shrink-0" style={mono}>{g.time}</div>
                      <div className="flex-1 min-w-0">
                        <div className="font-bold truncate">{g.away} <span className="text-slate-600">@</span> {g.home}</div>
                        {(g.status === "LIVE" || g.status === "FINAL") && g.homeScore != null
                          ? <ScoreLine g={g} />
                          : <div className="text-[11px] text-slate-500 truncate">{(g.awaySP && g.awaySP.name) || "TBD"} vs {(g.homeSP && g.homeSP.name) || "TBD"}</div>}
                      </div>
                      <Chip s={g.status} />
                    </button>
                    {trackedByGame[g.pk] ? <span title={`${trackedByGame[g.pk]} open tracked bet(s) on this game`} className="shrink-0 text-[10px] font-bold text-emerald-300 bg-emerald-900/40 border border-emerald-800 rounded-full px-1.5 py-0.5" style={mono}>● {trackedByGame[g.pk]}</span> : null}
                    {!g.manual && g.status !== "FINAL" && (
                      <button onClick={() => getOdds(g)} disabled={oddsLoading === g.pk}
                        className={`text-[11px] font-bold rounded px-2 py-1 ${hasOdds ? "bg-slate-700 text-slate-200" : "bg-sky-600 hover:bg-sky-500 text-white"}`}>
                        {oddsLoading === g.pk ? "…" : hasOdds ? "↻ odds" : "get odds"}
                      </button>
                    )}
                    <button onClick={() => expand(g)} className={`text-slate-600 transition ${isOpen ? "rotate-90" : ""}`}>▸</button>
                  </div>

                  {isOpen && (
                    <div className="px-4 pb-4 border-t border-slate-800">
                      {d && d.loading && <div className="py-6 text-center text-sm text-slate-500" style={mono}>loading stats…</div>}
                      {g.manual && <div className="py-3 text-xs text-slate-400">Manual game — model context unavailable; track bets by hand from My Bets.</div>}
                      {d && d.ready && (
                        <>
                          <div className="flex flex-wrap gap-2 mt-3 text-[11px]" style={mono}>
                            <Env label="PARK RF" v={d.park.rf.toFixed(2)} hot={d.park.rf >= 1.05} cold={d.park.rf <= 0.96} />
                            <Env label="ELEV" v={`${d.park.elev}ft`} hot={d.park.elev >= 3000} />
                            {d.park.dome && <Env label="DOME" v="yes" />}
                            {d.weather && !d.park.dome && <Env label="TEMP" v={`${d.weather.temp}°`} hot={d.weather.temp >= 85} cold={d.weather.temp <= 60} />}
                            {d.weather && !d.park.dome && <Env label="WIND" v={`${d.weather.wind}mph`} hot={d.weather.wind >= 12} />}
                            {d.weather && !d.park.dome && <Env label="RAIN" v={`${d.weather.pop}%`} hot={d.weather.pop >= 50} />}
                          </div>
                          <div className="mt-3 bg-slate-950/60 border border-slate-800 rounded-lg p-3">
                            <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">MODEL GAME LINE</div>
                            {(() => { const gp = gameProbs(d.lambdaH, d.lambdaA); return (
                              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[13px]" style={mono}>
                                <span className="text-slate-300">proj score <b className="text-sky-300">{g.away} {d.lambdaA.toFixed(1)} – {d.lambdaH.toFixed(1)} {g.home}</b></span>
                                <span>{g.home} <b className="text-emerald-400">{pct(gp.home)}</b> <span className="text-slate-600">({probToAmerican(gp.home)})</span></span>
                                <span>{g.away} <b className="text-emerald-400">{pct(gp.away)}</b> <span className="text-slate-600">({probToAmerican(gp.away)})</span></span>
                                <span>total <b className="text-sky-300">{gp.totalLambda.toFixed(1)}</b></span>
                              </div>); })()}
                            <div className="text-[10px] text-slate-600 mt-1.5">model line from team run env × park (read-only) — compare to market for game edges once moneyline odds are wired in.</div>
                          </div>
                          <div className="grid sm:grid-cols-2 gap-3 mt-3">
                            <LineupCol title={`${g.away} (away)`} g={g} lineup={g.awayLineup} d={d} onAdd={(pid) => draftFromGame(g, "hitter", pid, d.hitters[pid] && d.hitters[pid].name)} onPlayerClick={goToAnalysis} />
                            <LineupCol title={`${g.home} (home)`} g={g} lineup={g.homeLineup} d={d} onAdd={(pid) => draftFromGame(g, "hitter", pid, d.hitters[pid] && d.hitters[pid].name)} onPlayerClick={goToAnalysis} />
                          </div>
                          <div className="grid sm:grid-cols-2 gap-3 mt-3">
                            <SPCard label={`${g.away} SP`} sp={g.awaySP} st={g.awaySP && d.spStats[g.awaySP.id]} onAdd={() => g.awaySP && draftFromGame(g, "pitcher", g.awaySP.id, g.awaySP.name)} onPlayerClick={g.awaySP ? () => goToAnalysis(g.awaySP) : null} />
                            <SPCard label={`${g.home} SP`} sp={g.homeSP} st={g.homeSP && d.spStats[g.homeSP.id]} onAdd={() => g.homeSP && draftFromGame(g, "pitcher", g.homeSP.id, g.homeSP.name)} onPlayerClick={g.homeSP ? () => goToAnalysis(g.homeSP) : null} />
                          </div>
                          {hasOdds ? <div className="mt-3 text-[11px] text-emerald-400/80">{hasOdds} priced props on the Board ({book}).</div>
                            : (g.status !== "FINAL" && <div className="mt-3 text-[11px] text-slate-500">Tap “get odds” to pull {book} props for this game into the Board.</div>)}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <div className="mt-4">
              <button onClick={() => setShowManual((s) => !s)} className="text-xs text-slate-400 hover:text-slate-200">{showManual ? "− hide" : "+ add a game manually"}</button>
              {showManual && (
                <div className="mt-2 flex flex-wrap gap-2 items-end bg-slate-900/60 border border-slate-800 rounded-lg p-3">
                  {[["away", "Away"], ["home", "Home"], ["time", "Time"]].map(([k, ph]) => (
                    <input key={k} placeholder={ph} value={mg[k]} onChange={(e) => setMg((p) => ({ ...p, [k]: e.target.value }))} className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-24" />
                  ))}
                  <button onClick={addManualGame} className="bg-violet-500 hover:bg-violet-400 text-white font-bold text-sm rounded px-3 py-1.5">Add</button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ---------------- BOARD ---------------- */}
        {tab === "board" && (
          <div className="mt-3">
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <input value={boardSearch} onChange={(e) => setBoardSearch(e.target.value)} placeholder="search player or team" className="bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-sm w-44 text-slate-100" />
              <Sel compact label="sort" v={boardSort} opts={["ev_desc", "ev_asc", "edge_desc", "edge_asc", "proj_desc", "proj_asc", "delta_desc", "delta_asc"]} labels={{ ev_desc: "EV ↓", ev_asc: "EV ↑", edge_desc: "Edge ↓", edge_asc: "Edge ↑", proj_desc: "Projection ↓", proj_asc: "Projection ↑", delta_desc: "Proj Δ ↓", delta_asc: "Proj Δ ↑" }} onChange={setBoardSort} />
              <Sel compact label="market" v={classFilter} opts={["all", "props", "lines"]} labels={{ all: "All markets", props: "Player props", lines: "Game lines" }} onChange={setClassFilter} />
              <Sel compact label="category" v={catFilter} opts={["all", ...CATEGORY_ORDER]} labels={{ all: "All categories" }} onChange={setCatFilter} />
              <Sel compact label="game" v={gameFilter} opts={["all", ...boardGames.map((x) => x.pk)]} labels={{ all: "All games", ...Object.fromEntries(boardGames.map((x) => [x.pk, x.label])) }} onChange={setGameFilter} />
              <Sel compact label="side" v={sideFilter} opts={["all", "over", "under"]} labels={{ all: "Both", over: "Over", under: "Under" }} onChange={setSideFilter} />
              {(() => { const n = [minEdge, minModel, minOdds, maxOdds, minDelta, maxDelta].filter((x) => x !== "").length + (dirAligned ? 1 : 0) + (signalFilter !== "all" ? 1 : 0); return (
                <button onClick={() => setShowMoreBoard((s) => !s)} className={`text-xs rounded px-2.5 py-1.5 border ${showMoreBoard || n ? "border-emerald-700 text-emerald-300" : "border-slate-700 text-slate-400 hover:text-slate-200"}`}>filters{n ? ` (${n})` : ""} {showMoreBoard ? "▴" : "▾"}</button>
              ); })()}
              <button onClick={() => setShowProjBar((s) => !s)} className={`text-xs rounded px-2.5 py-1.5 border ${showProjBar ? "border-sky-700 text-sky-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`} title="Toggle projection bar">proj bar {showProjBar ? "▪" : "▫"}</button>
              {filtersActive && <button onClick={clearFilters} className="text-[11px] text-slate-400 hover:text-rose-300 border border-slate-700 rounded px-2.5 py-1.5">clear</button>}
              <div className="ml-auto text-[11px] text-slate-500" style={mono}>{Object.values(grouped).reduce((n, a) => n + a.length, 0)} plays</div>
            </div>
            {showMoreBoard && (
              <div className="flex items-end gap-3 flex-wrap mb-3 p-2.5 rounded-lg bg-slate-900/40 border border-slate-800">
                <label className="text-xs text-slate-400 flex flex-col gap-1">min edge %
                  <input value={minEdge} onChange={(e) => setMinEdge(e.target.value)} placeholder="any" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">min model %
                  <input value={minModel} onChange={(e) => setMinModel(e.target.value)} placeholder="65" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">min proj Δ
                  <input value={minDelta} onChange={(e) => setMinDelta(e.target.value)} placeholder="e.g. 0.5" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">max proj Δ
                  <input value={maxDelta} onChange={(e) => setMaxDelta(e.target.value)} placeholder="e.g. 2.0" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">min odds
                  <input value={minOdds} onChange={(e) => setMinOdds(e.target.value)} placeholder="-300" inputMode="numeric" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">max odds
                  <input value={maxOdds} onChange={(e) => setMaxOdds(e.target.value)} placeholder="+300" inputMode="numeric" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">proj aligned
                  <button onClick={() => setDirAligned((s) => !s)} className={`text-xs rounded px-3 py-1.5 border font-medium ${dirAligned ? "border-sky-600 bg-sky-950 text-sky-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`} title="Only show plays where proj direction agrees with the bet side (proj > line for overs, proj < line for unders)">{dirAligned ? "on" : "off"}</button>
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">signal
                  <div className="flex gap-1">
                    {(["all", "moderate", "strong"] as const).map((v) => (
                      <button key={v} onClick={() => setSignalFilter(v)} className={`text-xs rounded px-2 py-1.5 border font-medium ${signalFilter === v ? (v === "strong" ? "border-emerald-600 bg-emerald-950 text-emerald-300" : v === "moderate" ? "border-yellow-600 bg-yellow-950 text-yellow-300" : "border-sky-600 bg-sky-950 text-sky-300") : "border-slate-700 text-slate-500 hover:text-slate-300"}`}>{v === "all" ? "all" : v === "moderate" ? "🟡 mod+" : "🟢 strong"}</button>
                    ))}
                  </div>
                </label>
              </div>
            )}
            {Object.keys(coverage).length > 0 && (
              <div className="mb-3 text-[10px] text-slate-500 space-y-1.5" style={mono}>
                {Object.values(coverage).map((c, i) => (
                  <div key={i} className="border border-slate-800 rounded-lg px-2.5 py-1.5">
                    <div>{c.game} · {c.usedBook || c.book}: <span className="text-slate-400">{c.matched.length ? c.matched.join(", ") : "no players matched"}</span></div>
                    <div className="text-slate-600">raw markets returned: {c.rawKeys && c.rawKeys.length ? c.rawKeys.join(", ") : "none"}</div>
                    <div>{c.hasHR
                      ? <span className="text-emerald-500">batter_home_runs IS present{c.hrSample ? ` · sample → name:"${c.hrSample.name}" desc:"${c.hrSample.description}" point:${c.hrSample.point}` : ""}</span>
                      : <span className="text-amber-500">batter_home_runs NOT returned by {c.usedBook || c.book} (book/feed didn't carry it for this game)</span>}</div>
                    {c.statcast && <div className={c.statcast.verdict === "statcast_confirmed" ? "text-emerald-500" : "text-slate-600"}>statcast: {c.statcast.verdict} · EV balls {c.statcast.battedBallsWithExitVelo || 0} · xBA balls {c.statcast.battedBallsWithXBA || 0}</div>}
                    {c.statcast && c.statcast.sources && <div className="text-slate-600">source: {c.statcast.sources}</div>}
                    {c.books && c.books.length > 1 && <div className="text-slate-600">books in response: {c.books.join(", ")}</div>}
                  </div>
                ))}
              </div>
            )}
            {boardEntries.length === 0 ? (
              <div className="text-sm text-slate-500 py-10 text-center">No odds pulled yet. On the Slate tab, tap <span className="text-sky-400">get odds</span> on a game to load {book} props here, ranked by EV/edge.</div>
            ) : Object.keys(grouped).length === 0 ? (
              <div className="text-sm text-slate-500 py-10 text-center">No props pass the current filter.</div>
            ) : (
              STAT_ORDER.filter((t) => grouped[t]).map((t) => (
                <div key={t} className="mb-5">
                  <div className="text-[11px] font-bold tracking-wide text-slate-400 mb-1.5 uppercase">{t} <span className="text-slate-600">· {grouped[t].length}</span></div>
                  <div className="space-y-2">
                    {grouped[t].map((e) => <BoardRow key={e.id} e={e} tracked={myBets.some((b) => b.key === e.id)} onTrack={() => trackBet(e)} showProjBar={showProjBar} />)}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* ---------------- PLAYER ANALYSIS ---------------- */}
        {tab === "analysis" && (
          <div className="mt-3 space-y-3">
            <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3">
              <div className="flex items-end gap-2 flex-wrap">
                <label className="text-xs text-slate-400 flex flex-col gap-1 flex-1 min-w-[220px]">player search
                  <input
                    value={analysisQuery}
                    onChange={(e) => setAnalysisQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") runAnalysisSearch(); }}
                    placeholder="Mike Trout"
                    className="bg-slate-950 border border-slate-700 rounded px-2.5 py-2 text-sm text-slate-100"
                  />
                </label>
                <button onClick={runAnalysisSearch} disabled={analysisSearching || !analysisQuery.trim()} className="bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-bold text-sm rounded-lg px-3 py-2">
                  {analysisSearching ? "…" : "Search"}
                </button>
                {(analysisProfile || analysisResults.length > 0 || analysisQuery) && (
                  <button onClick={() => { setAnalysisQuery(""); setAnalysisResults([]); setAnalysisProfile(null); setAnalysisErr(""); }} className="text-sm text-slate-400 hover:text-rose-300 border border-slate-700 rounded-lg px-3 py-2">
                    clear
                  </button>
                )}
              </div>
              <div className="text-[11px] text-slate-500 mt-2" style={mono}>
                MLB-wide profile lookup. If the player is on the selected slate, this tab adds matchup context, model projections, and any pulled {book} odds.
              </div>
            </div>

            {analysisErr && <div className="text-sm text-amber-300 bg-amber-950/40 border border-amber-800/50 rounded-lg px-3 py-2">{analysisErr}</div>}

            {analysisResults.length > 0 && (
              <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-2">
                <div className="text-[10px] text-slate-500 font-bold tracking-wide px-1 mb-1">SEARCH RESULTS</div>
                <div className="grid sm:grid-cols-2 gap-2">
                  {analysisResults.map((p) => {
                    const selected = analysisProfile && String(analysisProfile.player.id) === String(p.id);
                    return (
                      <button key={p.id} onClick={() => selectAnalysisPlayer(p)} className={`text-left border rounded-lg px-3 py-2 ${selected ? "border-emerald-700 bg-emerald-950/30" : "border-slate-800 bg-slate-950/50 hover:border-slate-700"}`}>
                        <div className="text-sm font-bold text-slate-100">{p.name}</div>
                        <div className="text-[11px] text-slate-500" style={mono}>{p.teamAbbr || p.team || "FA"} · {p.position || "—"} · bats {p.bats || "—"} / throws {p.throws || "—"}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {!analysisProfile && !analysisLoading && analysisResults.length === 0 && (
              <PlayerAnalysisIntro games={games} boardCount={boardEntries.length} />
            )}

            {analysisLoading && <div className="py-10 text-center text-sm text-slate-500" style={mono}>loading player profile…</div>}

            {analysisProfile && !analysisLoading && (
              <PlayerProfilePanel
                profile={analysisProfile}
                spot={analysisSpot}
                detail={analysisDetail}
                projections={analysisProjections}
                boardEntries={analysisBoardEntries}
                boardGameCount={analysisBoardGameCount}
                book={book}
                oddsLoading={oddsLoading}
                oddsReady={!!(analysisSpot && (board[analysisSpot.game.pk] || []).length > 0 && coverage[analysisSpot.game.pk]?.book === book)}
                onFetchOdds={() => { if (analysisSpot) getOdds(analysisSpot.game); }}
                myBets={myBets}
                onTrack={trackBet}
                showProjBar={showProjBar}
              />
            )}
          </div>
        )}

        {/* ---------------- MY BETS ---------------- */}
        {tab === "mybets" && (
          <div className="mt-3">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <input value={betSearch} onChange={(e) => setBetSearch(e.target.value)} placeholder="search player or team" className="bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-sm w-44 text-slate-100" />
                <Sel compact label="show" v={betStatusFilter} opts={["all", "open", "settled", "won", "lost", "push", "void"]} labels={{ all: "All", open: "Open", settled: "Settled", won: "Won", lost: "Lost", push: "Push", void: "Void" }} onChange={setBetStatusFilter} />
                <Sel compact label="date" v={betDateFilter} opts={["all", ...betDates]} labels={{ all: "All dates" }} onChange={setBetDateFilter} />
                <MultiSel compact label="game" selected={betGameFilters} opts={betGames} onChange={setBetGameFilters} />
                <MultiSel compact label="category" selected={betTypeFilters} opts={betTypes} onChange={setBetTypeFilters} />
                <MultiSel compact label="book" selected={betBookFilters} opts={betBooks} labels={BOOK_LABELS} onChange={setBetBookFilters} />
                <Sel compact label="side" v={betSideFilter} opts={["all", ...betSides]} labels={{ all: "All sides" }} onChange={setBetSideFilter} />
                <Sel compact label="sort" v={betSort} opts={["recent", "game", "model_desc", "model_asc", "ev_desc", "ev_asc", "edge_desc", "edge_asc", "clv_desc", "clv_asc", "delta_desc", "delta_asc"]} labels={{ recent: "Most recent", game: "Game", model_desc: "Model % ↓", model_asc: "Model % ↑", ev_desc: "EV ↓", ev_asc: "EV ↑", edge_desc: "Edge ↓", edge_asc: "Edge ↑", clv_desc: "Line move ↓", clv_asc: "Line move ↑", delta_desc: "Proj Δ ↓", delta_asc: "Proj Δ ↑" }} onChange={setBetSort} />
                {(() => { const n = (betMinModel !== "" ? 1 : 0) + (betMinEdge !== "" ? 1 : 0) + (betMaxEdge !== "" ? 1 : 0) + (betMinOdds !== "" ? 1 : 0) + (betMaxOdds !== "" ? 1 : 0) + (betMinDelta !== "" ? 1 : 0) + (betMaxDelta !== "" ? 1 : 0) + (betDirAligned ? 1 : 0); return (
                  <button onClick={() => setShowMoreBets((s) => !s)} className={`text-xs rounded px-2.5 py-1.5 border ${showMoreBets || n ? "border-emerald-700 text-emerald-300" : "border-slate-700 text-slate-400 hover:text-slate-200"}`}>more{n ? ` (${n})` : ""} {showMoreBets ? "▴" : "▾"}</button>
                ); })()}
                {betFiltersActive && <button onClick={clearBetFilters} className="text-[11px] text-slate-400 hover:text-rose-300 border border-slate-700 rounded px-2.5 py-1.5">clear</button>}
              </div>
              <div className="flex items-center gap-2 self-end">
                <button onClick={exportCSV} disabled={myBets.length === 0} className="bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white font-bold text-sm rounded-lg px-3 py-1.5">Download CSV</button>
                <button onClick={backupBets} disabled={myBets.length === 0} className="bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white font-bold text-sm rounded-lg px-3 py-1.5" title="Save a .json backup you can restore later or on another device">Backup</button>
                <label className="bg-slate-700 hover:bg-slate-600 text-white font-bold text-sm rounded-lg px-3 py-1.5 cursor-pointer" title="Restore bets from a .json backup">Restore
                  <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => { restoreBets(e.target.files && e.target.files[0]); e.target.value = ""; }} />
                </label>
                <button onClick={refreshLines} disabled={refreshingLines} className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-bold text-sm rounded-lg px-3 py-1.5" title="Pull the current price for each open tracked bet (line movement / CLV). ~9 credits per game.">{refreshingLines ? "…" : "Refresh lines"}</button>
                <button onClick={settleBets} className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm rounded-lg px-3 py-1.5">Settle finished</button>
              </div>
            </div>
            {showMoreBets && (
              <div className="flex items-end gap-3 flex-wrap mb-3 p-2.5 rounded-lg bg-slate-900/40 border border-slate-800">
                <label className="text-xs text-slate-400 flex flex-col gap-1">min model %
                  <input value={betMinModel} onChange={(e) => setBetMinModel(e.target.value)} placeholder="any" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">min edge %
                  <input value={betMinEdge} onChange={(e) => setBetMinEdge(e.target.value)} placeholder="any" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">max edge %
                  <input value={betMaxEdge} onChange={(e) => setBetMaxEdge(e.target.value)} placeholder="any" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">min proj Δ
                  <input value={betMinDelta} onChange={(e) => setBetMinDelta(e.target.value)} placeholder="e.g. 0.5" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">max proj Δ
                  <input value={betMaxDelta} onChange={(e) => setBetMaxDelta(e.target.value)} placeholder="e.g. 2.0" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">min odds
                  <input value={betMinOdds} onChange={(e) => setBetMinOdds(e.target.value)} placeholder="-300" inputMode="numeric" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">max odds
                  <input value={betMaxOdds} onChange={(e) => setBetMaxOdds(e.target.value)} placeholder="+300" inputMode="numeric" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">proj aligned
                  <button onClick={() => setBetDirAligned((s) => !s)} className={`text-xs rounded px-3 py-1.5 border font-medium ${betDirAligned ? "border-sky-600 bg-sky-950 text-sky-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`} title="Only show bets where proj direction matched the bet side">{betDirAligned ? "on" : "off"}</button>
                </label>
              </div>
            )}
            {settleMsg && <div className="text-[11px] text-slate-400 mb-2">{settleMsg}</div>}
            {lineMsg && <div className="text-[11px] text-indigo-300 mb-2">{lineMsg}</div>}
            {myBets.length > 0 && (
              <div className="text-[11px] text-slate-400 mb-2 flex items-center gap-x-3 gap-y-1 flex-wrap">
                <span>showing <b className="text-slate-200">{myBetsView.length}</b> of {myBets.length} bets</span>
                {(() => {
                  const set = myBetsView.filter((b) => b.status === "won" || b.status === "lost" || b.status === "push" || b.status === "void");
                  if (!set.length) return null;
                  const w = set.filter((b) => b.status === "won").length, l = set.filter((b) => b.status === "lost").length, p = set.filter((b) => b.status === "push").length;
                  const net = set.reduce((s, b) => s + (profitUnits(b.status, Number(b.odds), b.units != null ? b.units : 1) || 0), 0);
                  const wr = (w + l) ? (w / (w + l) * 100).toFixed(1) : "0.0";
                  return <span>· settled in view: <b className="text-slate-200">{w}-{l}{p ? `-${p}` : ""}</b> ({wr}%) · net <b className={net >= 0 ? "text-emerald-400" : "text-rose-400"}>{net >= 0 ? "+" : ""}{net.toFixed(2)}u</b></span>;
                })()}
              </div>
            )}
            {myBets.length === 0 ? (
              <div className="text-sm text-slate-500 py-10 text-center">No bets tracked. Add from the Board (<span className="text-emerald-400">track</span>) or draft one from a player on the Slate.</div>
            ) : myBetsView.length === 0 ? (
              <div className="text-sm text-slate-500 py-10 text-center">No bets match this filter.</div>
            ) : (
              <div className="space-y-2">
                {myBetsView.map((b) => <MyBetRow key={b.key} b={b} onOdds={(v) => updateBetOdds(b.key, v)} onUnits={(v) => updateBetUnits(b.key, v)} onRemove={() => removeBet(b.key)} />)}
              </div>
            )}
          </div>
        )}

        {/* ---------------- STATS ---------------- */}
        {tab === "stats" && (
          <div className="mt-3">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <div className="text-[11px] text-slate-500" style={mono}>net & ROI are stake-weighted (units per bet) · flat-1u shown for comparison</div>
              <div className="flex items-center gap-2">
                <button onClick={exportCSV} disabled={myBets.length === 0} className="bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white font-bold text-xs rounded-lg px-3 py-1.5">Download CSV</button>
                <button onClick={resetStats} disabled={myBets.length === 0} className="bg-slate-800 hover:bg-rose-700 disabled:opacity-40 border border-slate-700 text-slate-200 font-bold text-xs rounded-lg px-3 py-1.5">Reset stats</button>
              </div>
            </div>

            {/* Board Log section — calibration dataset (all board candidates, not just tracked bets) */}
            <div className="mb-4 p-3 rounded-lg bg-slate-900/60 border border-slate-800">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <div className="text-xs font-bold text-slate-300 mb-0.5">Board Snapshot Log</div>
                  <div className="text-[11px] text-slate-500">
                    Every prop shown on the board is logged here for calibration analysis — not just tracked bets.
                    {boardLogCount > 0
                      ? <span className="text-emerald-400 ml-1">{boardLogCount.toLocaleString()} candidates logged · model {MODEL_VERSION}</span>
                      : <span className="text-slate-600 ml-1">No entries yet — load a game to start logging.</span>
                    }
                  {boardLogSettleMsg && <span className="block mt-0.5 text-sky-400">{boardLogSettleMsg}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={settleFullBoardLog}
                    disabled={boardLogSettling || boardLogCount === 0}
                    className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white font-bold text-xs rounded-lg px-3 py-1.5"
                    title="Grade every board candidate for finished games — uses free MLB Stats API, no Odds API credits"
                  >
                    {boardLogSettling ? "Settling…" : "Settle board log"}
                  </button>
                  <button
                    onClick={exportBoardLogCSV}
                    disabled={boardLogCount === 0}
                    className="bg-sky-700 hover:bg-sky-600 disabled:opacity-40 text-white font-bold text-xs rounded-lg px-3 py-1.5"
                    title="Export every board candidate with raw model probability, calibrated probability, edge, projection, and settlement result"
                  >
                    Export CSV
                  </button>
                  <button
                    onClick={() => { clearBoardLog(); setBoardLogCount(0); setBoardLogSettleMsg(""); }}
                    disabled={boardLogCount === 0}
                    className="bg-slate-800 hover:bg-rose-800 disabled:opacity-40 border border-slate-700 text-slate-400 font-bold text-xs rounded-lg px-3 py-1.5"
                    title="Permanently delete all board log entries (export first)"
                  >
                    Clear log
                  </button>
                </div>
              </div>
            </div>

            {/* Date range filter */}
            <div className="flex items-end gap-3 flex-wrap mb-4 p-2.5 rounded-lg bg-slate-900/40 border border-slate-800">
              <label className="text-xs text-slate-400 flex flex-col gap-1">start date
                <input type="date" value={statsStartDate} min={statsDates[0] || ""} max={statsEndDate || statsDates[statsDates.length - 1] || ""} onChange={(e) => setStatsStartDate(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-100 w-36" />
              </label>
              <label className="text-xs text-slate-400 flex flex-col gap-1">end date
                <input type="date" value={statsEndDate} min={statsStartDate || statsDates[0] || ""} max={statsDates[statsDates.length - 1] || ""} onChange={(e) => setStatsEndDate(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-100 w-36" />
              </label>
              {(statsStartDate || statsEndDate) && (
                <button onClick={() => { setStatsStartDate(""); setStatsEndDate(""); }} className="text-[11px] text-slate-400 hover:text-rose-300 border border-slate-700 rounded px-2.5 py-1.5">clear</button>
              )}
              <div className="text-[11px] text-slate-500 self-end pb-1.5" style={mono}>
                {statsStartDate || statsEndDate
                  ? `${statsStartDate || statsDates[0] || "…"} → ${statsEndDate || statsDates[statsDates.length - 1] || "…"}`
                  : "all time"}
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
              <StatCard label="Settled" v={stats.overall.n} />
              <StatCard label="Win %" v={stats.overall.winPct != null ? pct(stats.overall.winPct) : "—"} good={stats.overall.winPct != null && stats.overall.winPct >= 0.524} />
              <StatCard label="Net (units)" v={`${stats.overall.net >= 0 ? "+" : ""}${stats.overall.net.toFixed(2)}u`} good={stats.overall.net >= 0} />
              <StatCard label="ROI" v={stats.overall.roi != null ? `${stats.overall.roi >= 0 ? "+" : ""}${(stats.overall.roi * 100).toFixed(1)}%` : "—"} good={stats.overall.roi != null && stats.overall.roi >= 0} />
            </div>
            <div className="text-[11px] text-slate-500 mb-3" style={mono}>
              record {stats.overall.w}-{stats.overall.l}{stats.overall.ps ? `-${stats.overall.ps}` : ""}{stats.overall.v ? ` · ${stats.overall.v} void` : ""} · {stats.overall.staked.toFixed(2)}u staked · {stats.openCount} open · break-even ≈ 52.4% at −110
            </div>
            <div className="text-[11px] mb-3 px-3 py-2 rounded-lg bg-slate-900/70 border border-slate-800" style={mono}>
              <span className="text-slate-500">strategy compare · </span>
              <span className="text-slate-300">staked: <span className={stats.overall.net >= 0 ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>{stats.overall.net >= 0 ? "+" : ""}{stats.overall.net.toFixed(2)}u</span> ({stats.overall.roi != null ? `${(stats.overall.roi * 100).toFixed(1)}%` : "—"} ROI)</span>
              <span className="text-slate-600"> vs </span>
              <span className="text-slate-300">flat 1u: <span className={stats.overall.flatNet >= 0 ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>{stats.overall.flatNet >= 0 ? "+" : ""}{stats.overall.flatNet.toFixed(2)}u</span> ({stats.overall.flatRoi != null ? `${(stats.overall.flatRoi * 100).toFixed(1)}%` : "—"} ROI)</span>
            </div>
            {Object.keys(stats.byType).length === 0 ? (
              <div className="text-sm text-slate-500 py-8 text-center">No settled bets yet. Track bets, then hit “Settle finished” after games end.</div>
            ) : (
              <div className="space-y-2">
                {STAT_ORDER.filter((t) => stats.byType[t]).map((t) => { const s = stats.byType[t]; return (
                  <div key={t} className="flex items-center gap-3 bg-slate-900/70 border border-slate-800 rounded-xl px-4 py-2.5 text-[12px]" style={mono}>
                    <div className="flex-1 font-semibold">{t}</div>
                    <div className="text-slate-400">{s.w}-{s.l}{s.ps ? `-${s.ps}` : ""}</div>
                    <div className="text-slate-300 w-16 text-right">{s.winPct != null ? pct(s.winPct) : "—"}</div>
                    <div className={`w-20 text-right font-bold ${s.net >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{s.net >= 0 ? "+" : ""}{s.net.toFixed(2)}u</div>
                  </div>); })}
              </div>
            )}
            <div className="mt-5 text-[11px] text-slate-600 leading-relaxed">
              Net/ROI use each bet’s unit stake; the flat-1u line shows what the same bets return at a flat stake, so you can see whether the ¼-Kelly suggestion actually beats flat. Kelly only helps if the model’s edges are real, so trust the comparison over many bets, not a handful. Once there’s a real sample, also compare win% by edge bucket to tune the priors (RECENT_WEIGHT, NB_PHI, shrinkage).
            </div>
          </div>
        )}
      </div>

      {/* DRAFT TRAY (manual bet) */}
      {draft && (
        <div className="fixed inset-x-0 bottom-0 bg-slate-900 border-t border-slate-700 z-30">
          <div className="max-w-5xl mx-auto px-4 py-3 flex flex-wrap items-end gap-3">
            <div className="text-sm font-bold">{draft.name} <span className="text-slate-500 text-[10px] font-normal">{draft.ctxKind === "pitcher" ? "PITCHER" : "HITTER"} · manual</span></div>
            <Sel label="Type" v={draft.type} opts={draft.ctxKind === "pitcher" ? PITCHER_PROPS : HITTER_PROPS} onChange={(v) => setDraft((p) => ({ ...p, type: v, line: DEFAULT_LINE[v] || "0.5" }))} />
            <NumIn label="Line" v={draft.line} onChange={(v) => setDraft((p) => ({ ...p, line: v }))} placeholder="0.5" />
            <Sel label="Side" v={draft.side} opts={["over", "under"]} onChange={(v) => setDraft((p) => ({ ...p, side: v }))} />
            <NumIn label="Odds" v={draft.odds} onChange={(v) => setDraft((p) => ({ ...p, odds: v }))} placeholder="-115" />
            <button onClick={addManualBet} className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm rounded px-3 py-1.5">Track bet</button>
            <button onClick={() => setDraft(null)} className="text-slate-400 hover:text-slate-200 text-sm">cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------- subcomponents ---------------------- */
function PlayerAnalysisIntro({ games, boardCount }) {
  const live = (games || []).filter((g) => g.status === "LIVE").length;
  const posted = (games || []).filter((g) => g.status === "POSTED" || g.status === "PARTIAL").length;
  return (
    <div className="grid sm:grid-cols-3 gap-3">
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">PLAYER FILE</div>
        <div className="text-sm text-slate-300">Search any MLB player by name.</div>
        <div className="text-[11px] text-slate-600 mt-2" style={mono}>season · recent windows · splits · Statcast</div>
      </div>
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">SLATE CONTEXT</div>
        <div className="text-sm text-slate-300">{posted} posted/partial lineup game(s), {live} live.</div>
        <div className="text-[11px] text-slate-600 mt-2" style={mono}>matchup · park · weather · BvP</div>
      </div>
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">MARKET CONTEXT</div>
        <div className="text-sm text-slate-300">{boardCount} board candidate(s) loaded.</div>
        <div className="text-[11px] text-slate-600 mt-2" style={mono}>odds · no-vig · edge · EV</div>
      </div>
    </div>
  );
}
function PlayerProfilePanel({ profile, spot, detail, projections, boardEntries, boardGameCount, book, oddsLoading, oddsReady, onFetchOdds, myBets, onTrack, showProjBar }) {
  const p = profile.player;
  const isPitcher = profile.kind === "pitcher";
  const hasSlate = !!spot;
  const slateReady = hasSlate && detail && detail.ready;
  const canFetchOdds = hasSlate && spot.game && !spot.game.manual && spot.game.status !== "FINAL";
  const hSeason = profile.hitterSeason;
  const pSeason = profile.pitcherSeason;
  const [mktSort, setMktSort] = useState("ev_desc");
  const sortedMkts = useMemo(() => {
    const getDelta = (e: any) => (e.proj ?? 0) - parseFloat(e.line ?? 0);
    const cmps: Record<string, (a: any, b: any) => number> = {
      ev_desc: (a, b) => (b.ev ?? -9) - (a.ev ?? -9),
      proj_desc: (a, b) => (b.proj ?? -9) - (a.proj ?? -9),
      edge_desc: (a, b) => (b.edge ?? -9) - (a.edge ?? -9),
      delta_desc: (a, b) => getDelta(b) - getDelta(a),
      type: (a, b) => (a.type || "").localeCompare(b.type || ""),
    };
    return cmps[mktSort] ? [...boardEntries].sort(cmps[mktSort]) : boardEntries;
  }, [boardEntries, mktSort]);
  return (
    <div className="space-y-3">
      <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-start gap-3">
            <img
              src={`https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/${p.id}/headshot/67/current`}
              alt=""
              className="w-16 h-16 rounded-xl object-cover border border-slate-700 bg-slate-800 flex-shrink-0"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
            <div>
              <div className="text-2xl font-black tracking-tight">{p.name}</div>
              <div className="text-[11px] text-slate-500 mt-1" style={mono}>
                {p.teamAbbr || p.team || "FA"} · {p.positionName || p.position || (isPitcher ? "Pitcher" : "Hitter")} · bats {p.bats || "—"} / throws {p.throws || "—"}
                {p.active === false ? " · inactive" : ""}
              </div>
            </div>
          </div>
          {hasSlate ? <Chip s={spot.game.status} /> : <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-400">NOT ON SELECTED SLATE</span>}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
          {isPitcher ? (
            <>
              <MiniMetric label="ERA" value={pSeason ? pSeason.era : "—"} />
              <MiniMetric label="K/9" value={pSeason ? pSeason.k9.toFixed(1) : "—"} />
              <MiniMetric label="FIP" value={pSeason && pSeason.fip != null ? pSeason.fip.toFixed(2) : "—"} />
              <MiniMetric label="Exp IP" value={pSeason ? pSeason.expIp.toFixed(1) : "—"} />
            </>
          ) : (
            <>
              <MiniMetric label="AVG" value={hSeason ? hSeason.avg : "—"} />
              <MiniMetric label="OPS" value={hSeason ? hSeason.ops : "—"} />
              <MiniMetric label="HR" value={hSeason ? hSeason.hr : "—"} />
              <MiniMetric label="H+R+RBI/G" value={hSeason ? displayNum((hSeason.h + hSeason.r + hSeason.rbi) / Math.max(hSeason.g || 1, 1), 2) : "—"} />
            </>
          )}
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-3">
        <SlateProfileCard spot={spot} detail={detail} profile={profile} />
        <SeasonProfileCard profile={profile} />
        <StatcastProfileCard title={isPitcher ? "Pitcher Statcast" : "Batter Statcast"} sc={isPitcher ? profile.statcastPitcher : profile.statcastBatter} kind={isPitcher ? "pitcher" : "hitter"} />
      </div>

      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
        <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
          <div>
            <div className="text-xs font-bold text-slate-300">Model Projections</div>
            <div className="text-[11px] text-slate-500" style={mono}>{hasSlate ? (slateReady ? "using selected-slate matchup context" : "loading selected-slate context") : "available when player is in the selected slate"}</div>
          </div>
          {canFetchOdds && (
            oddsReady ? (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-emerald-500" style={mono}>✓ odds loaded</span>
                <button onClick={onFetchOdds} disabled={oddsLoading === spot.game.pk} className="text-[10px] text-slate-500 hover:text-slate-300 border border-slate-700 rounded px-2 py-1 disabled:opacity-40" title="Re-fetch from API (costs 1 credit)">
                  {oddsLoading === spot.game.pk ? "…" : "↺ refresh"}
                </button>
              </div>
            ) : (
              <button onClick={onFetchOdds} disabled={oddsLoading === spot.game.pk} className="bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white font-bold text-xs rounded-lg px-3 py-1.5">
                {oddsLoading === spot.game.pk ? "…" : `Get ${book} odds`}
              </button>
            )
          )}
        </div>
        {!hasSlate ? <div className="text-sm text-slate-500 py-5 text-center">No matchup on the selected date. Change the date if you want same-day projections.</div>
          : !slateReady ? <div className="text-sm text-slate-500 py-5 text-center" style={mono}>loading matchup detail…</div>
          : <div className="grid sm:grid-cols-2 gap-2">{projections.map((r) => <AnalysisProjectionRow key={r.type} r={r} />)}</div>}
      </div>

      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
        <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
          <div>
            <div className="text-xs font-bold text-slate-300">Current Board Markets</div>
            <div className="text-[11px] text-slate-500" style={mono}>{boardEntries.length ? `${boardEntries.length} priced player market(s) loaded` : boardGameCount ? "game odds loaded, no matched player markets" : "pull odds from Slate or this profile to populate market rows"}</div>
          </div>
          {boardEntries.length > 1 && (
            <div className="flex gap-1">
              {([["ev_desc","EV"],["proj_desc","Proj"],["edge_desc","Edge"],["delta_desc","Δ"],["type","Type"]] as const).map(([k, l]) => (
                <button key={k} onClick={() => setMktSort(k)} className={`text-[10px] px-2 py-1 rounded border ${mktSort === k ? "border-sky-700 text-sky-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`}>{l}</button>
              ))}
            </div>
          )}
        </div>
        {sortedMkts.length ? (
          <div className="space-y-2">
            {sortedMkts.map((e) => <BoardRow key={e.id} e={e} tracked={myBets.some((b) => b.key === e.id)} onTrack={() => onTrack(e)} showProjBar={showProjBar} />)}
          </div>
        ) : <div className="text-sm text-slate-500 py-5 text-center">No player-specific odds rows loaded yet.</div>}
      </div>

      <div className="grid lg:grid-cols-2 gap-3">
        <RecentWindowsCard title={isPitcher ? "Pitching Form" : "Hitting Form"} kind={isPitcher ? "pitcher" : "hitter"} rows={isPitcher ? profile.pitchingWindows : profile.hittingWindows} logs={isPitcher ? profile.pitcherLogs : profile.hitterLogs} projections={projections} boardEntries={boardEntries} />
        {isPitcher
          ? <div className="space-y-3"><PitcherSplitCard splits={profile.pitcherSplits} /><GameLogCard kind="pitcher" logs={profile.pitcherLogs} /></div>
          : <SplitAndLogCard splits={profile.hitterSplits} logs={profile.hitterLogs} />}
      </div>
    </div>
  );
}
function MiniMetric({ label, value, good }) {
  return <div className="bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2"><div className="text-[9px] text-slate-500 font-bold tracking-wide">{label}</div><div className={`text-lg font-black ${good === true ? "text-emerald-400" : good === false ? "text-rose-400" : "text-slate-100"}`}>{value}</div></div>;
}
function SlateProfileCard({ spot, detail, profile }) {
  const p = profile.player;
  if (!spot) return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">SLATE MATCHUP</div>
      <div className="text-sm text-slate-500">Not found on the selected date.</div>
    </div>
  );
  const g = spot.game;
  const rec = detail && detail.ready && spot.kind === "hitter" ? detail.hitters[String(p.id)] : null;
  const bvp = rec && rec.bvp;
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">SLATE MATCHUP</div>
      <div className="text-sm font-bold">{g.away} <span className="text-slate-600">@</span> {g.home}</div>
      <div className="text-[11px] text-slate-500 mt-1" style={mono}>
        {spot.kind === "hitter" ? `${spot.side === "home" ? g.home : g.away} lineup · spot ${spot.lineupIndex + 1} · vs ${(spot.oppSP && spot.oppSP.name) || "TBD"}` : `${spot.side === "home" ? g.home : g.away} starter · vs ${spot.oppTeam}`}
      </div>
      {detail && detail.ready && (
        <div className="mt-2 space-y-1 text-[11px]" style={mono}>
          <div className="text-slate-400">park RF <span className="text-sky-300">{detail.park.rf.toFixed(2)}</span>{detail.weather && !detail.park.dome ? ` · ${detail.weather.temp}° · wind ${detail.weather.wind}mph` : detail.park.dome ? " · dome" : ""}</div>
          <div className="text-slate-400">model score <span className="text-sky-300">{g.away} {detail.lambdaA.toFixed(1)} – {detail.lambdaH.toFixed(1)} {g.home}</span></div>
          {spot.kind === "hitter" && <div className="text-slate-400">BvP {bvp ? <span className="text-slate-200">{bvp.h}-{bvp.ab}{bvp.hr ? `, ${bvp.hr} HR` : ""}</span> : <span className="text-slate-600">no/limited history</span>}</div>}
        </div>
      )}
      {detail && detail.loading && <div className="text-[11px] text-slate-600 mt-2" style={mono}>loading detail…</div>}
    </div>
  );
}
function SeasonProfileCard({ profile }) {
  const s = profile.kind === "pitcher" ? profile.pitcherSeason : profile.hitterSeason;
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">SEASON BASELINE</div>
      {!s ? <div className="text-sm text-slate-500">No season line returned.</div> : profile.kind === "pitcher" ? (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]" style={mono}>
          <span className="text-slate-500">IP <b className="text-slate-200">{displayNum(s.ip, 1)}</b></span>
          <span className="text-slate-500">GS <b className="text-slate-200">{s.gs}</b></span>
          <span className="text-slate-500">SO <b className="text-slate-200">{s.so}</b></span>
          <span className="text-slate-500">BB <b className="text-slate-200">{s.bb}</b></span>
          <span className="text-slate-500">K% <b className="text-slate-200">{s.bf ? pct(s.so / s.bf) : "—"}</b></span>
          <span className="text-slate-500">BB% <b className="text-slate-200">{s.bf ? pct(s.bb / s.bf) : "—"}</b></span>
          <span className="text-slate-500">WHIP <b className="text-slate-200">{s.ip ? displayNum((s.h + s.bb) / s.ip, 2) : "—"}</b></span>
          <span className="text-slate-500">HR/9 <b className="text-slate-200">{s.ip ? displayNum((s.hrA * 9) / s.ip, 2) : "—"}</b></span>
          <span className="text-slate-500">FIP <b className="text-slate-200">{s.fip != null ? s.fip.toFixed(2) : "—"}</b></span>
          <span className="text-slate-500">role <b className="text-slate-200">{s.role}</b></span>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]" style={mono}>
          <span className="text-slate-500">G <b className="text-slate-200">{s.g}</b></span>
          <span className="text-slate-500">PA <b className="text-slate-200">{s.pa || s.ab}</b></span>
          <span className="text-slate-500">AVG <b className="text-sky-300">{s.avg || "—"}</b></span>
          <span className="text-slate-500">OBP <b className="text-sky-300">{s.obp || "—"}</b></span>
          <span className="text-slate-500">SLG <b className="text-sky-300">{s.slg || "—"}</b></span>
          <span className="text-slate-500">OPS <b className="text-sky-300">{s.ops || "—"}</b></span>
          <span className="text-slate-500">HR <b className="text-slate-200">{s.hr}</b></span>
          <span className="text-slate-500">TB <b className="text-slate-200">{s.tb}</b></span>
          <span className="text-slate-500">K% <b className="text-slate-200">{s.pa ? pct(s.so / s.pa) : "—"}</b></span>
          <span className="text-slate-500">BB% <b className="text-slate-200">{s.pa ? pct(s.bb / s.pa) : "—"}</b></span>
        </div>
      )}
    </div>
  );
}
function StatcastProfileCard({ title, sc, kind }) {
  const ok = sc && sc.verdict === "season_confirmed";
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">{title.toUpperCase()}</div>
      {!sc ? <div className="text-sm text-slate-500">Not fetched.</div> : (
        <>
          <div className={`text-sm font-bold ${ok ? "text-emerald-400" : "text-amber-400"}`}>{sc.verdict || "unknown"}</div>
          <div className="text-[10px] text-slate-600 mb-2" style={mono}>{sc.source || "savant"}{sc.cached ? " · cached" : ""}</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]" style={mono}>
            <span className="text-slate-500">BBE <b className="text-slate-200">{sc.bbe ?? "—"}</b></span>
            <span className="text-slate-500">pitches <b className="text-slate-200">{sc.pitches ?? "—"}</b></span>
            {kind === "hitter" && <span className="text-slate-500">xBA <b className="text-sky-300">{displayRate(sc.xba)}</b></span>}
            <span className="text-slate-500">xwOBA <b className="text-sky-300">{displayRate(kind === "pitcher" ? sc.xwobaAllowed : sc.xwoba)}</b></span>
            <span className="text-slate-500">EV <b className="text-slate-200">{displayNum(sc.avgEV, 1)}</b></span>
            <span className="text-slate-500">HH% <b className="text-slate-200">{sc.hardHitRate != null ? pct(sc.hardHitRate) : "—"}</b></span>
            <span className="text-slate-500">Brl% <b className="text-slate-200">{sc.barrelRate != null || sc.barrelAllowedRate != null ? pct(kind === "pitcher" ? sc.barrelAllowedRate : sc.barrelRate) : "—"}</b></span>
            {kind === "pitcher" && <span className="text-slate-500">CSW% <b className="text-slate-200">{sc.cswRate != null ? pct(sc.cswRate) : "—"}</b></span>}
          </div>
        </>
      )}
    </div>
  );
}
function AnalysisProjectionRow({ r }) {
  const pm = projMeta(r.proj, r.line, "over");
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-bold">{r.type} <span className="text-slate-500 text-xs">line {r.line}</span></div>
          <div className="text-[11px] text-slate-500" style={mono}>proj <span className="text-sky-300">{r.proj != null ? r.proj.toFixed(2) : "—"}</span>{pm && <span className={`ml-1 ${pm.color}`}>vs line {pm.delta >= 0 ? "+" : "−"}{Math.abs(pm.delta).toFixed(2)}</span>}</div>
        </div>
        <div className="text-right text-[11px]" style={mono}>
          <div>Over <b className="text-emerald-300">{pct(r.overP)}</b> <span className="text-slate-600">{r.overFair}</span></div>
          <div>Under <b className="text-sky-300">{pct(r.underP)}</b> <span className="text-slate-600">{r.underFair}</span></div>
        </div>
      </div>
    </div>
  );
}
// projType: maps to the prop type string used in projections / boardEntries
// isOuts: true means the fn() returns outs (integer), display as IP string, and line is in outs
const HITTER_CHART_CATS = [
  { key: "hits", label: "Hits",    fn: (s) => +s.hits || 0,                                          defaultLine: 0.5, projType: "Hits" },
  { key: "tb",   label: "TB",      fn: (s) => +s.totalBases || 0,                                    defaultLine: 1.5, projType: "Total Bases" },
  { key: "hr",   label: "HR",      fn: (s) => +s.homeRuns || 0,                                      defaultLine: 0.5, projType: "Home Run" },
  { key: "hrr",  label: "H+R+RBI", fn: (s) => (+s.hits || 0) + (+s.runs || 0) + (+s.rbi || 0),      defaultLine: 1.5, projType: "H+R+RBI" },
];
const PITCHER_CHART_CATS = [
  { key: "k",  label: "Ks", fn: (s) => +s.strikeOuts || 0,                isOuts: false, defaultLine: 5.5,  projType: "Strikeouts" },
  { key: "ip", label: "IP", fn: (s) => ipToOuts(s.inningsPitched || "0"), isOuts: true,  defaultLine: 15,   projType: "Outs" },
  { key: "er", label: "ER", fn: (s) => +s.earnedRuns || 0,                isOuts: false, defaultLine: 2.5,  projType: null },
];
function RecentWindowsCard({ title, kind, rows, logs, projections, boardEntries }) {
  const cats = kind === "pitcher" ? PITCHER_CHART_CATS : HITTER_CHART_CATS;
  const [win, setWin] = useState(20);
  const [catKey, setCatKey] = useState(cats[0].key);
  const [lineMode, setLineMode] = useState<"model"|"actual">("model");
  const cat = cats.find((c) => c.key === catKey) || cats[0];

  // Model projection line: use the player's projected value for this matchup
  const modelLine = (() => {
    if (!cat.projType || !projections || !projections.length) return cat.defaultLine;
    const p = projections.find((p) => p.type === cat.projType);
    return (p && p.proj != null) ? +p.proj.toFixed(2) : cat.defaultLine;
  })();

  // Actual market line: from loaded board entries (over/under share the same line)
  const actualLine = (() => {
    if (!cat.projType || !boardEntries || !boardEntries.length) return null;
    const e = boardEntries.find((e) => e.type === cat.projType);
    return e ? parseFloat(String(e.line)) : null;
  })();

  const hasActual = actualLine != null;
  // Only use actual mode when it's available; reset to model if it disappears
  const effectiveMode = (lineMode === "actual" && hasActual) ? "actual" : "model";
  const activeLine = effectiveMode === "actual" ? actualLine! : modelLine;

  // Format the active line for display (IP category shows outs→IP notation)
  const fmtLineLabel = (l: number) => {
    if (cat.isOuts) return `${outsToIp(Math.round(l))} (${l} outs)`;
    return typeof l === "number" && !Number.isInteger(l) ? l.toFixed(2) : String(l);
  };
  // Short version for SVG axis label
  const fmtLineShort = (l: number) => cat.isOuts ? outsToIp(Math.round(l)) : String(l);

  // Bar values — newest-first in logs, reversed to oldest→newest left-to-right
  const gameLogs = (logs || []).slice(0, win).reverse();
  const barVals = gameLogs.map((x) => ({
    raw: cat.fn(x.stat || {}),
    date: x.date || "",
    opp: x.opponent || "",
    homeAway: x.homeAway || "",
  }));
  // Display label per bar
  const fmtBarVal = (v: number) => cat.isOuts ? outsToIp(v) : (Number.isInteger(v) ? String(v) : v.toFixed(1));

  const n = barVals.length;
  const hitCount = barVals.filter((b) => b.raw >= activeLine).length;
  const maxVal = Math.max(activeLine * 1.7, ...barVals.map((b) => b.raw), 1);

  const W = 460, H = 120, padL = 28, padR = 6, padT = 14, padB = 22;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const xOf = (i: number) => padL + (i + 0.5) * (chartW / Math.max(n, 1));
  const yOf = (v: number) => padT + chartH - Math.min((v / maxVal) * chartH, chartH);
  const barW = Math.max(4, (chartW / Math.max(n, 1)) * 0.65);
  const lineY = yOf(activeLine);
  const showLabels = n <= 10;
  const lineStroke = effectiveMode === "actual" ? "#7dd3fc" : "#64748b";

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">{title.toUpperCase()}</div>
      {/* Summary table */}
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]" style={mono}>
          <thead className="text-slate-600">
            <tr>{kind === "pitcher" ? ["window","IP","ERA","K","K/9","BB/9"].map((h) => <th key={h} className="text-right font-semibold py-1 first:text-left">{h}</th>) : ["window","H-AB","AVG","HR","TB/G","HRR/G","K%"].map((h) => <th key={h} className="text-right font-semibold py-1 first:text-left">{h}</th>)}</tr>
          </thead>
          <tbody>
            {(rows || []).map((r) => (
              <tr key={r.n} className="border-t border-slate-800/80">
                <td className="py-1 text-slate-400">L{r.n}</td>
                {kind === "pitcher" ? (
                  <>
                    <td className="text-right text-slate-200">{outsToIp(r.outs)}</td>
                    <td className="text-right text-slate-200">{displayNum(r.era, 2)}</td>
                    <td className="text-right text-slate-200">{r.so}</td>
                    <td className="text-right text-slate-200">{displayNum(r.k9, 1)}</td>
                    <td className="text-right text-slate-200">{displayNum(r.bb9, 1)}</td>
                  </>
                ) : (
                  <>
                    <td className="text-right text-slate-200">{r.h}-{r.ab}</td>
                    <td className="text-right text-slate-200">{displayRate(r.avg)}</td>
                    <td className="text-right text-slate-200">{r.hr}</td>
                    <td className="text-right text-slate-200">{displayNum(r.tbG, 2)}</td>
                    <td className="text-right text-slate-200">{displayNum(r.hrrG, 2)}</td>
                    <td className="text-right text-slate-200">{r.kRate != null ? pct(r.kRate) : "—"}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Bar chart controls + chart ── */}
      <div className="mt-3 border-t border-slate-800 pt-3 space-y-1.5">
        {/* Row 1: window selector ← → line mode toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] text-slate-600 font-bold tracking-wide">WINDOW</span>
            {([5,10,20] as const).map((w) => (
              <button key={w} onClick={() => setWin(w)} className={`text-[10px] px-2 py-0.5 rounded border ${win === w ? "border-sky-700 text-sky-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`}>L{w}</button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            {n > 0 && (
              <span className={`text-[12px] font-black ${hitCount / n >= 0.65 ? "text-emerald-400" : hitCount / n >= 0.45 ? "text-amber-400" : "text-rose-400"}`} style={mono}>
                {hitCount}/{n}
              </span>
            )}
            {hasActual && (
              <div className="flex gap-1 ml-2">
                <button onClick={() => setLineMode("model")} className={`text-[10px] px-2 py-0.5 rounded border ${effectiveMode === "model" ? "border-slate-500 text-slate-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`}>proj</button>
                <button onClick={() => setLineMode("actual")} className={`text-[10px] px-2 py-0.5 rounded border ${effectiveMode === "actual" ? "border-sky-600 text-sky-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`}>mkt line</button>
              </div>
            )}
          </div>
        </div>
        {/* Row 2: category selector ← → active line label */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] text-slate-600 font-bold tracking-wide">STAT</span>
            {cats.map((c) => (
              <button key={c.key} onClick={() => setCatKey(c.key)} className={`text-[10px] px-2 py-0.5 rounded border ${catKey === c.key ? "border-emerald-700 text-emerald-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`}>{c.label}</button>
            ))}
          </div>
          <span className="text-[10px] text-slate-500" style={mono}>
            {effectiveMode === "actual" ? <span className="text-sky-400">mkt </span> : <span className="text-slate-600">proj </span>}
            {fmtLineLabel(activeLine)}
          </span>
        </div>

        {/* Chart */}
        {n === 0 ? (
          <div className="text-[11px] text-slate-600 text-center py-3">No game log data available</div>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
            <line x1={padL} y1={padT} x2={padL} y2={padT + chartH} stroke="#1e293b" strokeWidth="1.5" />
            <text x={padL - 3} y={lineY + 3.5} fontSize="8" fill={lineStroke} textAnchor="end" fontFamily="ui-monospace,monospace">{fmtLineShort(activeLine)}</text>
            <line x1={padL} y1={lineY} x2={W - padR} y2={lineY} stroke={lineStroke} strokeWidth="1" strokeDasharray="4,3" />
            {barVals.map((b, i) => {
              const x = xOf(i);
              const hit = b.raw >= activeLine;
              const barH = Math.max(2, (Math.min(b.raw, maxVal) / maxVal) * chartH);
              const y = padT + chartH - barH;
              const dv = fmtBarVal(b.raw);
              return (
                <g key={i}>
                  <rect x={x - barW / 2} y={y} width={barW} height={barH} fill={hit ? "#34d399" : "#f87171"} rx="2" opacity="0.85">
                    <title>{b.date ? b.date.slice(5) : ""} {b.homeAway} {b.opp}: {dv}</title>
                  </rect>
                  <text x={x} y={y - 2} fontSize="7.5" fill={hit ? "#86efac" : "#fca5a5"} textAnchor="middle" fontFamily="ui-monospace,monospace">{dv}</text>
                  {showLabels && <text x={x} y={H - 4} fontSize="7" fill="#475569" textAnchor="middle" fontFamily="ui-monospace,monospace">{b.opp}</text>}
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}
function SplitAndLogCard({ splits, logs }) {
  return (
    <div className="space-y-3">
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">PLATOON SPLITS</div>
        {!splits ? <div className="text-sm text-slate-500">No split line returned.</div> : (
          <div className="grid grid-cols-2 gap-2">
            {[{ lab: "vs LHP", s: splits.vL }, { lab: "vs RHP", s: splits.vR }].map(({ lab, s }) => (
              <div key={lab} className="bg-slate-950/60 border border-slate-800 rounded-lg p-2">
                <div className="text-[10px] text-slate-500 font-bold mb-1">{lab}{s && s.pa ? <span className="text-slate-600 font-normal"> · {s.pa} PA</span> : ""}</div>
                {s ? (
                  <div className="space-y-0.5 text-[11px]" style={mono}>
                    <div className="text-sky-300 font-bold">{s.avg || displayRate(safeDiv(s.h, s.ab))} / {s.obp || displayRate(safeDiv(s.h + s.bb, s.pa || s.ab + s.bb))} / {s.slg || displayRate(safeDiv(s.tb, s.ab))}</div>
                    <div><span className="text-slate-500">K% </span><span className="text-slate-200">{s.pa ? pct(safeDiv(s.so, s.pa)) : "—"}</span><span className="text-slate-600"> · </span><span className="text-slate-500">BB% </span><span className="text-slate-200">{s.pa ? pct(safeDiv(s.bb, s.pa)) : "—"}</span></div>
                    <div><span className="text-slate-500">HR </span><span className="text-slate-200">{s.hr}</span><span className="text-slate-600"> · </span><span className="text-slate-500">H/AB </span><span className="text-slate-200">{s.h}-{s.ab}</span></div>
                  </div>
                ) : <div className="text-slate-600 text-[11px]">—</div>}
              </div>
            ))}
          </div>
        )}
      </div>
      <GameLogCard kind="hitter" logs={logs} />
    </div>
  );
}
function PitcherSplitCard({ splits }) {
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">PLATOON SPLITS</div>
      {!splits ? <div className="text-sm text-slate-500">No split data returned.</div> : (
        <div className="grid grid-cols-2 gap-2">
          {[{ lab: "vs LHB", s: splits.vL }, { lab: "vs RHB", s: splits.vR }].map(({ lab, s }) => (
            <div key={lab} className="bg-slate-950/60 border border-slate-800 rounded-lg p-2">
              <div className="text-[10px] text-slate-500 font-bold mb-1">{lab}{s && s.bf ? <span className="text-slate-600 font-normal"> · {s.bf} BF</span> : ""}</div>
              {s ? (
                <div className="space-y-0.5 text-[11px]" style={mono}>
                  <div><span className="text-slate-500">ERA </span><span className="text-sky-300 font-bold">{s.era || (s.ip ? displayNum((s.er * 9) / s.ip, 2) : "—")}</span></div>
                  <div><span className="text-slate-500">K% </span><span className="text-slate-200">{s.bf ? pct(safeDiv(s.so, s.bf)) : "—"}</span><span className="text-slate-600"> · </span><span className="text-slate-500">BB% </span><span className="text-slate-200">{s.bf ? pct(safeDiv(s.bb, s.bf)) : "—"}</span></div>
                  <div><span className="text-slate-500">K/9 </span><span className="text-slate-200">{s.ip ? displayNum((s.so * 9) / s.ip, 1) : "—"}</span><span className="text-slate-600"> · </span><span className="text-slate-500">HR/9 </span><span className="text-slate-200">{s.ip ? displayNum((s.hr * 9) / s.ip, 2) : "—"}</span></div>
                  <div><span className="text-slate-500">WHIP </span><span className="text-slate-200">{s.ip ? displayNum((s.h + s.bb) / s.ip, 2) : "—"}</span></div>
                </div>
              ) : <div className="text-slate-600 text-[11px]">—</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function GameLogCard({ kind, logs }) {
  const rows = (logs || []).slice(0, 10);
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">LAST 10 GAME LOG</div>
      {!rows.length ? <div className="text-sm text-slate-500">No game log returned.</div> : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]" style={mono}>
            <thead className="text-slate-600">
              <tr>{kind === "pitcher" ? ["date", "opp", "IP", "K", "ER", "H", "BB"].map((h) => <th key={h} className="text-right font-semibold py-1 first:text-left">{h}</th>) : ["date", "opp", "H-AB", "TB", "HR", "HRR"].map((h) => <th key={h} className="text-right font-semibold py-1 first:text-left">{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((x, i) => {
                const s = x.stat || {};
                return (
                  <tr key={`${x.date}-${i}`} className="border-t border-slate-800/80">
                    <td className="py-1 text-left text-slate-400">{x.date ? x.date.slice(5) : "—"}</td>
                    <td className="text-right text-slate-400">{x.homeAway} {x.opponent}</td>
                    {kind === "pitcher" ? (
                      <>
                        <td className="text-right text-slate-200">{s.inningsPitched || "0.0"}</td>
                        <td className="text-right text-slate-200">{+s.strikeOuts || 0}</td>
                        <td className="text-right text-slate-200">{+s.earnedRuns || 0}</td>
                        <td className="text-right text-slate-200">{+s.hits || 0}</td>
                        <td className="text-right text-slate-200">{+s.baseOnBalls || 0}</td>
                      </>
                    ) : (
                      <>
                        <td className="text-right text-slate-200">{+s.hits || 0}-{+s.atBats || 0}</td>
                        <td className="text-right text-slate-200">{+s.totalBases || 0}</td>
                        <td className="text-right text-slate-200">{+s.homeRuns || 0}</td>
                        <td className="text-right text-slate-200">{(+s.hits || 0) + (+s.runs || 0) + (+s.rbi || 0)}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
function Env({ label, v, hot, cold }) {
  return <span className={`px-2 py-1 rounded border ${hot ? "border-rose-700 bg-rose-950/40 text-rose-300" : cold ? "border-sky-800 bg-sky-950/40 text-sky-300" : "border-slate-700 bg-slate-900 text-slate-300"}`}><span className="text-slate-500">{label} </span>{v}</span>;
}
function HotBadge({ delta }) {
  if (delta == null) return null;
  if (delta > 0.08) return <span className="text-[9px] font-bold text-rose-400 ml-1">HOT</span>;
  if (delta < -0.08) return <span className="text-[9px] font-bold text-sky-400 ml-1">COLD</span>;
  return null;
}
function MathPanel({ r }) {
  const p = r.modelP, q = p != null ? 1 - p : null, isLive = r.calc && r.calc.live;
  const activeMults = (r.calc && r.calc.mults ? r.calc.mults : []).filter(([, v]) => Math.abs(Number(v) - 1) > 0.0005);
  const chain = isLive ? "live remaining-game projection" : (activeMults.length ? activeMults.map(([k, v]) => `${k} ${Number(v).toFixed(3)}`).join("  ×  ") : "neutral context");
  if (!r.calc || p == null) return null;
  return (
    <div className="border-t border-slate-800 px-4 py-2.5 text-[11px] text-slate-400 space-y-1" style={mono}>
      <div><span className="text-slate-500">1 · base</span> &nbsp;{r.calc.baseStr}</div>
      <div><span className="text-slate-500">2 · context</span> &nbsp;{chain}</div>
      {isLive && <div><span className="text-slate-500">live</span> &nbsp;have <span className="text-slate-200">{r.calc.live.current}</span> · {Math.round(r.calc.live.fr * 100)}% left · need {(parseFloat(r.line) - r.calc.live.current).toFixed(1)} more</div>}
      <div><span className="text-slate-500">3 · projection</span> &nbsp;{isLive ? "final" : "E"}[{r.type}] = <span className="text-sky-300">{r.proj != null ? r.proj.toFixed(2) : "—"}</span> &nbsp;→ {r.calc.dist}({r.calc.params})</div>
      <div><span className="text-slate-500">4 · model</span> &nbsp;P({r.side} {r.line}) = <span className="text-emerald-300">{pct(p)}</span> → fair {r.fair}</div>
      <div><span className="text-slate-500">5 · market</span> &nbsp;{fmtOdds(r.odds)} {r.devigged ? "(de-vigged" : "(raw"} {r.novig != null ? pct(r.novig) : "—"}{r.devigged ? ")" : ")"}, pays ${r.b.toFixed(2)}/$1</div>
      <div><span className="text-slate-500">6 · EV</span> &nbsp;= p·b − (1−p) = ({p.toFixed(3)})({r.b.toFixed(2)}) − ({q.toFixed(3)}) = <span className={r.ev >= 0 ? "text-emerald-300" : "text-rose-300"}>{r.ev >= 0 ? "+" : ""}{(r.ev * 100).toFixed(1)}%</span></div>
      <div className="text-slate-600">edge = model − {r.devigged ? "no-vig" : "implied"} = {r.edge >= 0 ? "+" : ""}{(r.edge * 100).toFixed(1)} pts</div>
    </div>
  );
}
// Returns projection-vs-line metadata for the visual buffer indicator.
// delta > 0 means the projection is on the "good" side of the line for the bet direction:
//   over bet: proj > line  (proj clears the line)
//   under bet: line > proj (proj sits below the line)
function projMeta(proj, lineStr, side) {
  const l = parseFloat(String(lineStr));
  if (proj == null || isNaN(l) || l <= 0) return null;
  const delta = side === "over" ? proj - l : l - proj;
  // Color thresholds relative to the line value (e.g. +0.7 on a 0.5 line = 140% buffer = very strong)
  const color = delta < 0
    ? "text-rose-400"
    : delta > 0.3 * l
    ? "text-emerald-400"
    : delta > 0.05 * l
    ? "text-emerald-600"
    : "text-slate-500";
  const barColor = delta < 0 ? "#f87171" : delta > 0.3 * l ? "#34d399" : "#86efac";
  const max = Math.max(l * 2.5, proj * 1.5, l + 2);
  const linePct = clamp((l / max) * 100, 1, 98);
  const projPct = clamp((proj / max) * 100, 0, 100);
  return { delta, color, barColor, linePct, projPct };
}

// Delta gate signal indicator (Option B — visual dot on board row).
// Returns "strong" | "moderate" | null based on category-specific thresholds derived from Sep 2-7 data.
// TB / H+R+RBI: |Δ| thresholds (both directions meaningful). Hits / K: direction-only (positive delta only).
// Outs, HR, game lines omitted — delta signal unreliable or inverted for those categories.
function getDeltaSignal(type, proj, line) {
  if (proj == null || line == null) return null;
  const lineNum = parseFloat(line);
  if (isNaN(lineNum)) return null;
  const delta = proj - lineNum;
  const abs = Math.abs(delta);
  if (type === "Total Bases") return abs >= 1.0 ? "strong" : abs >= 0.75 ? "moderate" : null;
  if (type === "H+R+RBI")     return abs >= 1.0 ? "strong" : abs >= 0.75 ? "moderate" : null;
  if (type === "Hits")        return delta > 0.5 ? "strong" : delta > 0 ? "moderate" : null;
  if (type === "Strikeouts")  return delta > 0 ? "moderate" : null; // no strong tier — direction only
  return null;
}

function BoardRow({ e, tracked, onTrack, showProjBar = true }) {
  const [show, setShow] = useState(false);
  const evGood = e.ev >= 0;
  const pm = !isLineType(e.type) ? projMeta(e.proj, e.line, e.side) : null;
  return (
    <div className="bg-slate-900/70 border border-slate-800 rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex-1 min-w-0">
          <div className="font-semibold truncate">{e.name} <span className="text-slate-500 text-xs">{e.game}</span></div>
          <div className="text-[11px] text-slate-400" style={mono}>
            {e.side} {e.line} {e.type} @ {fmtOdds(e.odds)} · <span className="text-sky-300">proj {e.proj != null ? e.proj.toFixed(2) : "—"}</span>
            {pm && <span className={`ml-1.5 font-bold ${pm.color}`}>{pm.delta >= 0 ? "+" : "−"}{Math.abs(pm.delta).toFixed(2)}</span>}
            {(() => { const sig = getDeltaSignal(e.type, e.proj, e.line); return sig ? <span className={`ml-1 ${sig === "strong" ? "text-emerald-400" : "text-yellow-400"}`}>●</span> : null; })()}
          </div>
        </div>
        <div className="text-right text-[11px]" style={mono}>
          <div className="text-slate-400">model {pct(e.modelP)} · fair {e.fair}</div>
          {e.outsSanityFailed
            ? <div className="text-amber-400 font-bold">⚠ stale IP data · edge suppressed</div>
            : <div className={evGood ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>EV {evGood ? "+" : ""}{(e.ev * 100).toFixed(1)}% · edge {e.edge >= 0 ? "+" : ""}{(e.edge * 100).toFixed(1)}%</div>
          }
        </div>
        <button onClick={() => setShow((s) => !s)} className="text-[11px] text-slate-500 hover:text-emerald-300 border border-slate-700 rounded px-2 py-1">{show ? "hide" : "math"}</button>
        <button onClick={onTrack} disabled={tracked} className={`text-[11px] font-bold rounded px-2 py-1 ${tracked ? "bg-slate-700 text-slate-400" : "bg-emerald-600 hover:bg-emerald-500 text-white"}`}>{tracked ? "tracked" : "track"}</button>
      </div>
      {pm && showProjBar && (
        <div className="relative h-1 mx-4 mb-2.5 bg-slate-800 rounded-full overflow-hidden" title={`proj ${e.proj != null ? e.proj.toFixed(2) : "—"} vs line ${e.line} · ${pm.delta >= 0 ? "clears" : "misses"} by ${Math.abs(pm.delta).toFixed(2)}`}>
          <div className="absolute inset-y-0 left-0" style={{ width: `${pm.projPct}%`, backgroundColor: pm.barColor }} />
          <div className="absolute inset-y-0 w-px bg-white/70" style={{ left: `${pm.linePct}%` }} />
        </div>
      )}
      {show && <MathPanel r={e} />}
    </div>
  );
}
function MyBetRow({ b, onOdds, onUnits, onRemove }) {
  const stColor = { open: "bg-slate-700 text-slate-300", won: "bg-emerald-600 text-white", lost: "bg-rose-600 text-white", push: "bg-amber-600 text-slate-950", void: "bg-slate-600 text-slate-200" }[b.status];
  const profit = (b.status === "won" || b.status === "lost") ? profitUnits(b.status, Number(b.odds), b.units) : null;
  return (
    <div className="flex items-center gap-3 bg-slate-900/70 border border-slate-800 rounded-xl px-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="font-semibold truncate">{b.name} <span className="text-slate-500 text-xs">{b.game} · {b.book}</span></div>
        <div className="text-[11px] text-slate-400" style={mono}>
          {b.side} {b.line} {b.type}
          {b.proj != null ? <> · <span className="text-sky-300">proj {Number(b.proj).toFixed(2)}</span></> : ""}
          {(() => { const pm = !isLineType(b.type) && b.proj != null ? projMeta(b.proj, b.line, b.side) : null; if (!pm) return null; return <span className={`ml-1.5 font-bold ${pm.color}`}>{pm.delta >= 0 ? "+" : "−"}{Math.abs(pm.delta).toFixed(2)}</span>; })()}
          {b.actual != null ? <> · <span className="text-slate-300">actual {b.actual}</span></> : ""}
        </div>
        {b.currentOdds != null && (
          <div className="text-[11px]" style={mono} title={b.oddsCheckedAt ? `checked ${new Date(b.oddsCheckedAt).toLocaleTimeString()}` : ""}>
            <span className="text-slate-500">took {fmtOdds(Number(b.odds))} → {b.closing ? "close " : "now "}</span>
            <span className={b.clv != null && b.clv >= 0 ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>{fmtOdds(b.currentOdds)}</span>
            {b.clv != null && <span className={b.clv >= 0 ? "text-emerald-500" : "text-rose-500"}> ({b.clv >= 0 ? "+" : ""}{(b.clv * 100).toFixed(1)} {b.live ? "mov" : "CLV"})</span>}
          </div>
        )}
        {b.currentOdds == null && b.lineMissing && (
          <div className="text-[11px] text-amber-500/80" style={mono} title={b.oddsCheckedAt ? `checked ${new Date(b.oddsCheckedAt).toLocaleTimeString()}` : ""}>line not found (scratched, settled, or moved off your number)</div>
        )}
      </div>
      <label className="text-[10px] text-slate-500 flex flex-col items-end gap-0.5">odds
        <input value={b.odds} onChange={(e) => onOdds(e.target.value)} inputMode="numeric" className="w-16 bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-sm text-slate-100 text-right" />
      </label>
      <label className="text-[10px] text-slate-500 flex flex-col items-end gap-0.5">units
        <input value={b.units} onChange={(e) => onUnits(e.target.value)} inputMode="decimal" className="w-14 bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-sm text-slate-100 text-right" />
        {b.suggested > 0 && <span className="text-[9px] text-slate-600">sug {b.suggested}u</span>}
      </label>
      <div className="text-right text-[11px] w-28" style={mono}>
        {b.modelP != null ? <>
          <div className="text-slate-400">model {pct(b.modelP)}</div>
          <div className={b.ev >= 0 ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>EV {b.ev != null ? `${b.ev >= 0 ? "+" : ""}${(b.ev * 100).toFixed(1)}%` : "—"} · edge {b.edge != null ? `${b.edge >= 0 ? "+" : ""}${(b.edge * 100).toFixed(1)}%` : "—"}</div>
        </> : <div className="text-slate-600">manual</div>}
        {profit != null && <div className={profit >= 0 ? "text-emerald-400" : "text-rose-400"}>{profit >= 0 ? "+" : ""}{profit.toFixed(2)}u</div>}
      </div>
      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${stColor}`}>{b.status}</span>
      <button onClick={onRemove} className="text-slate-600 hover:text-rose-400 text-lg leading-none">×</button>
    </div>
  );
}
function StatCard({ label, v, good }) {
  return <div className="bg-slate-900/70 border border-slate-800 rounded-xl px-3 py-3"><div className="text-[10px] text-slate-500 font-bold tracking-wide">{label}</div><div className={`text-xl font-black mt-0.5 ${good === true ? "text-emerald-400" : good === false ? "text-rose-400" : "text-slate-100"}`}>{v}</div></div>;
}
function LineupCol({ title, g, lineup, d, onAdd, onPlayerClick }) {
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1.5">{title}</div>
      {lineup.length === 0 && <div className="text-[11px] text-slate-600 py-2">— not posted —</div>}
      <div className="space-y-0.5">{lineup.map((p, i) => <PlayerRow key={p.id} idx={i + 1} rec={d.hitters && d.hitters[p.id]} onAdd={() => onAdd(p.id)} onPlayerClick={onPlayerClick ? () => onPlayerClick(p) : null} />)}</div>
    </div>
  );
}
function PlayerRow({ idx, rec, onAdd, onPlayerClick }) {
  const [exp, setExp] = useState(false);
  const stat = rec && rec.season, l15 = rec && rec.l15, bvp = rec && rec.bvp;
  const sProxy = stat && stat.ab ? (stat.h / stat.ab) + (stat.tb / stat.ab) : null;
  const delta = (l15 && sProxy != null) ? (l15.ops - sProxy) : null;
  const oppLast = rec && rec.oppName ? rec.oppName.split(" ").slice(-1)[0] : null;
  return (
    <div className="text-[12px]">
      <div className="flex items-center gap-2">
        <span className="text-slate-600 w-4" style={mono}>{idx}</span>
        <button onClick={() => setExp((e) => !e)} className="text-slate-500 hover:text-slate-300 text-[10px] w-3 flex-shrink-0">{exp ? "▾" : "▸"}</button>
        <button
          onClick={onPlayerClick || undefined}
          disabled={!onPlayerClick}
          className={`flex-1 text-left truncate ${onPlayerClick ? "hover:text-sky-300 cursor-pointer" : "cursor-default"}`}
          title={onPlayerClick ? "Open player analysis" : undefined}
        >{rec ? rec.name : "—"}</button>
        {rec && rec.bats && rec.oppThrows && (() => {
          const f = calculatePlatoonAdjustment({ kind: "hitter", bats: rec.bats, oppThrows: rec.oppThrows, splits: rec.splits, season: rec.season });
          const cls = f < 0.99 ? "bg-rose-900/50 text-rose-300" : f > 1.01 ? "bg-emerald-900/50 text-emerald-300" : "bg-slate-800 text-slate-400";
          return <span className={`text-[9px] px-1 rounded ${cls}`} style={mono} title={`bats ${rec.bats} vs ${rec.oppThrows}HP`}>{rec.bats}v{rec.oppThrows} ×{f.toFixed(2)}</span>;
        })()}
        <span className="text-slate-400" style={mono}>{stat ? `${stat.avg != null ? stat.avg : "—"}/${stat.ops != null ? stat.ops : "—"}` : "—"}</span>
        {delta != null && <HotBadge delta={delta} />}
        <button onClick={onAdd} className="text-emerald-500 hover:text-emerald-300 font-bold w-5 text-center" title="manual bet">+</button>
      </div>
      {exp && (
        <div className="ml-7 mb-1 mt-0.5 text-[11px] text-slate-400" style={mono}>
          <span>season: {stat ? `${stat.h}-${stat.ab}, ${stat.hr}HR, ${stat.slg != null ? stat.slg : "—"}SLG` : "n/a"}</span>
          {l15 && <span className="ml-2 text-slate-300">L15: {l15.h}-{l15.ab}, {l15.hr}HR, {l15.avg.toFixed(3)}</span>}
          {oppLast && <span className="ml-2">vs {oppLast}: {bvp ? `${bvp.h}-${bvp.ab}${bvp.hr ? `, ${bvp.hr}HR` : ""}` : (bvp === null ? "no history" : "…")}</span>}
        </div>
      )}
    </div>
  );
}
function SPCard({ label, sp, st, onAdd, onPlayerClick }) {
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">{label}</div>
      {!sp ? <div className="text-[11px] text-slate-600">TBD</div> : (
        <div className="flex items-center justify-between">
          <div>
            <button
              onClick={onPlayerClick || undefined}
              disabled={!onPlayerClick}
              className={`text-[12px] font-semibold text-left ${onPlayerClick ? "hover:text-sky-300 cursor-pointer" : "cursor-default"}`}
              title={onPlayerClick ? "Open player analysis" : undefined}
            >
              {sp.name}{st && st.role === "swing" ? <span className="ml-1 text-[9px] text-amber-400 font-bold">SWING</span> : null}
            </button>
            <div className="text-[11px] text-slate-400" style={mono}>{st ? `${st.era} ERA · ${st.k9.toFixed(1)} K/9 · ~${st.expIp.toFixed(1)} IP${st.recentLog && st.recentLog.games >= 3 ? ` (L${st.recentLog.games} avg ${st.recentLog.avgIp.toFixed(1)})` : ""}` : "—"}</div>
          </div>
          <button onClick={onAdd} className="text-emerald-500 hover:text-emerald-300 font-bold text-lg" title="manual bet">+</button>
        </div>
      )}
    </div>
  );
}
function Sel({ label, v, opts, labels, onChange, compact }) {
  const sel = (
    <select value={v} onChange={(e) => onChange(e.target.value)} className={`bg-slate-950 border border-slate-700 rounded px-2 ${compact ? "py-1" : "py-1.5"} text-sm text-slate-100`}>
      {opts.map((o) => <option key={o} value={o}>{labels && labels[o] != null ? labels[o] : o}</option>)}
    </select>
  );
  if (compact) return <label className="text-xs text-slate-400 flex items-center gap-1.5 whitespace-nowrap">{label}{sel}</label>;
  return <label className="text-xs text-slate-400 flex flex-col gap-1">{label}{sel}</label>;
}
function MultiSel({ label, selected, opts, labels, onChange, compact }) {
  const [open, setOpen] = useState(false);
  const toggle = (o) => onChange(selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o]);
  const lab = (o) => (labels && labels[o] != null ? labels[o] : o);
  const summary = selected.length === 0 ? "All" : selected.length === 1 ? lab(selected[0]) : `${selected.length} selected`;
  return (
    <div className="relative inline-block">
      <button onClick={() => setOpen((o) => !o)} className={`bg-slate-950 border rounded px-2 ${compact ? "py-1" : "py-1.5"} text-sm whitespace-nowrap ${selected.length ? "border-emerald-700 text-emerald-300" : "border-slate-700 text-slate-100"}`}>
        <span className="text-slate-400">{label}</span> {summary} ▾
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute z-40 mt-1 left-0 bg-slate-900 border border-slate-700 rounded-lg p-2 max-h-64 overflow-auto min-w-[170px] shadow-xl">
            {opts.length === 0 && <div className="text-[11px] text-slate-500 px-1 py-1">none yet</div>}
            {opts.map((o) => (
              <label key={o} className="flex items-center gap-2 px-1.5 py-1 text-sm cursor-pointer hover:bg-slate-800 rounded text-slate-200">
                <input type="checkbox" checked={selected.includes(o)} onChange={() => toggle(o)} className="accent-emerald-500" />
                <span className="truncate">{lab(o)}</span>
              </label>
            ))}
            {selected.length > 0 && <button onClick={() => onChange([])} className="mt-1 w-full text-[11px] text-slate-400 hover:text-rose-300 border-t border-slate-800 pt-1">clear</button>}
          </div>
        </>
      )}
    </div>
  );
}
function NumIn({ label, v, onChange, placeholder }) {
  return (
    <label className="text-xs text-slate-400 flex flex-col gap-1">{label}
      <input value={v} placeholder={placeholder} inputMode="decimal" onChange={(e) => onChange(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-24 text-slate-100" />
    </label>
  );
}