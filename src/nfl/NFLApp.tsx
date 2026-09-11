import React, { useState, useEffect, useMemo, useRef } from "react";

/* ============================================================
   NFL EDGE FINDER v1
   ------------------------------------------------------------
   Clone of MLB Edge Finder's engine/UI, rebuilt for football.
   Full methodology: ../../NFL_PROJECTION_MODELS.md — read that
   first; this file is the implementation of that spec.

   DATA (all browser-reachable, no paid key except the odds proxy
   which already exists in this project and is sport-agnostic):
     - site.api.espn.com / sports.core.api.espn.com : schedule,
       rosters, gamelogs, splits, injuries, depth charts, team
       stats/standings (the NFL equivalent of statsapi.mlb.com).
     - api.open-meteo.com : game-time weather at outdoor stadiums.
     - api.the-odds-api.com (via the EXISTING odds-proxy edge
       function, unmodified — it already just forwards path+query,
       so pointing it at americanfootball_nfl costs zero new code).
     - nflverse-data GitHub release CSVs (Next Gen Stats) via the
       NEW nfl-stats-proxy edge function — optional enhancer layer,
       same "contributes 1.00 if missing" posture as MLB's Statcast
       layer. Never a hard dependency.

   WHAT'S GENUINELY NEW VS THE MLB ENGINE (see doc §6):
     1. Game script (Vegas-spread-driven pass/rush volume shift).
     2. Graded weekly injury report -> player AND team adjustments.
     3. Weekly cadence (Slate keyed by week, not date) + bye weeks.
     4. Depth-chart-driven touch share for RB/WR.
     5. Ties are a real game-line outcome (rare, but real).

   Everything else below — the core math (Poisson/NegBin/Gamma
   Monte Carlo), the odds/calibration helpers, the Kelly stake
   sizing, the board-log-everything-then-settle-and-retune
   workflow — is sport-agnostic and ported from App.tsx unchanged.

   TABS: Slate · Board (categorized, sortable) · Player Analysis ·
   My Bets (tracked, editable odds, persisted) · Stats (win% / ROI).
   My Bets + Board Log persist to localStorage/IndexedDB, same as
   MLB, so this works outside Claude / in your own deploy.

   Structured edge-finder, not a money printer. Every prior below
   is a reasonable starting point, NOT a calibrated number — there
   is no settled-bet history for this engine yet. Retune CALIB_KEEP,
   the *_PHI dispersion constants, and the league-average priors
   once the Stats tab has real graded bets, exactly the way MLB's
   six months of calibration notes did.
   ============================================================ */

/* ---------- team + stadium reference (ESPN id-keyed, stable) ---------- */
const TEAMS = {
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
const ABBR_TO_NAME = Object.fromEntries(Object.values(TEAMS).map((t) => [t.ab, t.name]));
const ABBR_TO_ESPN_ID = Object.fromEntries(Object.entries(TEAMS).map(([id, t]) => [t.ab, +id]));
// search a board entry / tracked bet by player name, team abbrev, or team nickname
function matchesQuery(item, q) {
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
const STADIUMS = {
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
const LG_PPG = 22.0;          // league-avg points/team/game (prior — retune from settled Stats data)
const NFL_PTS_PHI = 6.5;      // team points variance ≈ NFL_PTS_PHI × mean (overdispersed, like MLB's RUNS_PHI=2.0 for runs)
const HOME_FIELD_MULT = { home: 1.015, away: 0.985 }; // small, well-documented NFL home edge (~1-1.5 pts on ~44 combined)
const LG_PLAYS_PER_GAME = 63.5; // league-avg offensive plays/team/game, for pace multiplier

/* ---------- prop + odds config ---------- */
const QB_PROPS = ["Pass Yards", "Pass TDs", "Interceptions", "Pass Completions", "Pass Attempts", "Longest Completion"];
const RB_PROPS = ["Rush Yards", "Rush TDs", "Receptions", "Receiving Yards", "Longest Rush"];
const WR_PROPS = ["Receptions", "Receiving Yards", "Receiving TDs", "Longest Reception"];
const TD_PROPS = ["Anytime TD"];
const K_PROPS = ["Kicking Points", "Field Goals Made"];
const DST_PROPS = ["Sacks", "Def. Interceptions"];
const ALL_PLAYER_PROPS = [...new Set([...QB_PROPS, ...RB_PROPS, ...WR_PROPS, ...TD_PROPS, ...K_PROPS, ...DST_PROPS])];
const DEFAULT_LINE = {
  "Pass Yards": "249.5", "Pass TDs": "1.5", "Interceptions": "0.5", "Pass Completions": "22.5", "Pass Attempts": "34.5", "Longest Completion": "23.5",
  "Rush Yards": "59.5", "Rush TDs": "0.5", "Longest Rush": "11.5",
  "Receptions": "4.5", "Receiving Yards": "54.5", "Receiving TDs": "0.5", "Longest Reception": "20.5",
  "Anytime TD": "0.5", "Kicking Points": "6.5", "Field Goals Made": "1.5", "Sacks": "2.5", "Def. Interceptions": "0.5",
};
const ODDS_SPORT = "americanfootball_nfl";
const ODDS_SPORT_PRESEASON = "americanfootball_nfl_preseason";
const TYPE_TO_MARKET = {
  "Pass Yards": "player_pass_yds", "Pass TDs": "player_pass_tds", "Interceptions": "player_pass_interceptions",
  "Pass Completions": "player_pass_completions", "Pass Attempts": "player_pass_attempts", "Longest Completion": "player_pass_longest_completion",
  "Rush Yards": "player_rush_yds", "Rush TDs": "player_rush_tds", "Longest Rush": "player_rush_longest",
  "Receptions": "player_receptions", "Receiving Yards": "player_reception_yds", "Receiving TDs": "player_reception_tds", "Longest Reception": "player_reception_longest",
  "Anytime TD": "player_anytime_td",
  "Kicking Points": "player_kicking_points", "Field Goals Made": "player_field_goals",
  "Sacks": "player_sacks", "Def. Interceptions": "player_defensive_interceptions",
};
const MARKET_TO_TYPE = Object.fromEntries(Object.entries(TYPE_TO_MARKET).map(([k, v]) => [v, k]));
const GAME_MARKETS = ["h2h", "spreads", "totals"];        // moneyline, spread, total — identical shape to MLB
const GAME_PROPS = ["Moneyline", "Spread", "Total"];
const CATEGORY_ORDER = [...QB_PROPS, ...RB_PROPS.filter((p) => !QB_PROPS.includes(p)), ...WR_PROPS.filter((p) => !RB_PROPS.includes(p) && !QB_PROPS.includes(p)), ...TD_PROPS, ...K_PROPS, ...DST_PROPS, ...GAME_PROPS];
const isLineType = (t) => GAME_PROPS.includes(t);
const BOOKS = [
  { key: "draftkings", label: "DraftKings" }, { key: "fanduel", label: "FanDuel" },
  { key: "betmgm", label: "BetMGM" }, { key: "caesars", label: "Caesars" },
  { key: "espnbet", label: "ESPN BET" }, { key: "fanatics", label: "Fanatics" },
];
const BOOK_LABELS = { ...Object.fromEntries(BOOKS.map((b) => [b.key, b.label])), manual: "Manual" };
const ODDS_TESTING_LIMIT = 400; // per-session safety rail against runaway loops — same rail as MLB

/* ---------- stake sizing (verbatim from MLB — sport-agnostic) ---------- */
const KELLY_FRACTION = 0.25;
const KELLY_BANKROLL_UNITS = 100;
const SUGGEST_MAX_UNITS = 3;
function suggestedUnits(modelP, odds) {
  if (modelP == null || isNaN(odds)) return 0;
  const b = odds > 0 ? odds / 100 : 100 / -odds;
  const ev = modelP * b - (1 - modelP);
  if (ev <= 0) return 0;
  const f = ev / b;
  const u = f * KELLY_BANKROLL_UNITS * KELLY_FRACTION;
  return clamp(Math.round(u * 4) / 4, 0, SUGGEST_MAX_UNITS);
}

/* ---------------------- core math (verbatim from MLB — sport-agnostic) ---------------------- */
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const fact = (n) => { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; };
const poiPmf = (k, l) => (l <= 0 ? (k === 0 ? 1 : 0) : Math.exp(-l) * Math.pow(l, k) / fact(k));
const poiCdf = (k, l) => { let s = 0; for (let i = 0; i <= k; i++) s += poiPmf(i, l); return s; };
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
function probabilityOver(family, line, side, seed, params) {
  let over;
  if (family === "poisson") over = 1 - poiCdf(Math.floor(line), params.mean);
  else over = runMonteCarlo(() => sampleNegBin(params.mean, params.phi), line, "over", seed);
  return side === "over" ? over : 1 - over;
}
function liveProbabilityOver(family, seed, params, currentTotal, line) {
  const adj = line - (currentTotal || 0);
  if (adj < 0) return 1;
  return probabilityOver(family, adj, "over", seed, params);
}

/* ---------------------- odds + format (verbatim from MLB — sport-agnostic) ---------------------- */
const impliedProb = (o) => (o < 0 ? -o / (-o + 100) : 100 / (o + 100));
const amToB = (o) => (o > 0 ? o / 100 : 100 / -o); // American odds -> decimal payout-per-$1, for comparing across the +/- boundary
const probToAmerican = (p) => { if (p <= 0 || p >= 1) return "—"; return p > 0.5 ? `-${Math.round((p / (1 - p)) * 100)}` : `+${Math.round(((1 - p) / p) * 100)}`; };
const evPerUnit = (p, o) => { const b = o > 0 ? o / 100 : 100 / -o; return p * b - (1 - p); };
// per-market calibration: DAY-1 PRIOR. MLB's per-category CALIB_KEEP values took months of
// settled bets to earn (see App.tsx's dated calibration log). We have no settled-bet history
// for football yet, so every category starts at a conservative, uniform "trust the market a lot"
// weight. Retune per-category from the Stats tab exactly the way MLB did — do NOT hand-tune
// these from vibes; wait for graded volume.
const CALIB_KEEP = {
  "Pass Yards": 0.45, "Pass TDs": 0.40, "Interceptions": 0.35, "Pass Completions": 0.45, "Pass Attempts": 0.45, "Longest Completion": 0.35,
  "Rush Yards": 0.45, "Rush TDs": 0.35, "Longest Rush": 0.35,
  "Receptions": 0.45, "Receiving Yards": 0.45, "Receiving TDs": 0.35, "Longest Reception": 0.35,
  "Anytime TD": 0.35, "Kicking Points": 0.40, "Field Goals Made": 0.40, "Sacks": 0.35, "Def. Interceptions": 0.30,
  "Spread": 0.50, "Total": 0.50,
};
const CALIB_KEEP_DEFAULT = 0.5;
function keepFor(type) { return (type != null && CALIB_KEEP[type] != null) ? CALIB_KEEP[type] : CALIB_KEEP_DEFAULT; }
function calibrateToMarket(p, market, type) { return (p == null || market == null) ? p : clamp(market + keepFor(type) * (p - market), 0.001, 0.999); }
const pct = (x) => (x == null || isNaN(x) ? "—" : `${(x * 100).toFixed(1)}%`);
const fmtOdds = (o) => (o == null ? "—" : (o > 0 ? `+${o}` : `${o}`));
function noVigProb(overOdds, underOdds, side) {
  if (overOdds == null && underOdds == null) return null;
  if (overOdds == null || underOdds == null) return impliedProb(side === "over" ? overOdds : underOdds);
  const io = impliedProb(overOdds), iu = impliedProb(underOdds), s = io + iu;
  const novigOver = s > 0 ? io / s : 0.5;
  return side === "over" ? novigOver : 1 - novigOver;
}

/* ============================================================
   TEAM SCORING MODEL — game lines (Moneyline / Spread / Total)
   Doc §2. Two-team Negative Binomial grid, same shape as MLB's
   gameProbs/jointGameProbs/marginProb over runs, generalized for
   NFL: bigger grid (points, not runs), and TIES are a real outcome
   (MLB has none). Live (in-progress) reduces "remaining" scoring
   by elapsed-game fraction, same as MLB's fractionRemaining.
   ============================================================ */
function teamPtsPmf(k, lambda) { return negativeBinomialPMF(k, Math.max(lambda, 1e-6), NFL_PTS_PHI); }
function gameProbs(lh, la) {
  const N = 66; let pH = 0, pA = 0, pT = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const pr = teamPtsPmf(i, lh) * teamPtsPmf(j, la);
    if (i > j) pH += pr; else if (j > i) pA += pr; else pT += pr;
  }
  return { home: pH, away: pA, tie: pT, totalLambda: lh + la };
}
// generalized for LIVE lines: final = current score + NegBin(remaining lambda) per team.
function jointGameProbs(lhEff, laEff, hc, ac, totalLine) {
  const N = 66; let pH = 0, pA = 0, pT = 0, over = 0, under = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const pr = teamPtsPmf(i, lhEff) * teamPtsPmf(j, laEff);
    const hs = hc + i, as = ac + j;
    if (hs > as) pH += pr; else if (as > hs) pA += pr; else pT += pr;
    if (totalLine != null) { const tot = hs + as; if (tot > totalLine) over += pr; else if (tot < totalLine) under += pr; }
  }
  return { home: pH, away: pA, tie: pT, over, under };
}
// P(final home-minus-away margin satisfies cmp) — powers the spread market.
function marginProb(lhEff, laEff, hc, ac, cmp) {
  const N = 66; let p = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    if (cmp((hc + i) - (ac + j))) p += teamPtsPmf(i, lhEff) * teamPtsPmf(j, laEff);
  }
  return p;
}

/* ============================================================
   SHRINKAGE HELPERS (verbatim from MLB — sport-agnostic)
   ============================================================ */
const blendRate = (seasonRate, recentRate, recentWeight) =>
  (recentRate == null || isNaN(recentRate)) ? seasonRate : seasonRate * (1 - recentWeight) + recentRate * recentWeight;
function shrinkRate(obsRate, n, prior, k) {
  if (!n) return prior;
  return (obsRate * n + prior * k) / (n + k);
}
function shrinkValue(obs, count, prior, k) {
  const o = isFinite(obs) ? obs : prior;
  return (o * (count || 0) + prior * k) / ((count || 0) + k);
}
// This player's own prior-season rate (numKey/denKey, e.g. passCmp/passAtt for completion %),
// falling back to the flat league default only when no prior-season log exists at all (a rookie,
// or a player ESPN has no gamelog history for). Used as the `prior` fed into shrinkRate/shrinkValue
// in place of a league-wide constant, so early-season sample thinness shrinks toward "this player's
// own career rate" instead of "average NFL player at this position" — the fix for every player at
// the same depth-chart slot projecting identically in week 1.
function priorRate(ctx, numKey, denKey, lgDefault) {
  const ps = ctx.priorSeason;
  if (!ps || !ps[denKey]) return lgDefault;
  return ps[numKey] / ps[denKey];
}
// Blend + shrink a player's own "longest play" history (season + recent, both averages — see
// fetchAthleteGamelog's avgLong) toward a prior, instead of the old ratio-of-other-stats approach
// that canceled out to one flat number for every player. Prefers this player's own prior-season
// long-play average when available; otherwise falls back to `fallbackPrior` (role-varying — WR1 vs
// slot vs TE, etc. — see callers), never a single league-wide constant.
function projectLongestStat(ctx, key, fallbackPrior) {
  const s = ctx.season || {}; const l = ctx.recent || null; const ps = ctx.priorSeason;
  const prior = (ps && ps[`${key}Avg`] != null) ? ps[`${key}Avg`] : fallbackPrior;
  const seasonAvg = s[`${key}Avg`] != null ? s[`${key}Avg`] : null;
  const seasonN = s[`${key}N`] || 0;
  const recentAvg = (l && l[`${key}Avg`] != null) ? l[`${key}Avg`] : null;
  const blended = blendRate(seasonAvg, recentAvg, RECENT_WEIGHT);
  return shrinkValue(blended, seasonN, prior, SHRINK_N.rate);
}

/* ============================================================
   PROJECTION ENGINE — per position (doc §3)
   ============================================================ */
const RECENT_WEIGHT = 0.30;       // L4-game blend weight — heavier than MLB's 0.20 L15 weight because
                                   // an NFL season (17 games) has far less season-to-date signal to lean on
const MIN_L4_SNAPS = 2;           // require >=2 recent games with snaps before blending recent form in
const NB_PHI = {                  // dispersion priors (var/mean) — DAY-1, retune from settled data
  passYds: 2.2, passAtt: 1.3, passCmp: 1.2, passTd: 1.4, ints: 1.3, longestCmp: 1.6,
  rushYds: 2.0, rushAtt: 1.3, rushTd: 1.5, longestRush: 1.8,
  rec: 1.6, recYds: 2.4, recTd: 1.5, longestRec: 1.8,
  anytimeTd: 1.4, kickPts: 1.7, fgMade: 1.3, sacks: 1.4, defInt: 1.4,
};

/* -------- league-average priors (empirical-Bayes shrinkage targets) --------
   Reasonable, well-known NFL per-game/per-attempt benchmarks. Exactly like
   MLB's LG_PRIOR block, these exist ONLY to stabilize thin samples (a rookie's
   first 2 starts, a backup thrust into action) — once a player has real volume,
   his own rate dominates via shrinkRate's sample-size weighting. */
const LG = {
  compPct: 0.65, ypa: 7.0, ypc_pass: 10.8,          // yards per completion (pass yards = completions × ypc_pass)
  passTdRate: 0.043, intRate: 0.020,                 // per pass attempt
  teamPassAtt: 33.5, teamRushAtt: 27.0,
  rushYpc: 4.2, rushTdRate: 0.028,                    // rush TDs per carry
  catchRate: 0.65, ypt: 8.0, recTdRate: 0.045,        // yards/TDs per target
  targetShareWR1: 0.22, targetShareWR2: 0.15, targetShareRB: 0.10,
  sackRatePerPassAtt: 0.065, defIntRatePerPassAtt: 0.021,
  fgAttPerDrive: 0.10, fgMakePct: 0.85,
  passYdsAllowedPerGame: 234.5, rushYdsAllowedPerGame: 113.4, // teamPassAtt*ypa, teamRushAtt*rushYpc — league-avg denominators for calculateOppDefenseAdjustment
};
const SHRINK_N = { passAtt: 4, rushAtt: 4, targets: 4, rate: 60 }; // "games" or "attempts" of prior weight

// -------- game script: Vegas-spread-driven pass/rush volume shift (NEW vs MLB) --------
// A team expected to trail passes more (garbage-time + catch-up), a team expected to
// lead runs more (clock control). Spread here is signed FOR the team in question
// (positive = team is an underdog by that many points, negative = favored).
function gameScriptPassMult(teamSpread) {
  if (teamSpread == null || isNaN(teamSpread)) return 1;
  return clamp(1 + clamp(teamSpread, -14, 14) * 0.008, 0.90, 1.10); // +14 dog -> ~1.10x pass volume; -14 fav -> ~0.90x
}
function gameScriptRushMult(teamSpread) {
  if (teamSpread == null || isNaN(teamSpread)) return 1;
  return clamp(1 - clamp(teamSpread, -14, 14) * 0.006, 0.92, 1.08); // favorites lean run to protect a lead
}

// -------- weather (doc §4) — wind/precip hit passing; cold has a small broad effect --------
function calculateWeatherAdjustmentPass(ctx) {
  const w = ctx.weather;
  if (!w || (ctx.stadium && ctx.stadium.dome)) return 1;
  let m = 1;
  if (w.wind != null) { if (w.wind >= 20) m -= 0.10; else if (w.wind >= 15) m -= 0.06; else if (w.wind >= 10) m -= 0.02; }
  if (w.temp != null && w.temp <= 25) m -= 0.03;
  if (w.pop != null && w.pop >= 60) m -= 0.04;
  return clamp(m, 0.80, 1.03);
}
function calculateWeatherAdjustmentRush(ctx) {
  const w = ctx.weather;
  if (!w || (ctx.stadium && ctx.stadium.dome)) return 1;
  let m = 1;
  // bad passing weather -> teams lean on the run more (shifts volume, not just efficiency)
  const passAdj = calculateWeatherAdjustmentPass(ctx);
  if (passAdj < 1) m += (1 - passAdj) * 0.5;
  return clamp(m, 1.0, 1.06);
}
function calculateWeatherAdjustmentKicking(ctx) {
  const w = ctx.weather;
  if (!w || (ctx.stadium && ctx.stadium.dome)) return 1;
  let m = 1;
  if (w.wind != null) { if (w.wind >= 20) m -= 0.12; else if (w.wind >= 15) m -= 0.07; else if (w.wind >= 10) m -= 0.03; }
  if (w.temp != null && w.temp <= 20) m -= 0.04;
  return clamp(m, 0.78, 1.0);
}

// -------- opponent defense adjustment (doc §4) --------
// yardsAllowedPerGame / TDsAllowedPerGame vs league average, snap-share weighted the way
// MLB blends starter-FIP with team-RA/G when the starter sample is thin (here: blend the
// specific-position-allowed rate with the team's overall defensive rate when thin).
function calculateOppDefenseAdjustment(oppAllowedRate, leagueAvgRate, lo = 0.75, hi = 1.30) {
  if (!oppAllowedRate || !leagueAvgRate) return 1;
  return clamp(oppAllowedRate / leagueAvgRate, lo, hi);
}

// -------- injury adjustment (doc §4, NEW vs MLB) --------
// status: "OUT" | "DOUBTFUL" | "QUESTIONABLE" | "IR" | null (healthy/no report)
function calculateInjuryAvailability(status) {
  if (status === "OUT" || status === "IR" || status === "SUSPENDED") return 0;      // excluded from slate, like an MLB scratch
  if (status === "DOUBTFUL") return 0.30;                                            // heavy shrink toward backup usage
  if (status === "QUESTIONABLE") return 0.85;                                        // light shrink
  return 1;
}

// -------- rest/travel adjustment (doc §4, NEW vs MLB — no baseball analog) --------
function calculateRestAdjustment(ctx) {
  let m = 1;
  if (ctx.shortWeek) m -= 0.02;         // Thursday game off a Sunday (≤4 days rest)
  if (ctx.crossCountryTravel) m -= 0.01; // long westward/eastward road trip, small documented effect
  if (ctx.onBye) m += 0.01;              // coming off a bye, fully rested
  return clamp(m, 0.95, 1.02);
}

/* ---- QB projections ---- */
function qbBaseRates(ctx) {
  const s = ctx.season || {}; const l = ctx.recent || null;
  const lOK = l && l.games >= MIN_L4_SNAPS;
  // Each `prior*` below is THIS player's own prior-season rate when ESPN has a log for him,
  // falling back to the flat league constant only for a rookie/no-history player — see priorRate().
  // This is what stops two different QBs from projecting identically in week 1.
  const priorPassAtt = priorRate(ctx, "passAtt", "g", LG.teamPassAtt * 0.98);
  const priorCompPct = priorRate(ctx, "passCmp", "passAtt", LG.compPct);
  const priorYpc = priorRate(ctx, "passYds", "passCmp", LG.ypa / LG.compPct);
  const priorPassTdRate = priorRate(ctx, "passTd", "passAtt", LG.passTdRate);
  const priorIntRate = priorRate(ctx, "ints", "passAtt", LG.intRate);
  const passAttRaw = blendRate(s.passAtt && s.g ? s.passAtt / s.g : priorPassAtt, lOK ? l.passAtt / l.games : null, RECENT_WEIGHT);
  const passAtt = shrinkValue(passAttRaw, s.g || 0, priorPassAtt, SHRINK_N.passAtt);
  const compPct = shrinkRate(s.passAtt ? s.passCmp / s.passAtt : 0, s.passAtt || 0, priorCompPct, SHRINK_N.rate);
  const ypc = shrinkRate(s.passCmp ? s.passYds / s.passCmp : 0, s.passCmp || 0, priorYpc, SHRINK_N.rate);
  const passTdRate = shrinkRate(s.passAtt ? s.passTd / s.passAtt : 0, s.passAtt || 0, priorPassTdRate, SHRINK_N.rate);
  const intRate = shrinkRate(s.passAtt ? s.ints / s.passAtt : 0, s.passAtt || 0, priorIntRate, SHRINK_N.rate);
  return { passAtt, compPct, ypc, passTdRate, intRate };
}
function projectQB(ctx, type, line) {
  const base = qbBaseRates(ctx);
  const gs = gameScriptPassMult(ctx.teamSpread);
  const wx = calculateWeatherAdjustmentPass(ctx);
  const oppPass = calculateOppDefenseAdjustment(ctx.oppPassYdsAllowed, ctx.lgPassYdsAllowed);
  const oppTd = calculateOppDefenseAdjustment(ctx.oppPassTdAllowed, ctx.lgPassTdAllowed);
  const oppInt = calculateOppDefenseAdjustment(ctx.oppDefTakeaways, ctx.lgDefTakeaways, 0.8, 1.25);
  const avail = calculateInjuryAvailability(ctx.injuryStatus);
  const rest = calculateRestAdjustment(ctx);
  const passAtt = base.passAtt * gs * rest * avail;
  const passCmp = passAtt * base.compPct * clamp(oppPass, 0.85, 1.15);
  const passYds = passCmp * base.ypc * wx * oppPass;
  const passTd = passAtt * base.passTdRate * oppTd;
  const ints = passAtt * base.intRate * oppInt * clamp(2 - wx, 0.95, 1.15); // bad weather -> more picks
  const table = {
    "Pass Attempts": { mean: passAtt, phi: NB_PHI.passAtt },
    "Pass Completions": { mean: passCmp, phi: NB_PHI.passCmp },
    "Pass Yards": { mean: passYds, phi: NB_PHI.passYds },
    "Pass TDs": { mean: passTd, phi: NB_PHI.passTd },
    "Interceptions": { mean: ints, phi: NB_PHI.ints },
    "Longest Completion": { mean: clamp(projectLongestStat(ctx, "longCmp", 34), 8, 60), phi: NB_PHI.longestCmp },
  };
  const t = table[type]; if (!t) return { pOver: null, proj: null, calc: null };
  const seed = hashSeed(`qb|${type}|${line}|${passAtt.toFixed(2)}`);
  const pOver = probabilityOver("nb", line, "over", seed, t);
  return { pOver, proj: t.mean, calc: fullCalc("Neg.Binom", `μ=${t.mean.toFixed(2)}, φ=${t.phi}`, t.mean, `${base.passAtt.toFixed(1)} att/g season base`, [["game script", gs], ["weather", wx], ["opp pass D", oppPass], ["opp pass TD", oppTd], ["availability", avail], ["rest", rest]]) };
}

/* ---- RB projections ---- */
function rbBaseRates(ctx) {
  const s = ctx.season || {}; const l = ctx.recent || null;
  const lOK = l && l.games >= MIN_L4_SNAPS;
  const lgRushAtt = LG.teamRushAtt * (ctx.touchShare || 0.4), lgTargets = LG.targetShareRB * LG.teamPassAtt;
  const priorRushAtt = priorRate(ctx, "rushAtt", "g", lgRushAtt);
  const priorYpc = priorRate(ctx, "rushYds", "rushAtt", LG.rushYpc);
  const priorRushTdRate = priorRate(ctx, "rushTd", "rushAtt", LG.rushTdRate);
  const priorTargets = priorRate(ctx, "targets", "g", lgTargets);
  const priorCatchRate = priorRate(ctx, "rec", "targets", LG.catchRate + 0.05);
  const priorYpt = priorRate(ctx, "recYds", "targets", LG.ypt * 0.7);
  const rushAttRaw = blendRate(s.rushAtt && s.g ? s.rushAtt / s.g : priorRushAtt, lOK ? l.rushAtt / l.games : null, RECENT_WEIGHT);
  const rushAtt = shrinkValue(rushAttRaw, s.g || 0, priorRushAtt, SHRINK_N.rushAtt);
  const ypc = shrinkRate(s.rushAtt ? s.rushYds / s.rushAtt : 0, s.rushAtt || 0, priorYpc, SHRINK_N.rate);
  const rushTdRate = shrinkRate(s.rushAtt ? s.rushTd / s.rushAtt : 0, s.rushAtt || 0, priorRushTdRate, SHRINK_N.rate);
  const targetsRaw = blendRate(s.targets && s.g ? s.targets / s.g : priorTargets, lOK ? l.targets / l.games : null, RECENT_WEIGHT);
  const targets = shrinkValue(targetsRaw, s.g || 0, priorTargets, SHRINK_N.targets);
  const catchRate = shrinkRate(s.targets ? s.rec / s.targets : 0, s.targets || 0, priorCatchRate, SHRINK_N.rate); // RBs catch a slightly higher % of (shorter) targets
  const ypt = shrinkRate(s.targets ? s.recYds / s.targets : 0, s.targets || 0, priorYpt, SHRINK_N.rate); // RB targets are shorter-developing than WR targets
  return { rushAtt, ypc, rushTdRate, targets, catchRate, ypt };
}
function projectRB(ctx, type, line) {
  const base = rbBaseRates(ctx);
  const gsRush = gameScriptRushMult(ctx.teamSpread);
  const gsPass = gameScriptPassMult(ctx.teamSpread); // RB receiving work rides the team's pass-volume game script
  const wxRush = calculateWeatherAdjustmentRush(ctx);
  const wxPass = calculateWeatherAdjustmentPass(ctx);
  const oppRun = calculateOppDefenseAdjustment(ctx.oppRushYdsAllowed, ctx.lgRushYdsAllowed);
  const oppRunTd = calculateOppDefenseAdjustment(ctx.oppRushTdAllowed, ctx.lgRushTdAllowed);
  const oppPass = calculateOppDefenseAdjustment(ctx.oppPassYdsAllowedToRB, ctx.lgPassYdsAllowedToRB);
  const avail = calculateInjuryAvailability(ctx.injuryStatus);
  const rest = calculateRestAdjustment(ctx);
  const rushAtt = base.rushAtt * gsRush * wxRush * rest * avail * (ctx.touchShareMult || 1);
  const rushYds = rushAtt * base.ypc * clamp(oppRun, 0.8, 1.25);
  const rushTd = rushAtt * base.rushTdRate * clamp(oppRunTd, 0.75, 1.35) * (ctx.goalLineShareMult || 1);
  const targets = base.targets * gsPass * rest * avail;
  const rec = targets * base.catchRate;
  const recYds = targets * base.ypt * wxPass * oppPass;
  // RB1s (lead back, more explosive-run volume) break longer runs on average than a committee
  // RB2/change-of-pace back — role-varying prior instead of one flat number for every runner.
  const longRushPrior = ctx.depthRank === 1 ? 14 : 11;
  const table = {
    "Rush Yards": { mean: rushYds, phi: NB_PHI.rushYds },
    "Rush TDs": { mean: rushTd, phi: NB_PHI.rushTd },
    "Longest Rush": { mean: clamp(projectLongestStat(ctx, "longRush", longRushPrior), 4, 40), phi: NB_PHI.longestRush },
    "Receptions": { mean: rec, phi: NB_PHI.rec },
    "Receiving Yards": { mean: recYds, phi: NB_PHI.recYds },
  };
  const t = table[type]; if (!t) return { pOver: null, proj: null, calc: null };
  const seed = hashSeed(`rb|${type}|${line}|${rushAtt.toFixed(2)}`);
  const pOver = probabilityOver("nb", line, "over", seed, t);
  return { pOver, proj: t.mean, calc: fullCalc("Neg.Binom", `μ=${t.mean.toFixed(2)}, φ=${t.phi}`, t.mean, `${base.rushAtt.toFixed(1)} car/g season base`, [["game script", gsRush], ["weather", wxRush], ["opp run D", oppRun], ["touch share", ctx.touchShareMult || 1], ["availability", avail]]) };
}

/* ---- WR/TE projections ---- */
function wrBaseRates(ctx) {
  const s = ctx.season || {}; const l = ctx.recent || null;
  const lOK = l && l.games >= MIN_L4_SNAPS;
  const shareDefault = ctx.pos === "TE" ? 0.14 : (ctx.depthRank === 1 ? LG.targetShareWR1 : ctx.depthRank === 2 ? LG.targetShareWR2 : 0.10);
  const lgTargets = LG.teamPassAtt * shareDefault;
  const priorTargets = priorRate(ctx, "targets", "g", lgTargets);
  const priorCatchRate = priorRate(ctx, "rec", "targets", LG.catchRate);
  const priorYpt = priorRate(ctx, "recYds", "targets", LG.ypt);
  const priorRecTdRate = priorRate(ctx, "recTd", "targets", LG.recTdRate);
  const targetsRaw = blendRate(s.targets && s.g ? s.targets / s.g : priorTargets, lOK ? l.targets / l.games : null, RECENT_WEIGHT);
  const targets = shrinkValue(targetsRaw, s.g || 0, priorTargets, SHRINK_N.targets);
  const catchRate = shrinkRate(s.targets ? s.rec / s.targets : 0, s.targets || 0, priorCatchRate, SHRINK_N.rate);
  const ypt = shrinkRate(s.targets ? s.recYds / s.targets : 0, s.targets || 0, priorYpt, SHRINK_N.rate);
  const recTdRate = shrinkRate(s.targets ? s.recTd / s.targets : 0, s.targets || 0, priorRecTdRate, SHRINK_N.rate);
  return { targets, catchRate, ypt, recTdRate };
}
function projectWR(ctx, type, line) {
  const base = wrBaseRates(ctx);
  const gs = gameScriptPassMult(ctx.teamSpread);
  const wx = calculateWeatherAdjustmentPass(ctx);
  const oppYds = calculateOppDefenseAdjustment(ctx.oppPassYdsAllowedToPos, ctx.lgPassYdsAllowedToPos);
  const oppTd = calculateOppDefenseAdjustment(ctx.oppPassTdAllowedToPos, ctx.lgPassTdAllowedToPos);
  const avail = calculateInjuryAvailability(ctx.injuryStatus);
  const rest = calculateRestAdjustment(ctx);
  const targets = base.targets * gs * rest * avail * (ctx.injuredTeammateBoost || 1); // a hurt WR1 bumps WR2/3 target share
  const rec = targets * base.catchRate;
  const recYds = targets * base.ypt * wx * oppYds;
  const recTd = targets * base.recTdRate * oppTd * (ctx.redZoneShareMult || 1);
  // Prior varies by role instead of being one flat constant — a WR1 or a deep-threat's long catches
  // run meaningfully longer than a possession-slot guy's or a TE's, even before real data comes in.
  const longRecPrior = ctx.pos === "TE" ? 24 : (ctx.depthRank === 1 ? 32 : ctx.depthRank === 2 ? 27 : 22);
  const table = {
    "Receptions": { mean: rec, phi: NB_PHI.rec },
    "Receiving Yards": { mean: recYds, phi: NB_PHI.recYds },
    "Receiving TDs": { mean: recTd, phi: NB_PHI.recTd },
    "Longest Reception": { mean: clamp(projectLongestStat(ctx, "longRec", longRecPrior), 8, 55), phi: NB_PHI.longestRec },
  };
  const t = table[type]; if (!t) return { pOver: null, proj: null, calc: null };
  const seed = hashSeed(`wr|${type}|${line}|${targets.toFixed(2)}`);
  const pOver = probabilityOver("nb", line, "over", seed, t);
  return { pOver, proj: t.mean, calc: fullCalc("Neg.Binom", `μ=${t.mean.toFixed(2)}, φ=${t.phi}`, t.mean, `${base.targets.toFixed(1)} tgt/g season base`, [["game script", gs], ["weather", wx], ["opp pass D vs pos", oppYds], ["availability", avail], ["target-share boost", ctx.injuredTeammateBoost || 1]]) };
}

// -------- Anytime TD: union of a player's rushing-TD and receiving-TD probability --------
// P(>=1 TD) = 1 - P(0 rush TD) x P(0 rec TD), each from that player's own NB(mean,phi) above.
function projectAnytimeTD(ctx) {
  let pNoRush = 1, pNoRec = 1, pNoPass = 1;
  if (ctx.pos === "RB" || ctx.pos === "QB") { const r = ctx.pos === "QB" ? { proj: 0 } : projectRB(ctx, "Rush TDs", -1); pNoRush = 1 - negativeBinomialCDFComplement(r.proj, NB_PHI.rushTd); }
  if (ctx.pos !== "K" && ctx.pos !== "DST") { const r = projectWR(ctx, "Receiving TDs", -1); pNoRec = 1 - negativeBinomialCDFComplement(r.proj, NB_PHI.recTd); }
  const pAtLeastOne = 1 - pNoRush * pNoRec * pNoPass;
  return clamp(pAtLeastOne, 0.001, 0.98);
}
function negativeBinomialCDFComplement(mean, phi) { return mean ? (1 - negativeBinomialPMF(0, mean, phi)) : 0; } // P(>=1) shortcut

/* ---- Kicker projections ---- */
function projectKicker(ctx, type, line) {
  const impliedTeamPts = ctx.impliedTeamPts != null ? ctx.impliedTeamPts : LG_PPG;
  const rzTdRate = ctx.redZoneTdRate != null ? ctx.redZoneTdRate : 0.58; // share of red-zone trips that end in a TD (not a FG)
  const wxK = calculateWeatherAdjustmentKicking(ctx);
  const drives = ctx.teamDrivesPerGame || 10.8;
  const fgAtt = drives * LG.fgAttPerDrive * (1 + (0.58 - rzTdRate)) * wxK; // fewer RZ TDs -> more FG tries, all else equal
  const fgMakePct = clamp(LG.fgMakePct * wxK, 0.65, 0.95);
  const fgMade = fgAtt * fgMakePct;
  const xpMade = clamp(impliedTeamPts / 7 * (1 - (1 - rzTdRate) * 0.3), 0, 5); // rough TD-count proxy for extra points
  const kickPts = fgMade * 3 + xpMade;
  const table = {
    "Kicking Points": { mean: kickPts, phi: NB_PHI.kickPts },
    "Field Goals Made": { mean: fgMade, phi: NB_PHI.fgMade },
  };
  const t = table[type]; if (!t) return { pOver: null, proj: null, calc: null };
  const seed = hashSeed(`k|${type}|${line}|${fgMade.toFixed(2)}`);
  const pOver = probabilityOver("nb", line, "over", seed, t);
  return { pOver, proj: t.mean, calc: fullCalc("Neg.Binom", `μ=${t.mean.toFixed(2)}, φ=${t.phi}`, t.mean, `${impliedTeamPts.toFixed(1)} implied team pts`, [["weather", wxK], ["RZ TD rate", rzTdRate]]) };
}

/* ---- DST (team defense) projections ---- */
function projectDST(ctx, type, line) {
  const oppPassAtt = ctx.oppPassAtt != null ? ctx.oppPassAtt : LG.teamPassAtt;
  const sackRate = ctx.teamSackRate != null ? ctx.teamSackRate : LG.sackRatePerPassAtt;
  const intRate = ctx.teamDefIntRate != null ? ctx.teamDefIntRate : LG.defIntRatePerPassAtt;
  const oppOlineMult = clamp(ctx.oppSackRateAllowed && ctx.lgSackRateAllowed ? ctx.oppSackRateAllowed / ctx.lgSackRateAllowed : 1, 0.75, 1.3);
  const oppQbIntMult = clamp(ctx.oppQbIntRate && ctx.lgQbIntRate ? ctx.oppQbIntRate / ctx.lgQbIntRate : 1, 0.75, 1.3);
  const sacks = oppPassAtt * sackRate * oppOlineMult;
  const ints = oppPassAtt * intRate * oppQbIntMult;
  const table = { "Sacks": { mean: sacks, phi: NB_PHI.sacks }, "Def. Interceptions": { mean: ints, phi: NB_PHI.defInt } };
  const t = table[type]; if (!t) return { pOver: null, proj: null, calc: null };
  const seed = hashSeed(`dst|${type}|${line}|${sacks.toFixed(2)}`);
  const pOver = probabilityOver("nb", line, "over", seed, t);
  return { pOver, proj: t.mean, calc: fullCalc("Neg.Binom", `μ=${t.mean.toFixed(2)}, φ=${t.phi}`, t.mean, `opp ${oppPassAtt.toFixed(1)} pass att/g`, [["opp O-line (sack allowed)", oppOlineMult], ["opp QB INT rate", oppQbIntMult]]) };
}

/* ---- dispatch: route a (position, propType) pair to its projector ---- */
function projectProp(ctx, type, line) {
  ctx = ctx || {};
  if (type === "Anytime TD") {
    const p = projectAnytimeTD(ctx);
    return { pOver: p, proj: p, calc: fullCalc("Union·NB", "1-P(no rush TD)×P(no rec TD)", p, "anytime TD probability", []) };
  }
  if (QB_PROPS.includes(type) && ctx.pos === "QB") return projectQB(ctx, type, line);
  if ((RB_PROPS.includes(type)) && ctx.pos === "RB") return projectRB(ctx, type, line);
  if ((WR_PROPS.includes(type)) && (ctx.pos === "WR" || ctx.pos === "TE")) return projectWR(ctx, type, line);
  if (K_PROPS.includes(type) && ctx.pos === "K") return projectKicker(ctx, type, line);
  if (DST_PROPS.includes(type) && ctx.pos === "DST") return projectDST(ctx, type, line);
  return { pOver: null, proj: null, calc: null };
}
function fullCalc(dist, params, proj, baseStr, mults) { return { dist, params, proj, baseStr, mults, live: null }; }
function liveCalc(dist, params, current, projFinal, baseStr, fr) { return { dist, params, proj: projFinal, baseStr, mults: [], live: { current, fr } }; }

/* full evaluation of a single priced bet (model + market) — verbatim from MLB */
function evalBet(b, pre) {
  const { pOver, proj, calc } = pre || projectProp(b.ctx, b.type, parseFloat(b.line));
  const rawP = b.side === "over" ? pOver : 1 - pOver;
  const odds = Number(b.odds);
  const imp = isNaN(odds) ? null : impliedProb(odds);
  const novig = (b.overOdds != null || b.underOdds != null) ? noVigProb(b.overOdds, b.underOdds, b.side) : imp;
  const fairRef = novig != null ? novig : imp;
  const modelP = calibrateToMarket(rawP, fairRef, b.type);
  const bmult = isNaN(odds) ? 0 : (odds > 0 ? odds / 100 : 100 / -odds);
  const edge = (modelP != null && fairRef != null) ? modelP - fairRef : null;
  const ev = (modelP != null && !isNaN(odds)) ? evPerUnit(modelP, odds) : null;
  return { modelP, rawModelP: rawP, proj, calc, imp, novig, edge, ev, b: bmult, fair: modelP != null ? probToAmerican(modelP) : "—", devigged: b.overOdds != null && b.underOdds != null };
}

/* ============================================================
   DATA LAYER — ESPN hidden API (doc §1)
   Shapes verified live against site.api.espn.com / sports.core.api.espn.com
   in Aug 2026. Every parser is column/shape-TOLERANT (mirrors the MLB
   app's lbPick/scanForKeys philosophy for Statcast leaderboards): if a
   field renames or a nesting shifts, we degrade to a league prior
   instead of throwing. Nothing here is a hard dependency.
   ============================================================ */
const ESPN_SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const ESPN_WEB = "https://site.web.api.espn.com/apis/common/v3/sports/football/nfl";
const ESPN_CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";
async function jget(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status}`); return r.json(); }
function refId(ref) {
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
function classify(comp) {
  const st = comp && comp.status && comp.status.type;
  if (!st) return "SCHEDULED";
  if (st.completed) return "FINAL";
  if (st.state === "in") return "LIVE";
  return "SCHEDULED"; // pregame — NFL doesn't post an official "lineup" the way MLB does; injuries/depth-chart stand in
}
function mapGame(ev) {
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
async function fetchSchedule(seasonType, week, year) {
  const d = await jget(`${ESPN_SITE}/scoreboard?seasontype=${seasonType}&week=${week}&year=${year}`);
  return (d.events || []).map(mapGame);
}
function currentWeekGuess(today = new Date()) {
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
async function fetchCurrentWeek(now = new Date()) {
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
async function fetchRoster(teamId) {
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
function espnIdForTeamName(fullName) {
  if (!fullName) return null;
  const s = fullName.trim();
  for (const id in TEAMS) if (s.endsWith(TEAMS[id].name)) return +id;
  return null;
}
async function searchPlayers(query) {
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
async function fetchDepthChart(teamId, year) {
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
function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }
// stat-name aliases: ESPN's `names` array wording drifts by season; match tolerantly.
const STAT_ALIASES = {
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
const LONG_KEYS = ["longRec", "longRush", "longCmp"]; // gated-average, not summed, in fetchAthleteGamelog
function pickAlias(names, key) {
  const cands = STAT_ALIASES[key] || [key];
  for (const c of cands) { const i = names.findIndex((n) => String(n).toLowerCase() === c.toLowerCase()); if (i >= 0) return i; }
  return -1;
}
const GAMELOG_ROWS = 8; // cap for the "Last N Games" log table (5-10 games, per product ask)
// Pulls the { eventId -> {statKey: number} } map of REAL per-game stat values out of a gamelog
// response. Verified live against ESPN (Sept 2026): the per-game numbers do NOT live under
// `d.events` at all — that dict is metadata-only (week/date/opponent/score/team, no numbers
// whatsoever). The actual values live under `d.seasonTypes[].categories[].events[eventId].stats`,
// a parallel dict keyed by the SAME event ids, indexed positionally against `d.names` (so
// `stats[idx["longCmp"]]` is that game's longest completion, etc). A player can in principle carry
// more than one category (e.g. separate splits) — merge them per event rather than assuming one.
// This replaces an earlier version of this function that searched `d.events` for stat arrays;
// that search always came up empty against the real API shape, so every player's season/recent
// stats were silently falling back to the league-average prior for everyone, and settlement
// look-ups (below) always returned null.
function statsByEventFromGamelog(d, idx) {
  const out = {};
  for (const st of d.seasonTypes || []) {
    for (const cat of st.categories || []) {
      const ev = cat.events;
      if (!ev || typeof ev !== "object") continue;
      for (const eid in ev) {
        const row = ev[eid];
        if (!row || !row.stats) continue;
        const rec = (out[eid] = out[eid] || {});
        for (const k in idx) if (idx[k] >= 0 && row.stats[idx[k]] != null) rec[k] = num(row.stats[idx[k]]);
      }
    }
  }
  return out;
}
async function fetchAthleteGamelog(athleteId, n = 4, season = null) {
  try {
    const url = `${ESPN_WEB}/athletes/${athleteId}/gamelog` + (season ? `?season=${season}` : "");
    const d = await jget(url);
    const names = d.names || [];
    if (!names.length) return null;
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
    const season = sum(all); season.g = all.length;
    for (const k of LONG_KEYS) { const { avg, n: cnt } = avgLong(all, k); season[`${k}Avg`] = avg; season[`${k}N`] = cnt; }
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

    return { season, recent, games };
  } catch { return null; }
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
async function fetchLongCmpForEvent(athleteId, eventId, season = null) {
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
      console.warn(tag, "event id not found in seasonTypes[].categories[].events — known event ids:", Object.keys(statsByEvent));
      return null;
    }
    return row.longCmp;
  } catch (err) { console.warn(tag, "fetch/parse threw:", err); return null; }
}

/* ---- team season stats: offense (own production) + defense (allowed) ---- */
function pickCat(categories, wantNames) {
  const out = {};
  for (const cat of categories || []) {
    for (const s of cat.stats || []) {
      const nm = String(s.name || "").toLowerCase();
      for (const want of wantNames) if (nm === want.toLowerCase() && out[want] == null) out[want] = numOrNull(s.value);
    }
  }
  return out;
}
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
async function fetchTeamStats(teamId) {
  try {
    const d = await jget(`${ESPN_SITE}/teams/${teamId}/statistics`);
    const categories = (d.results && d.results.stats && d.results.stats.categories) || d.splits && d.splits.categories || d.categories || [];
    const off = pickCat(categories, ["netPassingYardsPerGame", "rushingYardsPerGame", "yardsPerGame", "totalPointsPerGame", "netPassingYards", "rushingYards"]);
    const def = pickCat(categories, ["yardsAllowedPerGame", "netPassingYardsAllowedPerGame", "rushingYardsAllowedPerGame", "sackRate", "totalSacks", "interceptions"]);
    return { off, def, raw: categories.length > 0 };
  } catch { return { off: {}, def: {}, raw: false }; }
}
/* ---- standings: points for/against per team (primary game-line input — always reliable) ---- */
async function fetchStandings(year) {
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
async function fetchWeather(lat, lon) {
  try {
    const d = await jget(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation_probability,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=3&timezone=auto`);
    const i = new Date().getHours(); const h = d.hourly;
    return { temp: Math.round(h.temperature_2m && h.temperature_2m[i]), pop: h.precipitation_probability && h.precipitation_probability[i], wind: Math.round(h.wind_speed_10m && h.wind_speed_10m[i]) };
  } catch { return null; }
}

/* ---- boxscore (settling tracked bets) ---- */
async function fetchGameSummary(eventId) {
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
// Supabase project config — same project as MLB (one Supabase backend, both sports share
// the anon key and the odds-proxy function). See INTEGRATION.md for where this comes from.
const SUPABASE_URL = "https://jkpctgapbsyzqjfiiuoe.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprcGN0Z2FwYnN5enFqZmlpdW9lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4NzE5MDMsImV4cCI6MjEwMzQ0NzkwM30.9UT8ILqf6Xpk9LNangxZKfQZmv6Woa7WlbzRVyxdttg";
const ODDS_PROXY_URL = `${SUPABASE_URL}/functions/v1/odds-proxy`;
const NFL_PROXY_URL = `${SUPABASE_URL}/functions/v1/nfl-stats-proxy`;

function normName(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z ]/g, " ").replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/\s+/g, " ").trim();
}
function oddsProxyFetch(path, query) {
  const url = `${ODDS_PROXY_URL}?path=${encodeURIComponent(path)}&query=${encodeURIComponent(query)}`;
  return fetch(url, { headers: { apikey: SUPABASE_ANON_KEY } });
}
async function fetchOddsEvents(sportKey) {
  const r = await oddsProxyFetch(`/sports/${sportKey}/events`, "dateFormat=iso");
  const remaining = r.headers.get("x-requests-remaining");
  if (!r.ok) throw new Error(`events ${r.status}`);
  const data = await r.json();
  return { events: data || [], remaining: remaining != null ? +remaining : null };
}
async function fetchEventOdds(sportKey, eventId, book) {
  const markets = [...Object.values(TYPE_TO_MARKET), ...GAME_MARKETS].join(",");
  const r = await oddsProxyFetch(`/sports/${sportKey}/events/${eventId}/odds`, `regions=us&markets=${markets}&oddsFormat=american&bookmakers=${book}`);
  const remaining = r.headers.get("x-requests-remaining");
  if (!r.ok) throw new Error(`odds ${r.status}`);
  const data = await r.json();
  return { data, remaining: remaining != null ? +remaining : null };
}
function matchEvent(events, g) {
  const hn = normName(g.homeName), an = normName(g.awayName);
  return (events || []).find((e) => normName(e.home_team).includes(hn) && normName(e.away_team).includes(an));
}
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
function matchCurrentOdds(bet, rows, gl) {
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
function buildGameLineEntries(g, d, gl, book) {
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

/* ============================================================
   PERSISTENCE — My Bets (localStorage) + Board Log (IndexedDB),
   ported from MLB's storage layer verbatim (prefix renamed nfl*).
   ============================================================ */
const MODEL_VERSION = "nfl-v1-2026-08";
const LS_BETS = "nfief_mybets_v1";
function loadBets() { try { return JSON.parse(localStorage.getItem(LS_BETS)) || []; } catch { return []; } }
function saveBets(b) { try { localStorage.setItem(LS_BETS, JSON.stringify(b)); } catch { /* storage unavailable */ } }
const LS_CREDITS = "nfief_credits_v1";
function loadCredits() { try { const v = localStorage.getItem(LS_CREDITS); return v == null || v === "" ? null : +v; } catch { return null; } }

const BOARD_LOG_MAX_ROWS = 100000;
const BOARD_LOG_RETENTION_DAYS = 60;
const BOARD_DB_NAME = "nfief_boardlog_db";
const BOARD_DB_STORE = "kv";
const BOARD_DB_KEY = "boardLog";
let boardLogCache = [];
let boardLogSaveError = null;
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BOARD_DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(BOARD_DB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) { const db = await idbOpen(); try { return await new Promise((resolve, reject) => { const req = db.transaction(BOARD_DB_STORE, "readonly").objectStore(BOARD_DB_STORE).get(key); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); } finally { db.close(); } }
async function idbSet(key, val) { const db = await idbOpen(); try { await new Promise((resolve, reject) => { const tx = db.transaction(BOARD_DB_STORE, "readwrite"); tx.objectStore(BOARD_DB_STORE).put(val, key); tx.oncomplete = () => resolve(undefined); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted")); }); } finally { db.close(); } }
const boardLogReady = (async () => {
  try { const rows = await idbGet(BOARD_DB_KEY); boardLogCache = Array.isArray(rows) ? rows : []; }
  catch (err) { boardLogSaveError = `Board log storage unavailable: ${String((err && err.message) || err)}`; }
  return boardLogCache;
})();
function loadBoardLog() { return boardLogCache; }
function saveBoardLog(log) { boardLogCache = log; idbSet(BOARD_DB_KEY, log).then(() => { boardLogSaveError = null; }).catch((err) => { boardLogSaveError = `Board log save FAILED: ${String((err && err.message) || err)}`; }); }
function getBoardLogSaveError() { return boardLogSaveError; }
async function appendBoardLog(entries, modelVersion, weekKey) {
  if (!entries || !entries.length) return;
  await boardLogReady;
  const existing = loadBoardLog();
  const existingIds = new Set(existing.map((e) => e.logId));
  const now = new Date().toISOString();
  const cutoffMs = Date.now() - BOARD_LOG_RETENTION_DAYS * 86400000;
  // logId has no timestamp component (it's deterministic per week+bet), so a bet already
  // logged this week is deliberately frozen at its first-seen snapshot rather than overwritten
  // on every refresh. That means a field added AFTER a bet was already logged (gameTimeIso)
  // can never reach an already-logged row via the "new row" path — backfill just that field.
  const existingById = new Map(existing.map((e) => [e.logId, e]));
  let backfilled = 0;
  for (const e of entries) {
    const already = existingById.get(`${weekKey}|${e.id}`);
    if (already && !already.gameTimeIso && e.gameTimeIso) { already.gameTimeIso = e.gameTimeIso; backfilled++; }
  }
  const newRows = entries.filter((e) => e.modelP != null && e.novig != null).map((e) => {
    const logId = `${weekKey}|${e.id}`;
    return {
      logId, loggedAt: now, modelVersion, week: weekKey,
      game: e.game, gameTimeIso: e.gameTimeIso || null, gamePk: String(e.gamePk), playerId: String(e.playerId ?? ""), name: e.name, type: e.type, line: e.line, side: e.side, odds: e.odds,
      novig: e.novig != null ? +e.novig.toFixed(4) : null, rawModelP: e.rawModelP != null ? +e.rawModelP.toFixed(4) : null,
      calibratedP: e.modelP != null ? +e.modelP.toFixed(4) : null, edge: e.edge != null ? +e.edge.toFixed(4) : null, ev: e.ev != null ? +e.ev.toFixed(4) : null, proj: e.proj != null ? +e.proj.toFixed(3) : null,
      settled: false, actualStat: null, result: null,
    };
  }).filter((e) => !existingIds.has(e.logId));
  if (!newRows.length) { if (backfilled) saveBoardLog(existing); return; }
  const merged = [...existing, ...newRows].filter((e) => { try { return Date.parse(e.loggedAt) >= cutoffMs; } catch { return true; } });
  saveBoardLog(merged.length > BOARD_LOG_MAX_ROWS ? merged.slice(-BOARD_LOG_MAX_ROWS) : merged);
}
async function settleBoardLog(settledBets) {
  if (!settledBets || !settledBets.length) return;
  await boardLogReady;
  const log = loadBoardLog();
  if (!log.length) return;
  const lookup = {};
  for (const b of settledBets) { if (b.status === "open") continue; const key = `${b.week}|${b.gamePk}|${b.playerId}|${b.type}|${b.line}|${b.side}`; lookup[key] = { actual: b.actual, result: b.status }; }
  let changed = false;
  const updated = log.map((e) => {
    if (e.settled) return e;
    const key = `${e.week}|${e.gamePk}|${e.playerId}|${e.type}|${e.line}|${e.side}`;
    const hit = lookup[key]; if (!hit) return e;
    changed = true; return { ...e, settled: true, actualStat: hit.actual, result: hit.result };
  });
  if (changed) saveBoardLog(updated);
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
const BOX_STAT_FOR = {
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
function actualFor(type, ps) {
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
function gradeBet(side, point, actual) {
  if (actual == null) return null;
  if (actual === point) return "push";
  const over = actual > point;
  if (side === "over") return over ? "won" : "lost";
  return over ? "lost" : "won";
}
function gradeLine(type, side, point, homeScore, awayScore) {
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
function profitUnits(status, odds, units = 1) {
  const u = units == null || isNaN(units) ? 1 : units;
  if (status === "won") return u * (odds > 0 ? odds / 100 : 100 / -odds);
  if (status === "lost") return -u;
  return 0;
}
function findPlayerInSlate(playerId, games, slateRoster) {
  const id = String(playerId);
  for (const g of games || []) {
    const roster = slateRoster[g.pk]; if (!roster) continue;
    const hit = (roster.home || []).find((p) => String(p.id) === id);
    if (hit) return { game: g, side: "home", player: hit };
    const hitA = (roster.away || []).find((p) => String(p.id) === id);
    if (hitA) return { game: g, side: "away", player: hitA };
  }
  return null;
}

/* ---------------------- status + small shared UI ---------------------- */
const STATUS = {
  SCHEDULED: { t: "SCHEDULED", c: "bg-slate-700 text-slate-300" },
  LIVE: { t: "LIVE", c: "bg-rose-500 text-white" },
  FINAL: { t: "FINAL", c: "bg-slate-600 text-slate-200" },
  MANUAL: { t: "MANUAL", c: "bg-violet-500 text-white" },
};
function Chip({ s }) { const m = STATUS[s] || STATUS.SCHEDULED; return <span className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wide ${m.c}`}>{m.t}</span>; }
const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };
const STAT_ORDER = CATEGORY_ORDER;
const SEASON_TYPE_LABEL = { 1: "Preseason", 2: "Regular Season", 3: "Postseason" };
function ScoreLine({ g }) {
  const a = g.awayScore, h = g.homeScore;
  if (g.status === "FINAL") {
    return <div className="text-[12px] truncate" style={mono}><span className={a > h ? "text-slate-100 font-bold" : "text-slate-400"}>{g.away} {a}</span><span className="text-slate-600">, </span><span className={h > a ? "text-slate-100 font-bold" : "text-slate-400"}>{g.home} {h}</span><span className="text-slate-500"> · Final</span></div>;
  }
  if (g.status === "LIVE") {
    return <div className="text-[12px] truncate" style={mono}><span className="text-slate-200">{g.away} {a}</span><span className="text-slate-600">, </span><span className="text-slate-200">{g.home} {h}</span><span className="text-rose-400"> · Q{g.period} {g.clock}</span></div>;
  }
  return null;
}

/* ============================================================ */
export default function NFLApp() {
  const wk0 = currentWeekGuess();
  const [seasonType, setSeasonType] = useState(wk0.seasonType);
  const [week, setWeek] = useState(wk0.week);
  const [year, setYear] = useState(wk0.year);
  const weekKey = `${year}-${seasonType}-${week}`;
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [stamp, setStamp] = useState(null);
  const [tab, setTab] = useState("slate");
  const [open, setOpen] = useState(null);
  const [detail, setDetail] = useState({});          // pk -> { ready, players:{id:ctxParts}, teams, weather, ... }
  const [book, setBook] = useState("draftkings");
  const [board, setBoard] = useState({});             // pk -> entries[]
  const [oddsLoading, setOddsLoading] = useState(null);
  const [credits, setCredits] = useState(loadCredits());
  const [oddsFetches, setOddsFetches] = useState(0);
  const [boardLogCount, setBoardLogCount] = useState(() => loadBoardLog().length);
  const [boardLogSettling, setBoardLogSettling] = useState(false);
  const [boardLogSettleMsg, setBoardLogSettleMsg] = useState("");
  const [boardSort, setBoardSort] = useState("ev_desc");
  const [minEdge, setMinEdge] = useState("");
  const [minModel, setMinModel] = useState("");
  const [minEV, setMinEV] = useState("");
  const [minOdds, setMinOdds] = useState("");
  const [maxOdds, setMaxOdds] = useState("");
  const [minDelta, setMinDelta] = useState("");
  const [maxDelta, setMaxDelta] = useState("");
  const [dirAligned, setDirAligned] = useState(false); // only show plays where proj direction matches bet side
  const [showMoreBoard, setShowMoreBoard] = useState(false);
  const [catFilter, setCatFilter] = useState("all");
  const [boardSearch, setBoardSearch] = useState("");
  const [gameFilter, setGameFilter] = useState("all");
  const [sideFilter, setSideFilter] = useState("all");
  const [classFilter, setClassFilter] = useState("all"); // all | props | lines
  const [showProjBar, setShowProjBar] = useState(true); // toggles the proj-vs-line buffer bar on Board rows
  const [analysisProfile, setAnalysisProfile] = useState(null); // { player, game, side }
  const [analysisQuery, setAnalysisQuery] = useState("");
  const [analysisResults, setAnalysisResults] = useState([]);
  const [analysisSearching, setAnalysisSearching] = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisErr, setAnalysisErr] = useState("");
  const [betStatusFilter, setBetStatusFilter] = useState("all");
  const [betSort, setBetSort] = useState("recent");
  const [betWeekFilter, setBetWeekFilter] = useState("all"); // all | a specific weekKey
  const [betGameFilters, setBetGameFilters] = useState<string[]>([]);   // [] = all; multi-select games
  const [betTypeFilters, setBetTypeFilters] = useState<string[]>([]);   // [] = all; multi-select categories
  const [betBookFilters, setBetBookFilters] = useState<string[]>([]);   // [] = all; multi-select sportsbooks
  const [betSideFilter, setBetSideFilter] = useState("all");  // all | over | under | home | away
  const [betSearch, setBetSearch] = useState("");
  const [showMoreBets, setShowMoreBets] = useState(false);
  const [betMinModel, setBetMinModel] = useState("");
  const [betMinEdge, setBetMinEdge] = useState("");
  const [betMaxEdge, setBetMaxEdge] = useState("");
  const [betMinOdds, setBetMinOdds] = useState("");
  const [betMaxOdds, setBetMaxOdds] = useState("");
  const [betMinDelta, setBetMinDelta] = useState("");
  const [betMaxDelta, setBetMaxDelta] = useState("");
  const [betDirAligned, setBetDirAligned] = useState(false);
  const [stakeMode, setStakeMode] = useState("flat");
  const [myBets, setMyBets] = useState(loadBets());
  const [settleMsg, setSettleMsg] = useState("");
  const [lineMsg, setLineMsg] = useState("");
  const [refreshingLines, setRefreshingLines] = useState(false);
  const eventsRef = useRef({ sportKey: null, events: null });
  const inflight = useRef(new Set());

  useEffect(() => { saveBets(myBets); }, [myBets]);
  useEffect(() => { void settleBoardLog(myBets); }, [myBets]);
  // Clear game multi-select when week changes — previously selected games may belong to a different week.
  useEffect(() => { setBetGameFilters([]); }, [betWeekFilter]);
  useEffect(() => { boardLogReady.then((rows) => setBoardLogCount(rows.length)); }, []);
  useEffect(() => { if (credits != null) { try { localStorage.setItem(LS_CREDITS, String(credits)); } catch {} } }, [credits]);
  // Best-guess-then-verify: currentWeekGuess() above painted a synchronous
  // default so the homepage isn't blank; now confirm it against ESPN's real
  // live schedule and correct if wrong (this is what actually fixes "opens to
  // a fully-completed past week" — calendar math alone can't track holiday
  // scheduling, variable preseason length, or bye-week structure). Only
  // applies once, and only if the user hasn't already navigated to a
  // different week/season/year while the lookup was in flight.
  useEffect(() => {
    let cancelled = false;
    fetchCurrentWeek().then((live) => {
      if (cancelled) return;
      // each field only overwrites if it still equals the synchronous initial
      // guess, i.e. the user hasn't manually navigated it away in the meantime.
      setSeasonType((cur) => (cur === wk0.seasonType ? live.seasonType : cur));
      setWeek((cur) => (cur === wk0.week ? live.week : cur));
      setYear((cur) => (cur === wk0.year ? live.year : cur));
    }).catch(() => { /* live lookup unavailable — keep the calendar-math default */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, []);

  const sportKey = seasonType === 1 ? ODDS_SPORT_PRESEASON : ODDS_SPORT;

  async function loadSchedule() {
    setLoading(true); setErr(""); setOpen(null); setDetail({}); setBoard({});
    eventsRef.current = { sportKey: null, events: null };
    try {
      const gs = await fetchSchedule(seasonType, week, year); setGames(gs); setStamp(new Date());
      if (!gs.length) setErr("No games this week (bye-heavy week, or week/season not yet scheduled).");
    } catch (e) { setErr(`Schedule fetch blocked (${e.message}).`); setGames([]); }
    finally { setLoading(false); }
  }
  useEffect(() => { loadSchedule(); /* eslint-disable-next-line */ }, [seasonType, week, year]);

  /* ---- per-game detail: rosters, depth chart, gamelogs for featured players, team scoring env ---- */
  const standingsRef = useRef({}); // year -> {teamId -> {ppgFor, ppgAgainst}}
  async function ensureStandings(yr) {
    if (standingsRef.current[yr]) return standingsRef.current[yr];
    const s = await fetchStandings(yr).catch(() => ({}));
    standingsRef.current[yr] = s;
    return s;
  }
  function featuredFromRosterAndDepth(roster, depth) {
    // Pick the players worth showing/pricing: starting QB, RB1-2, WR1-3, TE1, K1 (depth-chart rank),
    // falling back to roster order within each position group when a depth chart entry is missing —
    // NFL has no "posted lineup" the way MLB does, so the depth chart is the closest analog.
    const byPos = {};
    for (const p of roster) { (byPos[p.pos] = byPos[p.pos] || []).push(p); }
    const rankOf = (p) => (depth[p.id] ? depth[p.id].rank : 99);
    // depthConfirmed: whether the TOP pick in this position group actually came from
    // real depth-chart data (rank < 99), vs. fetchDepthChart returning nothing for this
    // team (network hiccup, missing data) and this "starter" really just being arbitrary
    // roster-listing order — surfaced to the UI instead of silently presenting either
    // case the same way.
    const pick = (pos, n) => {
      const sorted = (byPos[pos] || []).slice().sort((a, b) => rankOf(a) - rankOf(b)).slice(0, n);
      const topConfirmed = sorted.length === 0 || rankOf(sorted[0]) < 99;
      return sorted.map((p, i) => ({ ...p, depthRank: rankOf(p), depthConfirmed: i === 0 ? topConfirmed : true }));
    };
    return [...pick("QB", 1), ...pick("RB", 2), ...pick("WR", 3), ...pick("TE", 1), ...pick("PK", 1), ...pick("K", 1)];
  }
  async function loadDetail(g) {
    if (detail[g.pk] && detail[g.pk].ready) return detail[g.pk];
    if (inflight.current.has(g.pk)) return null;
    inflight.current.add(g.pk);
    setDetail((p) => ({ ...p, [g.pk]: { loading: true } }));
    const standings = await ensureStandings(year);
    const stadium = STADIUMS[g.homeId] || { lat: null, lon: null, dome: true };
    const [rosterH, rosterA, depthH, depthA, teamStatsH, teamStatsA] = await Promise.all([
      fetchRoster(g.homeId).catch(() => []), fetchRoster(g.awayId).catch(() => []),
      fetchDepthChart(g.homeId, year).catch(() => ({})), fetchDepthChart(g.awayId, year).catch(() => ({})),
      fetchTeamStats(g.homeId).catch(() => ({ off: {}, def: {} })), fetchTeamStats(g.awayId).catch(() => ({ off: {}, def: {} })),
    ]);
    let wx = null;
    if (!stadium.dome && stadium.lat) wx = await fetchWeather(stadium.lat, stadium.lon).catch(() => null);
    const featH = featuredFromRosterAndDepth(rosterH, depthH);
    const featA = featuredFromRosterAndDepth(rosterA, depthA);
    const gamelogs = {};
    const priorGamelogs = {};
    const tasks = [];
    for (const p of [...featH, ...featA]) {
      tasks.push(
        fetchAthleteGamelog(p.id, 4).then(async (gl) => {
          gamelogs[p.id] = gl;
          // Real per-player identity requires real per-player sample. Week 1 (and any early week)
          // this player's current-season log is empty or thin — shrinkRate/shrinkValue would fall
          // straight back to a flat league constant with zero player identity (this was the root
          // cause behind identical projections for different players at the same depth-chart slot).
          // Pull last season's real, complete log as the shrinkage prior instead, so "this player's
          // own career rate" anchors the projection rather than "the league average."
          if (!gl || !gl.season || !gl.season.g) {
            const prior = await fetchAthleteGamelog(p.id, 4, year - 1).catch(() => null);
            if (prior) priorGamelogs[p.id] = prior;
          }
        }).catch(() => {})
      );
    }
    await Promise.allSettled(tasks);
    const sH = standings[g.homeId] || {}, sA = standings[g.awayId] || {};
    const offH = clamp((sH.ppgFor || LG_PPG) / LG_PPG, 0.65, 1.5);
    const offA = clamp((sA.ppgFor || LG_PPG) / LG_PPG, 0.65, 1.5);
    const defAllowH = clamp((sA.ppgAgainst || LG_PPG) / LG_PPG, 0.65, 1.5); // opponent (away) points allowed -> feeds HOME's projected points
    const defAllowA = clamp((sH.ppgAgainst || LG_PPG) / LG_PPG, 0.65, 1.5);
    const lambdaH = +clamp(LG_PPG * offH * defAllowH * HOME_FIELD_MULT.home, 6, 45).toFixed(2);
    const lambdaA = +clamp(LG_PPG * offA * defAllowA * HOME_FIELD_MULT.away, 6, 45).toFixed(2);
    const obj = {
      ready: true, loading: false, stadium, weather: wx,
      home: { roster: rosterH, depth: depthH, featured: featH, teamStats: teamStatsH, standings: sH },
      away: { roster: rosterA, depth: depthA, featured: featA, teamStats: teamStatsA, standings: sA },
      gamelogs, priorGamelogs, lambdaH, lambdaA,
    };
    setDetail((p) => ({ ...p, [g.pk]: obj }));
    inflight.current.delete(g.pk);
    return obj;
  }
  async function expand(g) {
    if (open === g.pk) { setOpen(null); return; }
    setOpen(g.pk);
    if (!g.manual) await loadDetail(g);
  }

  /* ---- context builder: one featured player -> the ctx object projectProp consumes ---- */
  function playerCtx(d, g, side, p) {
    const isHome = side === "home";
    const oppData = isHome ? d.away : d.home;
    const gl = gamelogFor(d, p.id);
    const priorGl = d && d.priorGamelogs ? d.priorGamelogs[p.id] : null;
    const impliedTeamPts = isHome ? d.lambdaH : d.lambdaA;
    const marketSpread = g.marketSpreadHome != null ? (isHome ? g.marketSpreadHome : -g.marketSpreadHome) : null;
    const modelSpread = isHome ? (d.lambdaA - d.lambdaH) : (d.lambdaH - d.lambdaA); // signed FOR this team (positive = underdog)
    const teamSpread = marketSpread != null ? marketSpread : modelSpread;
    return {
      pos: p.pos === "PK" ? "K" : p.pos,
      season: gl ? gl.season : null, recent: gl ? gl.recent : null, games: gl ? gl.games : null,
      // last season's real, complete log — the shrinkage prior once this-season sample is thin/empty
      // (fetched only when it's needed, see loadDetail). null for rookies / no data available.
      priorSeason: priorGl ? priorGl.season : null,
      teamSpread, weather: d.weather, stadium: d.stadium,
      injuryStatus: p.injuryStatus, depthRank: p.depthRank,
      impliedTeamPts, teamDrivesPerGame: 10.8, redZoneTdRate: 0.58,
      oppPassAtt: LG.teamPassAtt, teamSackRate: LG.sackRatePerPassAtt, teamDefIntRate: LG.defIntRatePerPassAtt,
      // opponent-allowed splits: wired from fetchTeamStats' real per-team pass/rush yards-allowed-
      // per-game (ESPN team statistics, already fetched into detail[pk].home/away.teamStats — this
      // was sitting unused). No position-granular split source is available yet (ESPN's generic team
      // stats endpoint doesn't break out "yards allowed to WRs" vs "to RBs"), so oppPassYdsAllowedToRB/
      // ToPos reuse the team-wide pass-defense number as the best available proxy: a leaky pass D
      // gives up more to everyone, RBs and WRs alike, even without a position-specific number. TD-
      // allowed and takeaway splits aren't in this endpoint's response — still neutral (1x) until a
      // source is added. See INTEGRATION.md "known v1 simplifications".
      oppPassYdsAllowed: (oppData.teamStats && oppData.teamStats.def && oppData.teamStats.def.netPassingYardsAllowedPerGame) || null,
      lgPassYdsAllowed: LG.passYdsAllowedPerGame,
      oppPassTdAllowed: null, lgPassTdAllowed: null,
      oppDefTakeaways: null, lgDefTakeaways: null,
      oppRushYdsAllowed: (oppData.teamStats && oppData.teamStats.def && oppData.teamStats.def.rushingYardsAllowedPerGame) || null,
      lgRushYdsAllowed: LG.rushYdsAllowedPerGame,
      oppRushTdAllowed: null, lgRushTdAllowed: null,
      oppPassYdsAllowedToRB: (oppData.teamStats && oppData.teamStats.def && oppData.teamStats.def.netPassingYardsAllowedPerGame) || null,
      lgPassYdsAllowedToRB: LG.passYdsAllowedPerGame,
      oppPassYdsAllowedToPos: (oppData.teamStats && oppData.teamStats.def && oppData.teamStats.def.netPassingYardsAllowedPerGame) || null,
      lgPassYdsAllowedToPos: LG.passYdsAllowedPerGame,
      oppPassTdAllowedToPos: null, lgPassTdAllowedToPos: null,
      oppSackRateAllowed: (oppData.teamStats && oppData.teamStats.def && oppData.teamStats.def.sackRate) || null, lgSackRateAllowed: LG.sackRatePerPassAtt,
      oppQbIntRate: null, lgQbIntRate: LG.intRate,
      touchShare: p.pos === "RB" ? (p.depthRank === 1 ? 0.55 : 0.25) : undefined,
      touchShareMult: 1, goalLineShareMult: p.depthRank === 1 ? 1.15 : 0.7, redZoneShareMult: 1,
      shortWeek: !!g.shortWeek, crossCountryTravel: !!g.crossCountryTravel, onBye: false,
    };
  }
  function gamelogFor(d, pid) { return d && d.gamelogs ? d.gamelogs[pid] : null; }

  const propsForPos = (pos) => pos === "QB" ? QB_PROPS : pos === "RB" ? RB_PROPS : (pos === "WR" || pos === "TE") ? WR_PROPS : pos === "K" ? K_PROPS : pos === "DST" ? DST_PROPS : [];

  /* ---- universal player search (Player Analysis tab) — mirrors MLB's searchPlayers/
     selectAnalysisPlayer flow: search ANY NFL player by name, not just this week's
     featured (QB1/RB1-2/WR1-3/TE1/K1) slate players. ---- */
  async function runAnalysisSearch() {
    const q = analysisQuery.trim();
    if (!q) return;
    setAnalysisSearching(true); setAnalysisErr(""); setAnalysisResults([]);
    try {
      const res = await searchPlayers(q);
      setAnalysisResults(res);
      if (!res.length) setAnalysisErr(`No NFL players matched "${q}".`);
    } catch (e) {
      setAnalysisResults([]);
      setAnalysisErr(`Player search failed (${String((e && e.message) || e)}).`);
    } finally { setAnalysisSearching(false); }
  }
  // A searched player's team may not be in the currently-loaded week's schedule (wrong
  // week loaded, or a bye week) — that's a real, expected case (NFL has 32 teams and
  // only ~13-16 play any given week), so it gets a clear message, not a silent failure.
  async function selectAnalysisPlayer(result) {
    setAnalysisLoading(true); setAnalysisErr(""); setAnalysisResults([]); setAnalysisQuery(result.name || "");
    try {
      if (!result.teamId) { setAnalysisErr(`Could not resolve "${result.teamName}" to an NFL team.`); return; }
      const g = games.find((x) => x.homeId === result.teamId || x.awayId === result.teamId);
      if (!g) {
        setAnalysisErr(`${result.name} (${result.teamName}) has no game loaded for Week ${week}, ${SEASON_TYPE_LABEL[seasonType]} ${year} — likely a bye week, or you have a different week loaded. Switch weeks and search again.`);
        return;
      }
      const side = g.homeId === result.teamId ? "home" : "away";
      let d = await loadDetail(g);
      if (!d) { setAnalysisErr("Could not load game context."); return; }
      const teamData = side === "home" ? d.home : d.away;
      let player = teamData.roster.find((p) => String(p.id) === String(result.id));
      if (!player) { setAnalysisErr(`${result.name} wasn't found on ${result.teamName}'s current roster (may be a very recent signing/cut — ESPN's roster feed can lag).`); return; }
      const depth = teamData.depth[player.id];
      player = { ...player, depthRank: depth ? depth.rank : 99 };
      // fetch this player's gamelog on demand if they weren't already in the "featured" set
      if (!d.gamelogs[player.id]) {
        const gl = await fetchAthleteGamelog(player.id, 4).catch(() => null);
        d = { ...d, gamelogs: { ...d.gamelogs, [player.id]: gl } };
        setDetail((p) => ({ ...p, [g.pk]: d }));
      }
      setAnalysisProfile({ game: g, side, player, detail: d });
      setTab("analysis");
    } catch (e) {
      setAnalysisErr(`Could not load player profile (${String((e && e.message) || e)}).`);
    } finally { setAnalysisLoading(false); }
  }

  /* ---- odds fetch for one game -> board entries (mirrors MLB's getOdds) ---- */
  async function getOdds(g) {
    if (oddsFetches >= ODDS_TESTING_LIMIT) { setErr(`Per-session fetch cap (${ODDS_TESTING_LIMIT}) reached — reload to reset, or raise ODDS_TESTING_LIMIT.`); return; }
    setOddsLoading(g.pk); setErr("");
    try {
      const d = await loadDetail(g);
      if (!d) { setOddsLoading(null); return; }
      if (!eventsRef.current.events || eventsRef.current.sportKey !== sportKey) {
        const ev = await fetchOddsEvents(sportKey); eventsRef.current = { sportKey, events: ev.events }; if (ev.remaining != null) setCredits(ev.remaining);
      }
      const ev = matchEvent(eventsRef.current.events, g);
      if (!ev) { setErr(`No odds event matched ${g.away}@${g.home} (book may not have posted lines yet).`); setOddsLoading(null); return; }
      const res = await fetchEventOdds(sportKey, ev.id, book); if (res.remaining != null) setCredits(res.remaining);
      setOddsFetches((n) => n + 1);
      const rows = parseEventOdds(res.data, book);
      const gl = parseGameOdds(res.data, book, g);
      // feed the market spread back into g for game-script context on this pass
      const gWithSpread = { ...g, marketSpreadHome: gl.spreads && gl.spreads.homePoint != null ? gl.spreads.homePoint : null };
      const byName = {};
      for (const side of ["home", "away"]) {
        const teamData = side === "home" ? d.home : d.away;
        for (const p of teamData.featured) byName[normName(p.name)] = { ctx: playerCtx(d, gWithSpread, side, p), name: p.name, id: p.id, pos: p.pos };
      }
      const entries = [];
      for (const row of rows) {
        const found = byName[normName(row.player)];
        if (!found) continue;
        if (!propsForPos(found.pos === "PK" ? "K" : found.pos).includes(row.type) && row.type !== "Anytime TD") continue;
        const pre = projectProp(found.ctx, row.type, parseFloat(row.point));
        for (const side of ["over", "under"]) {
          const odds = side === "over" ? row.over : row.under;
          if (odds == null) continue;
          const bet = { gamePk: g.pk, game: `${g.away}@${g.home}`, gameTimeIso: g.gameTimeIso || null, playerId: found.id, name: found.name, type: row.type, line: String(row.point), side, odds, overOdds: row.over, underOdds: row.under, ctx: found.ctx, book };
          const ev2 = evalBet(bet, pre);
          entries.push({ id: `${g.pk}-${found.id}-${row.type}-${row.point}-${side}`, ...bet, ...ev2 });
        }
      }
      const lineEntries = buildGameLineEntries(g, d, gl, book);
      entries.push(...lineEntries);
      setBoard((b) => ({ ...b, [g.pk]: entries }));
      if (!entries.length) setErr(`Got odds for ${g.away}@${g.home} but matched no players (props may not be posted yet this far out — try closer to kickoff).`);
    } catch (e) {
      setErr(`Odds fetch failed (${e.message}). Check the key/credits or CORS.`);
    } finally { setOddsLoading(null); }
  }

  /* ---- board (flattened, filtered, grouped, sorted) — mirrors MLB's board memo ---- */
  const boardEntries = useMemo(() => Object.values(board).flat(), [board]);
  useEffect(() => {
    if (boardEntries.length > 0) {
      appendBoardLog(boardEntries, MODEL_VERSION, weekKey).then(() => {
        setBoardLogCount(loadBoardLog().length);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardEntries]);
  const boardGames = useMemo(() => {
    const seen = {}; const out = [];
    for (const e of boardEntries) if (!seen[e.gamePk]) { seen[e.gamePk] = 1; out.push({ pk: String(e.gamePk), label: e.game }); }
    return out;
  }, [boardEntries]);
  // raw proj-minus-line (not side-adjusted — dirAligned below handles direction)
  const getDelta = (e) => (e.proj ?? 0) - parseFloat(e.line ?? 0);
  const grouped = useMemo(() => {
    const minE = parseFloat(minEdge);
    const minM = parseFloat(minModel);
    const minEv = parseFloat(minEV);
    const minO = parseFloat(minOdds);
    const maxO = parseFloat(maxOdds);
    const minD = parseFloat(minDelta);
    const maxD = parseFloat(maxDelta);
    const f = boardEntries.filter((e) => {
      if (e.modelP == null) return false;
      if (e.modelP >= 0.999 || e.modelP <= 0.001) return false;
      if (!isNaN(minE) && !(e.edge != null && e.edge * 100 >= minE)) return false;
      if (!isNaN(minM) && !(e.modelP * 100 >= minM)) return false;
      if (!isNaN(minEv) && !(e.ev != null && e.ev * 100 >= minEv)) return false;
      if (!isNaN(minO) && !(e.odds != null && e.odds >= minO)) return false;
      if (!isNaN(maxO) && !(e.odds != null && e.odds <= maxO)) return false;
      if (!isNaN(minD) && getDelta(e) < minD) return false;
      if (!isNaN(maxD) && getDelta(e) > maxD) return false;
      if (dirAligned) { const d = getDelta(e); if (e.side === "over" && d <= 0) return false; if (e.side === "under" && d >= 0) return false; }
      if (catFilter !== "all" && e.type !== catFilter) return false;
      if (gameFilter !== "all" && String(e.gamePk) !== gameFilter) return false;
      if (sideFilter !== "all" && e.side !== sideFilter) return false;
      if (classFilter === "props" && isLineType(e.type)) return false;
      if (classFilter === "lines" && !isLineType(e.type)) return false;
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
  }, [boardEntries, boardSort, minEdge, minModel, minEV, minOdds, maxOdds, minDelta, maxDelta, dirAligned, catFilter, classFilter, gameFilter, sideFilter, boardSearch]);
  const filtersActive = classFilter !== "all" || catFilter !== "all" || gameFilter !== "all" || sideFilter !== "all" || minEdge !== "" || minModel !== "" || minEV !== "" || minOdds !== "" || maxOdds !== "" || minDelta !== "" || maxDelta !== "" || dirAligned || boardSearch !== "";
  function clearFilters() { setClassFilter("all"); setCatFilter("all"); setGameFilter("all"); setSideFilter("all"); setMinEdge(""); setMinModel(""); setMinEV(""); setMinOdds(""); setMaxOdds(""); setMinDelta(""); setMaxDelta(""); setDirAligned(false); setBoardSearch(""); }

  /* ---- my bets ---- */
  function trackBet(e) {
    const exists = myBets.some((b) => b.key === e.id);
    if (exists) return;
    const sug = suggestedUnits(e.modelP, Number(e.odds));
    const units = stakeMode === "kelly" ? (sug > 0 ? sug : 1) : 1;
    const gtrk = games.find((x) => x.pk === e.gamePk);
    const liveBet = !!((e.calc && e.calc.live) || (gtrk && gtrk.status === "LIVE")); // was the game in progress when placed?
    const rec = { key: e.id, week: weekKey, gamePk: e.gamePk, game: e.game, playerId: e.playerId, name: e.name, type: e.type, line: e.line, side: e.side, odds: e.odds, book: e.book, modelP: e.modelP, proj: e.proj, novig: e.novig, units, suggested: sug, status: "open", actual: null, live: liveBet };
    setMyBets((p) => [rec, ...p]);
  }
  function updateBetOdds(key, odds) { setMyBets((p) => p.map((b) => b.key === key ? { ...b, odds: odds === "" ? "" : Number(odds) } : b)); }
  function updateBetUnits(key, units) { setMyBets((p) => p.map((b) => b.key === key ? { ...b, units: units === "" ? "" : Math.max(0, Number(units)) } : b)); }
  function removeBet(key) { setMyBets((p) => p.filter((b) => b.key !== key)); }
  function resetStats() {
    if (typeof window !== "undefined" && !window.confirm("Clear ALL tracked bets (open + settled)? This cannot be undone. Export a CSV first if you want a copy.")) return;
    setMyBets([]); setSettleMsg("");
  }

  async function settleBets() {
    const openByGame = {};
    for (const b of myBets) if (b.status === "open") (openByGame[b.gamePk] = openByGame[b.gamePk] || []).push(b);
    const pks = Object.keys(openByGame);
    if (!pks.length) { setSettleMsg("No open bets to settle."); return; }
    setSettleMsg("Settling…");
    const results = {};
    for (const pk of pks) { results[pk] = await fetchGameSummary(pk); }
    // "Longest Completion" isn't in ESPN's box score summary at all (see fetchLongCmpForEvent) —
    // pull it from the player's gamelog instead, one targeted fetch per player/game that needs it.
    const longCmpActuals = {};
    let longCmpAttempted = 0, longCmpFound = 0;
    for (const b of myBets) {
      if (b.status !== "open" || b.type !== "Longest Completion") continue;
      const res = results[b.gamePk];
      if (!res || !res.final || res.canceled) continue;
      const key = `${b.playerId}:${b.gamePk}`;
      if (key in longCmpActuals) continue;
      longCmpAttempted++;
      longCmpActuals[key] = await fetchLongCmpForEvent(b.playerId, b.gamePk);
      if (longCmpActuals[key] != null) longCmpFound++;
    }
    let graded = 0;
    setMyBets((prev) => prev.map((b) => {
      if (b.status !== "open") return b;
      const res = results[b.gamePk]; if (!res) return b;
      // A game ESPN has flagged as canceled/forfeited never reaches `final` — void
      // immediately rather than leaving these open forever.
      if (res.canceled) { graded++; return { ...b, status: "void", actual: "CANCELED" }; }
      if (!res.final) return b;
      if (isLineType(b.type)) {
        const { status, actual } = gradeLine(b.type, b.side, parseFloat(b.line), res.homeScore, res.awayScore);
        if (!status) return b; graded++; return { ...b, status, actual };
      }
      const ps = res.players[b.playerId];
      if (!ps) { graded++; return { ...b, status: "void", actual: "DNP" }; }
      let actual = actualFor(b.type, ps);
      if (actual == null && b.type === "Longest Completion") actual = longCmpActuals[`${b.playerId}:${b.gamePk}`] ?? null;
      const st = gradeBet(b.side, parseFloat(b.line), actual);
      if (st == null) return b;
      graded++; return { ...b, status: st, actual };
    }));
    const longCmpNote = longCmpAttempted ? ` Longest Completion lookups: ${longCmpFound}/${longCmpAttempted} found (see console for misses).` : "";
    setSettleMsg(`Settled ${graded} bet(s). Unsettled games are still in progress.${longCmpNote}`);
  }

  // ── Full Board Log Settlement (mirrors MLB's settleFullBoardLog) ───────────────────────
  // Grades EVERY board-log candidate for finished games — not just tracked bets — using the
  // free ESPN summary endpoint (no Odds API credits). This is what turns the board log from
  // a raw model-output archive into a real calibration dataset as the season plays out.
  async function settleFullBoardLog() {
    await boardLogReady;
    const log = loadBoardLog();
    const unsettled = log.filter((e) => !e.settled);
    if (!unsettled.length) { setBoardLogSettleMsg("Board log is fully settled — nothing to do."); return; }
    const pks = [...new Set(unsettled.map((e) => e.gamePk))];
    setBoardLogSettling(true);
    setBoardLogSettleMsg(`Fetching results for ${pks.length} game(s)…`);
    try {
      const results = {};
      for (const pk of pks) results[pk] = await fetchGameSummary(pk);
      // Same gamelog fallback as settleBets() — ESPN's box score summary has no field for
      // "Longest Completion" at all, so these would otherwise never settle out of the log.
      const longCmpActuals = {};
      let longCmpAttempted = 0, longCmpFound = 0;
      for (const e of unsettled) {
        if (e.type !== "Longest Completion") continue;
        const res = results[e.gamePk];
        if (!res || !res.final || res.canceled) continue;
        const key = `${e.playerId}:${e.gamePk}`;
        if (key in longCmpActuals) continue;
        longCmpAttempted++;
        longCmpActuals[key] = await fetchLongCmpForEvent(e.playerId, e.gamePk);
        if (longCmpActuals[key] != null) longCmpFound++;
      }
      let graded = 0;
      const updated = log.map((e) => {
        if (e.settled) return e;
        const res = results[e.gamePk];
        if (!res) return e;
        if (res.canceled) { graded++; return { ...e, settled: true, actualStat: "CANCELED", result: "void" }; }
        if (!res.final) return e; // game still in progress — leave unsettled
        if (isLineType(e.type)) {
          const { status, actual } = gradeLine(e.type, e.side, parseFloat(e.line || "0"), res.homeScore, res.awayScore);
          if (!status) return e;
          graded++; return { ...e, settled: true, actualStat: actual, result: status };
        }
        const ps = res.players[e.playerId];
        if (!ps) { graded++; return { ...e, settled: true, actualStat: "DNP", result: "void" }; }
        let actual = actualFor(e.type, ps);
        if (actual == null && e.type === "Longest Completion") actual = longCmpActuals[`${e.playerId}:${e.gamePk}`] ?? null;
        const status = gradeBet(e.side, parseFloat(String(e.line)), actual);
        if (status == null) return e;
        graded++; return { ...e, settled: true, actualStat: actual, result: status };
      });
      saveBoardLog(updated);
      const totalSettled = updated.filter((e) => e.settled).length;
      setBoardLogCount(updated.length);
      const longCmpNote = longCmpAttempted ? ` Longest Completion lookups: ${longCmpFound}/${longCmpAttempted} found (see console for misses).` : "";
      setBoardLogSettleMsg(`Graded ${graded} board log entr${graded === 1 ? "y" : "ies"} across ${pks.length} game(s). ${totalSettled.toLocaleString()} / ${updated.length.toLocaleString()} total entries now settled.${longCmpNote}`);
    } catch (err) {
      setBoardLogSettleMsg(`Settlement failed: ${String((err && err.message) || err)}`);
    } finally {
      setBoardLogSettling(false);
    }
  }
  function exportBoardLogCSV() {
    const log = loadBoardLog();
    if (!log.length) { alert("No board log entries yet. Load a game to start logging."); return; }
    const esc = (v) => { if (v == null) return ""; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const headers = ["logId", "loggedAt", "modelVersion", "week", "game", "gameTimeIso", "gamePk", "playerId", "name", "type", "line", "side", "odds", "novig", "rawModelP", "calibratedP", "edge", "ev", "proj", "settled", "actualStat", "result"];
    const rows = [headers.join(",")];
    for (const e of log) {
      rows.push([
        esc(e.logId), esc(e.loggedAt), esc(e.modelVersion), esc(e.week),
        esc(e.game), esc(e.gameTimeIso), esc(e.gamePk), esc(e.playerId), esc(e.name),
        esc(e.type), esc(e.line), esc(e.side), esc(e.odds),
        e.novig ?? "", e.rawModelP ?? "", e.calibratedP ?? "",
        e.edge ?? "", e.ev ?? "", e.proj ?? "",
        e.settled ? "true" : "false", e.actualStat ?? "", esc(e.result),
      ].join(","));
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `nfl-board-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function clearBoardLog() {
    if (typeof window !== "undefined" && !window.confirm("Clear ALL board log entries? This cannot be undone. Export a CSV first.")) return;
    saveBoardLog([]);
    setBoardLogCount(0);
    setBoardLogSettleMsg("");
  }

  // pull the current market price for each open tracked bet (line movement / CLV). ~9 credits per game with open bets.
  async function refreshLines() {
    const open = myBets.filter((b) => b.status === "open" && b.book && b.book !== "manual");
    if (!open.length) { setLineMsg("No open tracked bets with a book to refresh (manual bets have no book to pull)."); return; }
    const byGame = {};
    for (const b of open) { (byGame[b.gamePk] = byGame[b.gamePk] || []).push(b); }
    setRefreshingLines(true); setLineMsg("Refreshing lines…");
    try {
      let events = eventsRef.current.sportKey === sportKey ? eventsRef.current.events : null;
      if (!events) { const ev = await fetchOddsEvents(sportKey); events = ev.events || []; eventsRef.current = { sportKey, events }; if (ev.remaining != null) setCredits(ev.remaining); }
      const updates = {}; let matched = 0, missed = 0, games_ = 0, frozen = 0;
      const at = new Date().toISOString();
      for (const pkStr in byGame) {
        const bets = byGame[pkStr]; const pk = pkStr;
        const g = games.find((x) => String(x.pk) === pk);
        const ev = g ? matchEvent(events, g) : null;
        if (!ev) { for (const b of bets) { updates[b.key] = { oddsCheckedAt: at, currentOdds: null, lineMissing: true }; missed++; } continue; }
        // has kickoff passed? prefer the book's commence_time; fall back to slate status
        const started = ev.commence_time ? (Date.parse(ev.commence_time) <= Date.now()) : (g && (g.status === "LIVE" || g.status === "FINAL"));
        // pregame bets freeze at the closing line once the game starts (live re-prices aren't comparable). live bets keep updating.
        for (const b of bets) { if (!b.live && started && b.currentOdds != null && !b.closing) { updates[b.key] = { closing: true, oddsCheckedAt: at }; frozen++; } }
        const toPull = bets.filter((b) => b.live || !started);
        if (!toPull.length) continue; // nothing to fetch for this game (all pregame bets are frozen) -> saves credits
        // ONE fetch per game covering every book we track on it.
        const books = [...new Set(toPull.map((b) => b.book))];
        const res = await fetchEventOdds(sportKey, ev.id, books.join(",")); games_++;
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

  /* live recompute of My Bets EV (odds editable) — mirrors MLB */
  const myBetsView = useMemo(() => {
    let arr = myBets.map((b, i) => {
      const odds = Number(b.odds);
      const modelP = b.modelP, imp = isNaN(odds) ? null : impliedProb(odds);
      const fairRef = b.novig != null ? b.novig : imp;
      const edge = (modelP != null && fairRef != null) ? modelP - fairRef : null;
      const ev = (modelP != null && !isNaN(odds)) ? evPerUnit(modelP, odds) : null;
      const units = b.units != null ? b.units : 1;
      const suggested = b.suggested != null ? b.suggested : suggestedUnits(modelP, odds);
      // CLV: positive = market moved toward your side since you bet (your side's price shortened) = you beat the line
      const clv = (b.currentOdds != null && !isNaN(odds)) ? impliedProb(b.currentOdds) - impliedProb(odds) : null;
      return { ...b, imp, edge, ev, units, suggested, clv, _i: i };
    });
    if (betStatusFilter === "settled") arr = arr.filter((b) => b.status !== "open");
    else if (betStatusFilter !== "all") arr = arr.filter((b) => b.status === betStatusFilter);
    if (betWeekFilter !== "all") arr = arr.filter((b) => b.week === betWeekFilter);
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
  }, [myBets, betStatusFilter, betSort, betWeekFilter, betGameFilters, betTypeFilters, betBookFilters, betSideFilter, betMinModel, betMinEdge, betMaxEdge, betMinOdds, betMaxOdds, betMinDelta, betMaxDelta, betDirAligned, betSearch]);
  const betWeeks = useMemo(() => [...new Set(myBets.map((b) => b.week).filter(Boolean))].sort().reverse(), [myBets]);
  // Scope game list to the selected week so a Week 1 matchup doesn't appear when filtering to Week 2.
  const betGames = useMemo(() => {
    const base = betWeekFilter !== "all" ? myBets.filter((b) => b.week === betWeekFilter) : myBets;
    return [...new Set(base.map((b) => b.game).filter(Boolean))].sort();
  }, [myBets, betWeekFilter]);
  const betTypes = useMemo(() => [...new Set(myBets.map((b) => b.type).filter(Boolean))].sort(), [myBets]);
  const betBooks = useMemo(() => [...new Set(myBets.map((b) => b.book).filter(Boolean))].sort(), [myBets]);
  const betSides = useMemo(() => [...new Set(myBets.map((b) => b.side).filter(Boolean))].sort(), [myBets]);
  const trackedByGame = useMemo(() => { const m = {}; for (const b of myBets) if (b.status === "open") m[b.gamePk] = (m[b.gamePk] || 0) + 1; return m; }, [myBets]);
  const betFiltersActive = betStatusFilter !== "all" || betGameFilters.length > 0 || betTypeFilters.length > 0 || betBookFilters.length > 0 || betSideFilter !== "all" || betWeekFilter !== "all" || betMinModel !== "" || betMinEdge !== "" || betMaxEdge !== "" || betMinOdds !== "" || betMaxOdds !== "" || betMinDelta !== "" || betMaxDelta !== "" || betDirAligned || betSearch !== "";
  function clearBetFilters() { setBetStatusFilter("all"); setBetGameFilters([]); setBetTypeFilters([]); setBetBookFilters([]); setBetSideFilter("all"); setBetWeekFilter("all"); setBetMinModel(""); setBetMinEdge(""); setBetMaxEdge(""); setBetMinOdds(""); setBetMaxOdds(""); setBetMinDelta(""); setBetMaxDelta(""); setBetDirAligned(false); setBetSearch(""); }

  const stats = useMemo(() => {
    const settled = myBets.filter((b) => b.status === "won" || b.status === "lost" || b.status === "push" || b.status === "void");
    const unitsOf = (b) => (b.units != null && !isNaN(b.units) ? Number(b.units) : 1);
    const agg = (arr) => {
      const w = arr.filter((b) => b.status === "won").length, l = arr.filter((b) => b.status === "lost").length, ps = arr.filter((b) => b.status === "push").length, v = arr.filter((b) => b.status === "void").length;
      const net = arr.reduce((s, b) => s + profitUnits(b.status, Number(b.odds), unitsOf(b)), 0);
      const staked = arr.filter((b) => b.status !== "push" && b.status !== "void").reduce((s, b) => s + unitsOf(b), 0);
      const flatRisked = w + l;
      return { n: arr.length, w, l, ps, v, winPct: flatRisked ? w / flatRisked : null, net, staked, roi: staked ? net / staked : null };
    };
    const byType = {}; for (const t of STAT_ORDER) { const a = settled.filter((b) => b.type === t); if (a.length) byType[t] = agg(a); }
    return { overall: agg(settled), byType, openCount: myBets.filter((b) => b.status === "open").length };
  }, [myBets]);

  function exportCSV() {
    const esc = (v) => { if (v == null) return ""; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const header = ["week", "date", "game", "name", "type", "line", "side", "odds", "book", "units", "modelP", "novig", "edge", "status", "actual"];
    const rows = myBets.map((b) => [b.week, b.date || "", b.game, b.name, b.type, b.line, b.side, b.odds, b.book, b.units, b.modelP, b.novig, (b.modelP != null && b.novig != null) ? (b.modelP - b.novig) : "", b.status, b.actual].map(esc).join(","));
    const csv = [header.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `nfl-edge-finder-bets-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }
  // lossless backup of the tracked-bet log so it survives a host/browser change (localStorage
  // does not) — mirrors MLB's backup/restore pair verbatim.
  function backupBets() {
    const data = JSON.stringify({ app: "nfl-edge-finder", v: 1, exported: new Date().toISOString(), bets: myBets }, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `nfl-edge-finder-bets-${new Date().toISOString().slice(0, 10)}.json`;
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

  /* ---- Player Analysis: build ctx + every prop projection for the selected player ---- */
  const analysisCtx = useMemo(() => {
    if (!analysisProfile || !analysisProfile.detail || !analysisProfile.detail.ready) return null;
    return playerCtx(analysisProfile.detail, analysisProfile.game, analysisProfile.side, analysisProfile.player);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisProfile]);
  const analysisProjections = useMemo(() => {
    if (!analysisCtx) return [];
    const pos = analysisCtx.pos;
    const props = [...propsForPos(pos), ...(pos !== "K" && pos !== "DST" ? ["Anytime TD"] : [])];
    return props.map((type) => {
      const line = DEFAULT_LINE[type] || "0.5";
      const pr = projectProp(analysisCtx, type, parseFloat(line));
      return { type, line, ...pr, overP: pr.pOver, underP: pr.pOver != null ? 1 - pr.pOver : null, overFair: pr.pOver != null ? probToAmerican(pr.pOver) : "—", underFair: pr.pOver != null ? probToAmerican(1 - pr.pOver) : "—" };
    });
  }, [analysisCtx]);
  const analysisBoardEntries = useMemo(() => {
    if (!analysisProfile) return [];
    const pid = String(analysisProfile.player.id);
    return boardEntries.filter((e) => String(e.playerId) === pid);
  }, [analysisProfile, boardEntries]);

  /* ---------------------- render ---------------------- */
  const TABS = [
    { k: "slate", t: "Slate" }, { k: "board", t: `Board${boardEntries.length ? ` (${boardEntries.length})` : ""}` },
    { k: "analysis", t: "Player Analysis" }, { k: "bets", t: `My Bets${myBets.filter((b) => b.status === "open").length ? ` (${myBets.filter((b) => b.status === "open").length})` : ""}` },
    { k: "stats", t: "Stats" },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <div className="max-w-5xl mx-auto px-4 pb-28">
        <header className="pt-6 pb-3 sticky top-0 bg-slate-950 z-20 border-b border-slate-800">
          <div className="flex items-end justify-between flex-wrap gap-3">
            <div>
              <h1 className="text-2xl font-black tracking-tight">🏈 NFL <span className="text-emerald-400">EDGE</span> FINDER</h1>
              <p className="text-[11px] text-slate-500 mt-0.5" style={mono}>live odds · de-vigged edge · Monte-Carlo props</p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Sel label="" v={seasonType} opts={[1, 2, 3]} labels={SEASON_TYPE_LABEL} onChange={(v) => setSeasonType(+v)} />
              <NumIn label="Wk" v={week} onChange={setWeek} placeholder="wk" min={1} max={22} />
              <NumIn label="Yr" v={year} onChange={setYear} placeholder="yr" min={2015} max={2035} />
              <select value={book} onChange={(e) => setBook(e.target.value)} className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm">
                {BOOKS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
              </select>
              <button onClick={loadSchedule} className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm rounded-lg px-3 py-1.5">{loading ? "…" : "Refresh"}</button>
            </div>
          </div>
          <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
            <div className="flex gap-1 flex-wrap">
              {TABS.map((t) => (
                <button key={t.k} onClick={() => setTab(t.k)} className={`px-3.5 py-1.5 rounded-lg text-sm font-semibold ${tab === t.k ? "bg-slate-800 text-emerald-400" : "text-slate-400 hover:text-slate-200"}`}>{t.t}</button>
              ))}
            </div>
            <div className="flex items-center gap-3 text-[10px] text-slate-500" style={mono}>
              <span>odds credits: <b className={credits != null && credits < 1000 ? "text-amber-400" : "text-slate-300"}>{credits != null ? credits.toLocaleString() : "—"}</b><span className="text-slate-600"> / mo</span></span>
              <span>board log {boardLogCount.toLocaleString()}</span>
              {stamp && <span>loaded {stamp.toLocaleTimeString()}</span>}
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
                      <div className="w-16 shrink-0 leading-tight" style={mono}>
                        {g.dateLabel && <div className="text-[10px] text-slate-600 truncate">{g.dateLabel}</div>}
                        <div className="text-[11px] text-slate-500">{g.time}</div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-bold truncate">{g.away} <span className="text-slate-600">@</span> {g.home}</div>
                        {(g.status === "LIVE" || g.status === "FINAL") && g.homeScore != null
                          ? <ScoreLine g={g} />
                          : <div className="text-[11px] text-slate-500 truncate">{g.venue || "TBD"}</div>}
                      </div>
                      <Chip s={g.status} />
                    </button>
                    {trackedByGame[g.pk] ? <span title={`${trackedByGame[g.pk]} open tracked bet(s) on this game`} className="shrink-0 text-[10px] font-bold text-emerald-300 bg-emerald-900/40 border border-emerald-800 rounded-full px-1.5 py-0.5" style={mono}>● {trackedByGame[g.pk]}</span> : null}
                    {g.status !== "FINAL" && (
                      <button onClick={() => getOdds(g)} disabled={oddsLoading === g.pk}
                        className={`text-[11px] font-bold rounded px-2 py-1 shrink-0 ${hasOdds ? "bg-slate-700 text-slate-200" : "bg-sky-600 hover:bg-sky-500 text-white"}`}>
                        {oddsLoading === g.pk ? "…" : hasOdds ? "↻ odds" : "get odds"}
                      </button>
                    )}
                    <button onClick={() => expand(g)} className={`text-slate-600 transition ${isOpen ? "rotate-90" : ""}`}>▸</button>
                  </div>

                  {isOpen && (
                    <div className="px-4 pb-4 border-t border-slate-800">
                      {(!d || d.loading) && <div className="py-6 text-center text-sm text-slate-500" style={mono}>loading rosters, depth chart, weather…</div>}
                      {d && d.ready && (
                        <>
                          <div className="flex flex-wrap gap-2 mt-3 text-[11px]" style={mono}>
                            <Env label="VENUE" v={g.venue || "—"} />
                            {d.stadium && d.stadium.dome ? <Env label="ROOF" v="dome/closed" /> : null}
                            {d.weather ? <Env label="TEMP" v={`${d.weather.temp}°`} hot={d.weather.temp >= 90} cold={d.weather.temp <= 32} /> : null}
                            {d.weather ? <Env label="WIND" v={`${d.weather.wind}mph`} hot={d.weather.wind >= 15} /> : null}
                            {d.weather ? <Env label="RAIN" v={`${d.weather.pop}%`} hot={d.weather.pop >= 50} /> : null}
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
                            <div className="text-[10px] text-slate-600 mt-1.5">model line from team scoring env (standings PF/PA × home field) — compare to market for game-line edges once moneyline odds are wired in.</div>
                          </div>
                          <div className="grid md:grid-cols-2 gap-3 mt-3">
                            <LineupCol title={`${g.away} (away)`} d={d} side="away" onPlayerClick={(p) => goToAnalysis(g, "away", p)} />
                            <LineupCol title={`${g.home} (home)`} d={d} side="home" onPlayerClick={(p) => goToAnalysis(g, "home", p)} />
                          </div>
                          <div className="mt-3 flex items-center gap-2 flex-wrap">
                            <button onClick={() => getOdds(g)} disabled={oddsLoading === g.pk} className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-xs font-bold disabled:opacity-50">
                              {oddsLoading === g.pk ? "Fetching odds…" : `Fetch odds & build board (${BOOK_LABELS[book] || book})`}
                            </button>
                            {hasOdds
                              ? <span className="text-[11px] text-emerald-400/80">{hasOdds} priced props on the Board.</span>
                              : (g.status !== "FINAL" && <span className="text-[11px] text-slate-500">Tap to pull {BOOK_LABELS[book] || book} props for this game into the Board.</span>)}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {!games.length && !loading ? <div className="text-slate-500 text-sm py-10 text-center">No games loaded. Try a different week/season, or check the season-type toggle (preseason vs regular season).</div> : null}
          </div>
        )}

        {/* ---------------- BOARD ---------------- */}
        {tab === "board" && (
          <div className="mt-3">
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <input value={boardSearch} onChange={(e) => setBoardSearch(e.target.value)} placeholder="search player or team" className="bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-sm w-44 text-slate-100" />
              <Sel compact label="sort" v={boardSort} opts={["ev_desc", "ev_asc", "edge_desc", "edge_asc", "proj_desc", "proj_asc", "delta_desc", "delta_asc"]} labels={{ ev_desc: "EV ↓", ev_asc: "EV ↑", edge_desc: "Edge ↓", edge_asc: "Edge ↑", proj_desc: "Projection ↓", proj_asc: "Projection ↑", delta_desc: "Proj Δ ↓", delta_asc: "Proj Δ ↑" }} onChange={setBoardSort} />
              <Sel compact label="market" v={classFilter} opts={["all", "props", "lines"]} labels={{ all: "All markets", props: "Player props", lines: "Game lines" }} onChange={setClassFilter} />
              <Sel compact label="category" v={catFilter} opts={["all", ...STAT_ORDER]} labels={{ all: "All categories" }} onChange={setCatFilter} />
              <Sel compact label="game" v={gameFilter} opts={["all", ...boardGames.map((g) => g.pk)]} labels={{ all: "All games", ...Object.fromEntries(boardGames.map((g) => [g.pk, g.label])) }} onChange={setGameFilter} />
              <Sel compact label="side" v={sideFilter} opts={["all", "over", "under", "home", "away"]} labels={{ all: "Both" }} onChange={setSideFilter} />
              {(() => { const n = [minEdge, minModel, minEV, minOdds, maxOdds, minDelta, maxDelta].filter((x) => x !== "").length + (dirAligned ? 1 : 0); return (
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
                <label className="text-xs text-slate-400 flex flex-col gap-1">min EV %
                  <input value={minEV} onChange={(e) => setMinEV(e.target.value)} placeholder="any" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">min proj Δ
                  <input value={minDelta} onChange={(e) => setMinDelta(e.target.value)} placeholder="e.g. 0.5" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">max proj Δ
                  <input value={maxDelta} onChange={(e) => setMaxDelta(e.target.value)} placeholder="e.g. 5.0" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
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
              </div>
            )}
            {boardEntries.length === 0 ? (
              <div className="text-sm text-slate-500 py-10 text-center">No odds pulled yet. On the Slate tab, expand a game and tap <span className="text-sky-400">get odds</span> to load {BOOK_LABELS[book] || book} props here, ranked by EV/edge.</div>
            ) : Object.keys(grouped).length === 0 ? (
              <div className="text-sm text-slate-500 py-10 text-center">No props pass the current filter.</div>
            ) : (
              STAT_ORDER.filter((t) => grouped[t]).map((t) => (
                <div key={t} className="mb-5">
                  <div className="text-[11px] font-bold tracking-wide text-slate-400 mb-1.5 uppercase">{t} <span className="text-slate-600">· {grouped[t].length}</span></div>
                  <div className="space-y-2">
                    {grouped[t].map((e) => <BoardRow key={e.id} e={e} tracked={myBets.some((b) => b.key === e.id)} onTrack={trackBet} showProjBar={showProjBar} />)}
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
                    placeholder="Patrick Mahomes"
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
                League-wide NFL player lookup (any team, any week). Only players with a game loaded for the currently
                selected Week/Season/Year get full matchup context, projections, and odds — switch weeks above if a
                search hit's team is on a bye. You can also click a player name directly on the Slate tab after
                expanding a game, which skips the search step.
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
                        <div className="text-[11px] text-slate-500" style={mono}>{p.teamName || "Free agent / unresolved team"}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {analysisLoading && <div className="text-slate-500 text-sm p-4">Loading player context…</div>}

            {!analysisLoading && !analysisProfile && analysisResults.length === 0 && !analysisErr && (
              <div className="text-slate-500 text-sm p-4">Search any NFL player above, or click a player name on the Slate tab (after expanding a game) to see their full projection breakdown here.</div>
            )}

            {analysisProfile && !analysisLoading && (
              !analysisCtx ? (
                <div className="text-slate-500 text-sm p-4">Loading player context… (expand the game on Slate first so rosters/gamelogs are cached)</div>
              ) : (
                <PlayerAnalysisPanel profile={analysisProfile} ctx={analysisCtx} projections={analysisProjections} boardEntries={analysisBoardEntries} onTrack={trackBet} myBets={myBets} />
              )
            )}
          </div>
        )}

        {/* ---------------- MY BETS ---------------- */}
        {tab === "bets" && (
          <div className="mt-3">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <input value={betSearch} onChange={(e) => setBetSearch(e.target.value)} placeholder="search player or team" className="bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-sm w-44 text-slate-100" />
                <Sel compact label="show" v={betStatusFilter} opts={["all", "open", "settled", "won", "lost", "push", "void"]} labels={{ all: "All", open: "Open", settled: "Settled", won: "Won", lost: "Lost", push: "Push", void: "Void" }} onChange={setBetStatusFilter} />
                <Sel compact label="week" v={betWeekFilter} opts={["all", ...betWeeks]} labels={{ all: "All weeks" }} onChange={setBetWeekFilter} />
                <MultiSel compact label="game" selected={betGameFilters} opts={betGames} onChange={setBetGameFilters} />
                <MultiSel compact label="category" selected={betTypeFilters} opts={betTypes} onChange={setBetTypeFilters} />
                <MultiSel compact label="book" selected={betBookFilters} opts={betBooks} labels={BOOK_LABELS} onChange={setBetBookFilters} />
                <Sel compact label="side" v={betSideFilter} opts={["all", ...betSides]} labels={{ all: "All sides" }} onChange={setBetSideFilter} />
                <Sel compact label="sort" v={betSort} opts={["recent", "game", "model_desc", "model_asc", "ev_desc", "ev_asc", "edge_desc", "edge_asc", "clv_desc", "clv_asc", "delta_desc", "delta_asc"]} labels={{ recent: "Most recent", game: "Game", model_desc: "Model % ↓", model_asc: "Model % ↑", ev_desc: "EV ↓", ev_asc: "EV ↑", edge_desc: "Edge ↓", edge_asc: "Edge ↑", clv_desc: "Line move ↓", clv_asc: "Line move ↑", delta_desc: "Proj Δ ↓", delta_asc: "Proj Δ ↑" }} onChange={setBetSort} />
                <Sel compact label="stake mode (new bets)" v={stakeMode} opts={["flat", "kelly"]} onChange={setStakeMode} />
                {(() => { const n = (betMinModel !== "" ? 1 : 0) + (betMinEdge !== "" ? 1 : 0) + (betMaxEdge !== "" ? 1 : 0) + (betMinOdds !== "" ? 1 : 0) + (betMaxOdds !== "" ? 1 : 0) + (betMinDelta !== "" ? 1 : 0) + (betMaxDelta !== "" ? 1 : 0) + (betDirAligned ? 1 : 0); return (
                  <button onClick={() => setShowMoreBets((s) => !s)} className={`text-xs rounded px-2.5 py-1.5 border ${showMoreBets || n ? "border-emerald-700 text-emerald-300" : "border-slate-700 text-slate-400 hover:text-slate-200"}`}>more{n ? ` (${n})` : ""} {showMoreBets ? "▴" : "▾"}</button>
                ); })()}
                {betFiltersActive && <button onClick={clearBetFilters} className="text-[11px] text-slate-400 hover:text-rose-300 border border-slate-700 rounded px-2.5 py-1.5">clear</button>}
              </div>
              <div className="flex items-center gap-2 self-end">
                <button onClick={exportCSV} className="bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white font-bold text-sm rounded-lg px-3 py-1.5">Download CSV</button>
                <button onClick={backupBets} disabled={myBets.length === 0} className="bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white font-bold text-sm rounded-lg px-3 py-1.5" title="Save a .json backup you can restore later or on another device">Backup</button>
                <label className="bg-slate-700 hover:bg-slate-600 text-white font-bold text-sm rounded-lg px-3 py-1.5 cursor-pointer" title="Restore bets from a .json backup">Restore
                  <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => { restoreBets(e.target.files && e.target.files[0]); e.target.value = ""; }} />
                </label>
                <button onClick={refreshLines} disabled={refreshingLines} className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-bold text-sm rounded-lg px-3 py-1.5" title="Pull the current price for each open tracked bet (line movement / CLV). ~9 credits per game.">{refreshingLines ? "…" : "Refresh lines"}</button>
                <button onClick={settleBets} className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm rounded-lg px-3 py-1.5">Settle finished</button>
                <button onClick={resetStats} className="border border-rose-900 text-rose-400 hover:text-rose-300 text-xs rounded-lg px-3 py-1.5">Clear all</button>
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
            <div className="space-y-2">
              {myBetsView.map((b) => <MyBetRow key={b.key} b={b} onOdds={updateBetOdds} onUnits={updateBetUnits} onRemove={removeBet} />)}
              {!myBetsView.length ? <div className="text-slate-500 text-sm py-10 text-center">{myBets.length ? "No bets match this filter." : "No tracked bets yet — click \"track\" on a Board row."}</div> : null}
            </div>
          </div>
        )}

        {/* ---------------- STATS ---------------- */}
        {tab === "stats" && (
          <div className="mt-3">
            {/* Board Log section — calibration dataset (every prop the model evaluated, not just tracked bets) */}
            <div className="mb-4 p-3 rounded-lg bg-slate-900/60 border border-slate-800">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <div className="text-xs font-bold text-slate-300 mb-0.5">Board Snapshot Log</div>
                  <div className="text-[11px] text-slate-500">
                    Every prop shown on the board is logged here for calibration analysis — not just tracked bets.
                    {boardLogCount > 0
                      ? <span className="text-emerald-400 ml-1">{boardLogCount.toLocaleString()} candidates logged · model {MODEL_VERSION}</span>
                      : <span className="text-slate-600 ml-1">No entries yet — load a game to start logging.</span>}
                    {boardLogSettleMsg && <span className="block mt-0.5 text-sky-400">{boardLogSettleMsg}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={settleFullBoardLog}
                    disabled={boardLogSettling || boardLogCount === 0}
                    className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white font-bold text-xs rounded-lg px-3 py-1.5"
                    title="Grade every board candidate for finished games — uses the free ESPN summary endpoint, no Odds API credits"
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
                    onClick={clearBoardLog}
                    disabled={boardLogCount === 0}
                    className="bg-slate-800 hover:bg-rose-800 disabled:opacity-40 border border-slate-700 text-slate-400 font-bold text-xs rounded-lg px-3 py-1.5"
                    title="Permanently delete all board log entries (export first)"
                  >
                    Clear log
                  </button>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
              <StatCard label="Record" v={`${stats.overall.w}-${stats.overall.l}-${stats.overall.ps}`} />
              <StatCard label="Win %" v={pct(stats.overall.winPct)} good={stats.overall.winPct > 0.5} />
              <StatCard label="Net units" v={stats.overall.net.toFixed(2)} good={stats.overall.net > 0} />
              <StatCard label="ROI" v={pct(stats.overall.roi)} good={stats.overall.roi > 0} />
            </div>
            <div className="text-xs font-bold text-slate-300 mb-2">By category</div>
            <div className="space-y-2">
              {Object.entries(stats.byType).map(([t, s]) => (
                <div key={t} className="flex items-center gap-3 bg-slate-900/70 border border-slate-800 rounded-xl px-4 py-2.5 text-xs flex-wrap">
                  <div className="w-32 font-semibold">{t}</div>
                  <div className="text-slate-400" style={mono}>{s.w}-{s.l}-{s.ps}</div>
                  <div className={s.winPct > 0.5 ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>{pct(s.winPct)}</div>
                  <div className={s.roi > 0 ? "text-emerald-400" : "text-rose-400"}>ROI {pct(s.roi)}</div>
                  <div className="text-slate-500">net {s.net.toFixed(2)}u</div>
                </div>
              ))}
              {!Object.keys(stats.byType).length ? <div className="text-slate-500 text-sm py-10 text-center">Settle some bets to see category breakdowns — this is what drives CALIB_KEEP retuning per doc §5.</div> : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  /* helper bound inside component so it can reach games/detail/setAnalysisProfile */
  function goToAnalysis(g, side, p) {
    setAnalysisProfile({ game: g, side, player: p, detail: detail[g.pk] });
    setAnalysisQuery((p && p.name) || "");
    setAnalysisResults([]);
    setAnalysisErr("");
    setTab("analysis");
  }
}

/* ---------------------- subcomponents ---------------------- */
function Sel({ label, v, opts, labels, onChange, compact }) {
  return (
    <label className="flex items-center gap-1 text-[11px] text-slate-400">
      {label ? <span>{label}</span> : null}
      <select value={v} onChange={(e) => onChange(e.target.value)} className={`bg-slate-950 border border-slate-700 rounded px-2 ${compact ? "py-1" : "py-1.5"} text-xs text-slate-100`}>
        {opts.map((o) => <option key={o} value={o}>{(labels && labels[o]) || o}</option>)}
      </select>
    </label>
  );
}
function MultiSel({ label, selected, opts, labels, onChange, compact }) {
  const [open, setOpen] = useState(false);
  const toggle = (o) => onChange(selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o]);
  const lab = (o) => (labels && labels[o] != null ? labels[o] : o);
  const summary = selected.length === 0 ? "All" : selected.length === 1 ? lab(selected[0]) : `${selected.length} selected`;
  return (
    <div className="relative inline-block">
      <button onClick={() => setOpen((o) => !o)} className={`bg-slate-950 border rounded px-2 ${compact ? "py-1" : "py-1.5"} text-xs whitespace-nowrap ${selected.length ? "border-emerald-700 text-emerald-300" : "border-slate-700 text-slate-100"}`}>
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
// Week/Year use a local text buffer so the field can be freely cleared and retyped —
// only committing (and clamping to [min,max]) on blur/Enter, instead of snapping to `min`
// on every keystroke (the old behavior: clearing "4" fired onChange("") -> +"" || 1 -> 1
// immediately, so you could never type e.g. "14"). Fields with no min/max (the Board tab's
// "min edge %"/"min model %" filters, which meaningfully use "" as "no filter") keep the
// old plain pass-through behavior untouched.
function NumIn({ label, v, onChange, placeholder, min, max }) {
  const clamped = min != null || max != null;
  const [buf, setBuf] = useState(String(v));
  useEffect(() => { if (clamped) setBuf(String(v)); }, [v, clamped]);
  if (!clamped) {
    return (
      <label className="flex items-center gap-1 text-[11px] text-slate-400">
        {label ? <span>{label}</span> : null}
        <input value={v} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} inputMode="decimal" className="w-16 bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-xs text-slate-100" />
      </label>
    );
  }
  const commit = () => {
    const n = +buf;
    if (buf.trim() === "" || !Number.isFinite(n)) { setBuf(String(v)); return; }
    const c = Math.min(max ?? n, Math.max(min ?? n, Math.round(n)));
    setBuf(String(c));
    if (c !== v) onChange(c);
  };
  return (
    <label className="flex items-center gap-1 text-[11px] text-slate-400">
      {label ? <span>{label}</span> : null}
      <input
        value={buf}
        onChange={(e) => setBuf(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { commit(); e.currentTarget.blur(); } }}
        placeholder={placeholder}
        inputMode="numeric"
        className="w-14 bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-xs text-slate-100"
      />
    </label>
  );
}
function StatCard({ label, v, good }) {
  return (
    <div className="border border-slate-800 rounded-lg p-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-lg font-bold ${good == null ? "text-slate-100" : good ? "text-emerald-400" : "text-rose-400"}`}>{v}</div>
    </div>
  );
}
function MiniMetric({ label, value, good }) {
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2">
      <div className="text-[9px] text-slate-500 font-bold tracking-wide">{label}</div>
      <div className={`text-lg font-black ${good === true ? "text-emerald-400" : good === false ? "text-rose-400" : "text-slate-100"}`}>{value}</div>
    </div>
  );
}
function Env({ label, v, hot, cold }) {
  return <span className={`px-2 py-1 rounded border ${hot ? "border-rose-700 bg-rose-950/40 text-rose-300" : cold ? "border-sky-800 bg-sky-950/40 text-sky-300" : "border-slate-700 bg-slate-900 text-slate-300"}`}><span className="text-slate-500">{label} </span>{v}</span>;
}
function InjBadge({ status }) {
  if (!status) return null;
  const c = status === "OUT" || status === "IR" || status === "SUSPENDED" ? "bg-rose-600" : status === "DOUBTFUL" ? "bg-orange-600" : "bg-amber-600";
  return <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold text-white ${c}`}>{status.replace(/_/g, " ")}</span>;
}
// Headline recent-form stat per position (last-4-games rate), a lightweight NFL analogue of
// MLB's L15-vs-season HotBadge — pulled straight from the gamelog the Slate tab already fetches
// for featured players, no new plumbing required.
const L4_HEADLINE = { QB: ["passYds", "pYds"], RB: ["rushYds", "rYds"], WR: ["recYds", "rcYds"], TE: ["recYds", "rcYds"], K: ["kickPts", "pts"] };
function L4Hint({ gl, pos }) {
  const cfg = L4_HEADLINE[pos];
  if (!cfg || !gl || !gl.recent || !gl.recent.games) return null;
  const [key, label] = cfg;
  const perGame = (gl.recent[key] || 0) / gl.recent.games;
  return <span className="text-[9px] text-slate-500 shrink-0" style={mono} title={`last ${gl.recent.games} games`}>L{gl.recent.games} {label} {perGame.toFixed(1)}/g</span>;
}
function PlayerRow({ idx, p, onClick, gl }) {
  return (
    <div className="flex items-center gap-2 text-[12px] px-1 py-1 rounded hover:bg-slate-900/60">
      <span className="text-slate-600 w-4 shrink-0" style={mono}>{idx}</span>
      <span className="w-9 text-[10px] text-slate-500 shrink-0 inline-flex items-center gap-0.5" style={mono}>
        {p.pos}{p.depthRank && p.depthRank < 90 ? p.depthRank : ""}
        {p.depthConfirmed === false && <span className="text-amber-500" title="No confirmed depth chart for this team — pick order falls back to arbitrary roster listing, not a verified starter">?</span>}
      </span>
      <button onClick={() => onClick(p)} className="flex-1 text-left truncate hover:text-sky-300 cursor-pointer" title="Open player analysis">{p.name}</button>
      <L4Hint gl={gl} pos={p.pos} />
      <InjBadge status={p.injuryStatus} />
    </div>
  );
}
function LineupCol({ title, d, side, onPlayerClick }) {
  const teamData = side === "home" ? d.home : d.away;
  if (!teamData) return null;
  const rows = [...teamData.featured, { id: "dst", pos: "DST", name: `${title.split(" ")[0]} D/ST` }];
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1.5">{title}</div>
      <div className="space-y-0.5">
        {rows.map((p, i) => <PlayerRow key={p.id} idx={i + 1} p={p} onClick={onPlayerClick} gl={d.gamelogs && d.gamelogs[p.id]} />)}
      </div>
    </div>
  );
}
// Returns projection-vs-line metadata for the visual buffer indicator, mirroring the MLB
// app's projMeta: delta > 0 means the projection is on the "good" side of the line for the
// bet direction (over: proj > line, under: line > proj).
function projMeta(proj, lineStr, side) {
  const l = parseFloat(String(lineStr));
  if (proj == null || isNaN(l) || l <= 0) return null;
  const delta = side === "over" ? proj - l : l - proj;
  const color = delta < 0 ? "text-rose-400" : delta > 0.3 * l ? "text-emerald-400" : delta > 0.05 * l ? "text-emerald-600" : "text-slate-500";
  const barColor = delta < 0 ? "#f87171" : delta > 0.3 * l ? "#34d399" : "#86efac";
  const max = Math.max(l * 2.5, proj * 1.5, l + 2);
  const linePct = clamp((l / max) * 100, 1, 98);
  const projPct = clamp((proj / max) * 100, 0, 100);
  return { delta, color, barColor, linePct, projPct };
}
function MathPanel({ r }) {
  if (!r || !r.calc) return null;
  const c = r.calc;
  const p = r.modelP, q = p != null ? 1 - p : null;
  const activeMults = (c.mults || []).filter(([, v]) => Math.abs(Number(v) - 1) > 0.0005);
  const chain = activeMults.length ? activeMults.map(([k, v]) => `${k} ${Number(v).toFixed(3)}`).join("  ×  ") : "neutral context";
  return (
    <div className="border-t border-slate-800 px-4 py-2.5 text-[11px] text-slate-400 space-y-1" style={mono}>
      <div><span className="text-slate-500">1 · base</span> &nbsp;{c.baseStr}</div>
      <div><span className="text-slate-500">2 · context</span> &nbsp;{chain}</div>
      <div><span className="text-slate-500">3 · projection</span> &nbsp;E[{r.type}] = <span className="text-sky-300">{(c.proj ?? r.proj) != null ? (c.proj ?? r.proj).toFixed(2) : "—"}</span> &nbsp;→ {c.dist}({c.params})</div>
      {p != null && <div><span className="text-slate-500">4 · model</span> &nbsp;P({r.side} {r.line}) = <span className="text-emerald-300">{pct(p)}</span> → fair {r.fair}</div>}
      {!isNaN(Number(r.odds)) && <div><span className="text-slate-500">5 · market</span> &nbsp;{fmtOdds(r.odds)} {r.devigged ? "(de-vigged" : "(raw"} {r.novig != null ? pct(r.novig) : "—"}{r.devigged ? ")" : ")"}, pays ${r.b != null ? r.b.toFixed(2) : "—"}/$1</div>}
      {p != null && r.b != null && (
        <div><span className="text-slate-500">6 · EV</span> &nbsp;= p·b − (1−p) = ({p.toFixed(3)})({r.b.toFixed(2)}) − ({q.toFixed(3)}) = <span className={r.ev >= 0 ? "text-emerald-300" : "text-rose-300"}>{r.ev >= 0 ? "+" : ""}{r.ev != null ? (r.ev * 100).toFixed(1) : "—"}%</span></div>
      )}
      {r.edge != null && <div className="text-slate-600">edge = model − {r.devigged ? "no-vig" : "implied"} = {r.edge >= 0 ? "+" : ""}{(r.edge * 100).toFixed(1)} pts</div>}
    </div>
  );
}
function BoardRow({ e, tracked, onTrack, showProjBar = true }) {
  const [show, setShow] = useState(false);
  const evGood = e.ev >= 0;
  const pm = !isLineType(e.type) ? projMeta(e.proj, e.line, e.side) : null;
  return (
    <div className="bg-slate-900/70 border border-slate-800 rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 flex-wrap">
        <div className="flex-1 min-w-[160px]">
          <div className="font-semibold truncate">{e.name} <span className="text-slate-500 text-xs">{e.game}</span></div>
          <div className="text-[11px] text-slate-400" style={mono}>
            {e.side} {e.line} {e.type} @ {fmtOdds(e.odds)} · <span className="text-sky-300">proj {e.proj != null ? e.proj.toFixed(2) : "—"}</span>
            {pm && <span className={`ml-1.5 font-bold ${pm.color}`}>{pm.delta >= 0 ? "+" : "−"}{Math.abs(pm.delta).toFixed(2)}</span>}
          </div>
        </div>
        <div className="text-right text-[11px]" style={mono}>
          <div className="text-slate-400">model {pct(e.modelP)} · fair {e.fair}</div>
          <div className={evGood ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>EV {evGood ? "+" : ""}{e.ev != null ? (e.ev * 100).toFixed(1) : "—"}% · edge {e.edge != null ? `${e.edge >= 0 ? "+" : ""}${(e.edge * 100).toFixed(1)}%` : "—"}</div>
        </div>
        <button onClick={() => setShow((s) => !s)} className="text-[11px] text-slate-500 hover:text-emerald-300 border border-slate-700 rounded px-2 py-1">{show ? "hide" : "math"}</button>
        <button onClick={() => onTrack(e)} disabled={tracked} className={`text-[11px] font-bold rounded px-2 py-1 ${tracked ? "bg-slate-700 text-slate-400" : "bg-emerald-600 hover:bg-emerald-500 text-white"}`}>{tracked ? "tracked" : "track"}</button>
      </div>
      {pm && showProjBar && (
        <div className="relative h-1 mx-4 mb-2.5 bg-slate-800 rounded-full overflow-hidden" title={`proj ${e.proj != null ? e.proj.toFixed(2) : "—"} vs line ${e.line}`}>
          <div className="absolute inset-y-0 left-0" style={{ width: `${pm.projPct}%`, backgroundColor: pm.barColor }} />
          <div className="absolute inset-y-0 w-px bg-white/70" style={{ left: `${pm.linePct}%` }} />
        </div>
      )}
      {show && <MathPanel r={e} />}
    </div>
  );
}
function MyBetRow({ b, onOdds, onUnits, onRemove }) {
  const statusColor = { open: "bg-slate-700 text-slate-300", won: "bg-emerald-600 text-white", lost: "bg-rose-600 text-white", push: "bg-amber-600 text-slate-950", void: "bg-slate-600 text-slate-200" }[b.status] || "bg-slate-700 text-slate-300";
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
        <input value={b.odds} onChange={(e) => onOdds(b.key, e.target.value)} inputMode="numeric" className="w-16 bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-sm text-slate-100 text-right" />
      </label>
      <label className="text-[10px] text-slate-500 flex flex-col items-end gap-0.5">units
        <input value={b.units} onChange={(e) => onUnits(b.key, e.target.value)} inputMode="decimal" className="w-14 bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-sm text-slate-100 text-right" />
        {b.suggested > 0 && <span className="text-[9px] text-slate-600">sug {b.suggested}u</span>}
      </label>
      <div className="text-right text-[11px] w-28" style={mono}>
        {b.modelP != null ? <>
          <div className="text-slate-400">model {pct(b.modelP)}</div>
          <div className={b.ev >= 0 ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>EV {b.ev != null ? `${b.ev >= 0 ? "+" : ""}${(b.ev * 100).toFixed(1)}%` : "—"} · edge {b.edge != null ? `${b.edge >= 0 ? "+" : ""}${(b.edge * 100).toFixed(1)}%` : "—"}</div>
        </> : <div className="text-slate-600">manual</div>}
        {profit != null && <div className={profit >= 0 ? "text-emerald-400" : "text-rose-400"}>{profit >= 0 ? "+" : ""}{profit.toFixed(2)}u</div>}
      </div>
      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${statusColor}`}>{b.status}</span>
      <button onClick={() => onRemove(b.key)} className="text-slate-600 hover:text-rose-400 text-lg leading-none">×</button>
    </div>
  );
}
function AnalysisProjectionRow({ r }) {
  const [show, setShow] = useState(false);
  return (
    <div className="bg-slate-900/70 border border-slate-800 rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 flex-wrap">
        <div className="w-32 font-semibold shrink-0">{r.type}</div>
        <div className="text-[11px] text-slate-400" style={mono}>line {r.line} · <span className="text-sky-300">proj {r.proj != null ? r.proj.toFixed(2) : "—"}</span></div>
        <div className="text-[11px] ml-auto flex items-center gap-3" style={mono}>
          <span className="text-emerald-400">O {pct(r.overP)} ({r.overFair})</span>
          <span className="text-rose-400">U {pct(r.underP)} ({r.underFair})</span>
          {r.calc ? <button onClick={() => setShow((s) => !s)} className="text-slate-500 hover:text-emerald-300 border border-slate-700 rounded px-2 py-1">{show ? "hide" : "math"}</button> : null}
        </div>
      </div>
      {show && <MathPanel r={r} />}
    </div>
  );
}
function PlayerAnalysisPanel({ profile, ctx, projections, boardEntries, onTrack, myBets }) {
  const p = profile.player;
  const pos = ctx.pos;
  const season = ctx.season, recent = ctx.recent;
  // A gamelog object can be truthy but real-zero-games (e.g. Week 1, before the player has
  // played) — that's a valid state, not a fetch failure, so guard on games-played, not just
  // truthiness, or every stat quad renders a misleading "0" instead of "—".
  const hasSeason = !!(season && season.g > 0);
  const hasRecent = !!(recent && recent.games > 0);
  const teamName = profile.side === "home" ? profile.game.home : profile.game.away;
  const rate = (obj, key) => obj && obj.g ? ((obj[key] || 0) / obj.g).toFixed(1) : "—";
  return (
    <div className="space-y-3">
      <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-start gap-3">
            <img
              src={`https://a.espncdn.com/i/headshots/nfl/players/full/${p.id}.png`}
              alt=""
              className="w-16 h-16 rounded-xl object-cover border border-slate-700 bg-slate-800 flex-shrink-0"
              onError={(e) => { e.currentTarget.style.display = "none"; }}
            />
            <div>
              <div className="text-2xl font-black tracking-tight">{p.name}</div>
              <div className="text-[11px] text-slate-500 mt-1" style={mono}>
                {teamName || "—"} · {pos}{p.depthRank && p.depthRank < 90 ? p.depthRank : ""}
                {p.depthConfirmed === false && <span className="text-amber-500 ml-1" title="No confirmed depth chart for this team — pick order falls back to arbitrary roster listing, not a verified starter">(no confirmed depth chart)</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <InjBadge status={ctx.injuryStatus} />
            <Chip s={profile.game.status} />
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
          {pos === "QB" ? (
            <>
              <MiniMetric label="Pass Yds" value={hasSeason ? Math.round(season.passYds || 0) : "—"} />
              <MiniMetric label="Pass TD" value={hasSeason ? (season.passTd || 0) : "—"} />
              <MiniMetric label="INT" value={hasSeason ? (season.ints || 0) : "—"} />
              <MiniMetric label="Yds/G" value={rate(season, "passYds")} />
            </>
          ) : pos === "RB" ? (
            <>
              <MiniMetric label="Rush Yds" value={hasSeason ? Math.round(season.rushYds || 0) : "—"} />
              <MiniMetric label="Rush TD" value={hasSeason ? (season.rushTd || 0) : "—"} />
              <MiniMetric label="Rec" value={hasSeason ? (season.rec || 0) : "—"} />
              <MiniMetric label="YPC" value={hasSeason && season.rushAtt ? (season.rushYds / season.rushAtt).toFixed(1) : "—"} />
            </>
          ) : pos === "WR" || pos === "TE" ? (
            <>
              <MiniMetric label="Rec" value={hasSeason ? (season.rec || 0) : "—"} />
              <MiniMetric label="Rec Yds" value={hasSeason ? Math.round(season.recYds || 0) : "—"} />
              <MiniMetric label="Rec TD" value={hasSeason ? (season.recTd || 0) : "—"} />
              <MiniMetric label="Yds/Rec" value={hasSeason && season.rec ? (season.recYds / season.rec).toFixed(1) : "—"} />
            </>
          ) : pos === "K" ? (
            <>
              <MiniMetric label="FG Made" value={hasSeason ? (season.fgMade || 0) : "—"} />
              <MiniMetric label="Kick Pts" value={hasSeason ? (season.kickPts || 0) : "—"} />
              <MiniMetric label="Pts/G" value={rate(season, "kickPts")} />
              <MiniMetric label="Games" value={hasSeason ? season.g : "—"} />
            </>
          ) : (
            <>
              <MiniMetric label="Sacks" value={hasSeason ? (season.sacks || 0) : "—"} />
              <MiniMetric label="INT" value={hasSeason ? (season.defInt || 0) : "—"} />
              <MiniMetric label="Games" value={hasSeason ? season.g : "—"} />
              <MiniMetric label="Depth" value={p.depthRank && p.depthRank < 90 ? `#${p.depthRank}` : "—"} />
            </>
          )}
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-3">
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
          <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1.5">MATCHUP</div>
          <div className="text-[11px] text-slate-300 space-y-1" style={mono}>
            <div>{profile.game.away} @ {profile.game.home}</div>
            <div>game script (spread): {ctx.teamSpread != null ? ctx.teamSpread.toFixed(1) : "—"}</div>
            <div>implied team pts: {ctx.impliedTeamPts != null ? ctx.impliedTeamPts.toFixed(1) : "—"}</div>
            <div>weather: {ctx.weather ? `${ctx.weather.temp}°F, wind ${ctx.weather.wind}mph` : ctx.stadium && ctx.stadium.dome ? "dome/closed" : "—"}</div>
          </div>
        </div>
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
          <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1.5">SEASON (THIS YEAR)</div>
          <div className="text-[11px] text-slate-300 space-y-0.5" style={mono}>
            {hasSeason ? Object.entries(season).filter(([k]) => k !== "g").map(([k, v]) => <div key={k}>{k}: {typeof v === "number" ? v.toFixed(1) : v}</div>) : <div className="text-slate-600">no season log yet</div>}
          </div>
        </div>
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
          <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1.5">LAST 4 GAMES</div>
          <div className="text-[11px] text-slate-300 space-y-0.5" style={mono}>
            {hasRecent ? Object.entries(recent).filter(([k]) => k !== "games").map(([k, v]) => <div key={k}>{k}: {typeof v === "number" ? v.toFixed(1) : v}</div>) : <div className="text-slate-600">no recent log yet</div>}
          </div>
        </div>
      </div>

      <GameLogCard pos={pos} games={ctx.games} />

      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
        <div className="text-xs font-bold text-slate-300">Model Projections</div>
        <div className="text-[11px] text-slate-500 mb-2" style={mono}>every major {pos} prop, priced to the default line</div>
        <div className="space-y-2">{projections.map((r) => <AnalysisProjectionRow key={r.type} r={r} />)}</div>
      </div>

      {boardEntries.length ? (
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
          <div className="text-xs font-bold text-slate-300 mb-2">Live market lines for this player (from Board)</div>
          <div className="space-y-2">{boardEntries.map((e) => <BoardRow key={e.id} e={e} tracked={myBets.some((b) => b.key === e.id)} onTrack={onTrack} />)}</div>
        </div>
      ) : null}
    </div>
  );
}
// Per-game log table, mirroring MLB's GameLogCard — most-recent-first, capped at GAMELOG_ROWS.
// Columns are position-specific; any missing field renders "—" rather than crashing, since the
// underlying gamelog fetch (fetchAthleteGamelog) degrades to games: [] when ESPN's per-event
// metadata can't be reliably paired with its stat row.
function GameLogCard({ pos, games }) {
  const rows = (games || []).slice(0, GAMELOG_ROWS);
  const cols = pos === "QB" ? [["passCmp", "CMP"], ["passAtt", "ATT"], ["passYds", "YDS"], ["passTd", "TD"], ["ints", "INT"]]
    : pos === "RB" ? [["rushAtt", "CAR"], ["rushYds", "YDS"], ["rushTd", "TD"], ["rec", "REC"]]
    : (pos === "WR" || pos === "TE") ? [["targets", "TGT"], ["rec", "REC"], ["recYds", "YDS"], ["recTd", "TD"]]
    : pos === "K" ? [["fgMade", "FG"], ["kickPts", "PTS"]]
    : [["sacks", "SACK"], ["defInt", "INT"]];
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">LAST {GAMELOG_ROWS} GAMES</div>
      {!rows.length ? <div className="text-sm text-slate-500">No game log returned.</div> : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]" style={mono}>
            <thead className="text-slate-600">
              <tr>{["wk", "opp", ...cols.map(([, h]) => h)].map((h) => <th key={h} className="text-right font-semibold py-1 first:text-left">{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((g, i) => (
                <tr key={g.eventId || i} className="border-t border-slate-800/80">
                  <td className="py-1 text-left text-slate-400">{g.week != null ? g.week : "—"}</td>
                  <td className="text-right text-slate-400">{g.atVs || ""} {g.opp || "—"}</td>
                  {cols.map(([k]) => <td key={k} className="text-right text-slate-200">{g[k] != null ? g[k] : "—"}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}