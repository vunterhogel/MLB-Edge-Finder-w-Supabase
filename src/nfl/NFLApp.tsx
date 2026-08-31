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
  const passAttRaw = blendRate(s.passAtt && s.g ? s.passAtt / s.g : LG.teamPassAtt * 0.98, lOK ? l.passAtt / l.games : null, RECENT_WEIGHT);
  const passAtt = shrinkValue(passAttRaw, s.g || 0, LG.teamPassAtt * 0.98, SHRINK_N.passAtt);
  const compPct = shrinkRate(s.passAtt ? s.passCmp / s.passAtt : 0, s.passAtt || 0, LG.compPct, SHRINK_N.rate);
  const ypc = shrinkRate(s.passCmp ? s.passYds / s.passCmp : 0, s.passCmp || 0, LG.ypa / LG.compPct, SHRINK_N.rate);
  const passTdRate = shrinkRate(s.passAtt ? s.passTd / s.passAtt : 0, s.passAtt || 0, LG.passTdRate, SHRINK_N.rate);
  const intRate = shrinkRate(s.passAtt ? s.ints / s.passAtt : 0, s.passAtt || 0, LG.intRate, SHRINK_N.rate);
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
    "Longest Completion": { mean: clamp(passYds / Math.max(passCmp, 1) * 2.6, 8, 60), phi: NB_PHI.longestCmp }, // derived from yards dist upper tail (doc §3)
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
  const rushAttRaw = blendRate(s.rushAtt && s.g ? s.rushAtt / s.g : LG.teamRushAtt * (ctx.touchShare || 0.4), lOK ? l.rushAtt / l.games : null, RECENT_WEIGHT);
  const rushAtt = shrinkValue(rushAttRaw, s.g || 0, LG.teamRushAtt * (ctx.touchShare || 0.4), SHRINK_N.rushAtt);
  const ypc = shrinkRate(s.rushAtt ? s.rushYds / s.rushAtt : 0, s.rushAtt || 0, LG.rushYpc, SHRINK_N.rate);
  const rushTdRate = shrinkRate(s.rushAtt ? s.rushTd / s.rushAtt : 0, s.rushAtt || 0, LG.rushTdRate, SHRINK_N.rate);
  const targetsRaw = blendRate(s.targets && s.g ? s.targets / s.g : LG.targetShareRB * LG.teamPassAtt, lOK ? l.targets / l.games : null, RECENT_WEIGHT);
  const targets = shrinkValue(targetsRaw, s.g || 0, LG.targetShareRB * LG.teamPassAtt, SHRINK_N.targets);
  const catchRate = shrinkRate(s.targets ? s.rec / s.targets : 0, s.targets || 0, LG.catchRate + 0.05, SHRINK_N.rate); // RBs catch a slightly higher % of (shorter) targets
  const ypt = shrinkRate(s.targets ? s.recYds / s.targets : 0, s.targets || 0, LG.ypt * 0.7, SHRINK_N.rate); // RB targets are shorter-developing than WR targets
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
  const table = {
    "Rush Yards": { mean: rushYds, phi: NB_PHI.rushYds },
    "Rush TDs": { mean: rushTd, phi: NB_PHI.rushTd },
    "Longest Rush": { mean: clamp(rushYds / Math.max(rushAtt, 1) * 3.2, 4, 40), phi: NB_PHI.longestRush },
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
  const targetsRaw = blendRate(s.targets && s.g ? s.targets / s.g : LG.teamPassAtt * shareDefault, lOK ? l.targets / l.games : null, RECENT_WEIGHT);
  const targets = shrinkValue(targetsRaw, s.g || 0, LG.teamPassAtt * shareDefault, SHRINK_N.targets);
  const catchRate = shrinkRate(s.targets ? s.rec / s.targets : 0, s.targets || 0, LG.catchRate, SHRINK_N.rate);
  const ypt = shrinkRate(s.targets ? s.recYds / s.targets : 0, s.targets || 0, LG.ypt, SHRINK_N.rate);
  const recTdRate = shrinkRate(s.targets ? s.recTd / s.targets : 0, s.targets || 0, LG.recTdRate, SHRINK_N.rate);
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
  const table = {
    "Receptions": { mean: rec, phi: NB_PHI.rec },
    "Receiving Yards": { mean: recYds, phi: NB_PHI.recYds },
    "Receiving TDs": { mean: recTd, phi: NB_PHI.recTd },
    "Longest Reception": { mean: clamp(recYds / Math.max(rec, 1) * 2.4, 8, 55), phi: NB_PHI.longestRec },
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
function refId(ref) { if (!ref) return null; const m = String(ref).match(/\/(\d+)(?:[/?]|$)/); return m ? m[1] : null; }

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
  // Rough season-structure heuristic (Labor Day anchors Week 1): good enough as a DEFAULT,
  // always overridable in the UI — mirrors MLB's date picker defaulting to "today" but letting
  // you pick any date.
  const y = today.getFullYear();
  const laborDay = (() => { const d = new Date(y, 8, 1); while (d.getDay() !== 1) d.setDate(d.getDate() + 1); return d; })();
  const week1Kickoff = new Date(laborDay); week1Kickoff.setDate(week1Kickoff.getDate() + 3); // first Thursday after Labor Day
  const preseasonStart = new Date(y, 7, 1);
  if (today < preseasonStart) return { seasonType: 2, week: 18, year: y - 1 }; // offseason -> show last week of prior season
  if (today < week1Kickoff) { const wk = clamp(Math.ceil((today - preseasonStart) / 6.048e8) + 1, 1, 4); return { seasonType: 1, week: wk, year: y }; }
  const wk = clamp(Math.floor((today - week1Kickoff) / 6.048e8) + 1, 1, 18);
  return { seasonType: 2, week: wk, year: y };
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
function findStatArrays(node, names, depth, out) {
  if (depth > 8 || node == null) return;
  if (Array.isArray(node)) {
    if (node.length === names.length && node.every((x) => typeof x === "string" || typeof x === "number" || x === "")) out.push(node);
    else node.forEach((c) => findStatArrays(c, names, depth + 1, out));
  } else if (typeof node === "object") {
    for (const k in node) findStatArrays(node[k], names, depth + 1, out);
  }
}
function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }
// stat-name aliases: ESPN's `names` array wording drifts by season; match tolerantly.
const STAT_ALIASES = {
  passAtt: ["passingAttempts", "attempts"], passCmp: ["completions"], passYds: ["passingYards", "netPassingYards"],
  passTd: ["passingTouchdowns", "passingTDs"], ints: ["interceptions"],
  rushAtt: ["rushingAttempts", "carries"], rushYds: ["rushingYards"], rushTd: ["rushingTouchdowns", "rushingTDs"],
  targets: ["receivingTargets", "targets"], rec: ["receptions"], recYds: ["receivingYards"], recTd: ["receivingTouchdowns", "receivingTDs"],
  fgMade: ["fieldGoalsMade"], kickPts: ["totalPoints", "kickingPoints"],
  sacks: ["sacks"], defInt: ["interceptions"],
};
function pickAlias(names, key) {
  const cands = STAT_ALIASES[key] || [key];
  for (const c of cands) { const i = names.findIndex((n) => String(n).toLowerCase() === c.toLowerCase()); if (i >= 0) return i; }
  return -1;
}
async function fetchAthleteGamelog(athleteId, n = 4) {
  try {
    const d = await jget(`${ESPN_WEB}/athletes/${athleteId}/gamelog`);
    const names = d.names || [];
    if (!names.length) return null;
    const rows = [];
    findStatArrays(d.events || d, names, 0, rows);
    const idx = {};
    for (const k in STAT_ALIASES) idx[k] = pickAlias(names, k);
    const toRec = (row) => { const r = {}; for (const k in idx) if (idx[k] >= 0) r[k] = num(row[idx[k]]); return r; };
    const all = rows.map(toRec);
    const sum = (arr) => arr.reduce((acc, r) => { for (const k in r) acc[k] = (acc[k] || 0) + r[k]; return acc; }, { g: arr.length });
    const season = sum(all); season.g = all.length;
    const recentSlice = all.slice(-n);
    const recent = sum(recentSlice); recent.games = recentSlice.length;
    return { season, recent };
  } catch { return null; }
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
    const final = !!(d.header && d.header.competitions && d.header.competitions[0] && d.header.competitions[0].status && d.header.competitions[0].status.type && d.header.competitions[0].status.type.completed);
    const comp = d.header && d.header.competitions && d.header.competitions[0];
    const home = comp && (comp.competitors || []).find((c) => c.homeAway === "home");
    const away = comp && (comp.competitors || []).find((c) => c.homeAway === "away");
    const players = {};
    for (const team of d.boxscore && d.boxscore.players || []) {
      for (const cat of team.statistics || []) {
        for (const ath of cat.athletes || []) {
          const id = ath.athlete && ath.athlete.id; if (!id) continue;
          players[id] = players[id] || { participated: true };
          const labels = cat.labels || cat.names || [];
          (ath.stats || []).forEach((v, i) => { const label = labels[i]; if (label) players[id][label] = num(v); });
        }
      }
    }
    return { final, homeScore: home ? +home.score : null, awayScore: away ? +away.score : null, players };
  } catch { return { final: false, homeScore: null, awayScore: null, players: {} }; }
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
  const lambdaH = d.lambdaH, lambdaA = d.lambdaA;
  const projH = lambdaH, projA = lambdaA;
  const total = projH + projA;
  const totalPt = gl.totals && gl.totals.point != null ? gl.totals.point : null;
  const gp = jointGameProbs(lambdaH, lambdaA, 0, 0, totalPt);
  const base = `model line: ${g.away} ${projA.toFixed(1)} – ${projH.toFixed(1)} ${g.home}`;
  const mk = (name, type, line, side, odds, oppOdds, modelP0, proj, params) => {
    if (odds == null) return null;
    const imp = impliedProb(odds);
    const novig = oppOdds != null ? (imp / (imp + impliedProb(oppOdds))) : imp;
    const modelP = calibrateToMarket(modelP0, novig, type);
    const bm = odds > 0 ? odds / 100 : 100 / -odds;
    return {
      id: `${g.pk}-line-${type}-${side}`, gamePk: g.pk, game: `${g.away}@${g.home}`, name, type, line: String(line), side, odds, overOdds: null, underOdds: null, book,
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
  const newRows = entries.filter((e) => e.modelP != null && e.novig != null).map((e) => {
    const logId = `${weekKey}|${e.id}`;
    return {
      logId, loggedAt: now, modelVersion, week: weekKey,
      game: e.game, gamePk: String(e.gamePk), playerId: String(e.playerId ?? ""), name: e.name, type: e.type, line: e.line, side: e.side, odds: e.odds,
      novig: e.novig != null ? +e.novig.toFixed(4) : null, rawModelP: e.rawModelP != null ? +e.rawModelP.toFixed(4) : null,
      calibratedP: e.modelP != null ? +e.modelP.toFixed(4) : null, edge: e.edge != null ? +e.edge.toFixed(4) : null, ev: e.ev != null ? +e.ev.toFixed(4) : null, proj: e.proj != null ? +e.proj.toFixed(3) : null,
      settled: false, actualStat: null, result: null,
    };
  }).filter((e) => !existingIds.has(e.logId));
  if (!newRows.length) return;
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

/* ---- settling helpers ---- */
const STAT_LABEL_FOR = {
  "Pass Yards": ["YDS"], "Pass TDs": ["TD"], "Interceptions": ["INT"], "Pass Completions": ["CMP"], "Pass Attempts": ["ATT"],
  "Rush Yards": ["YDS"], "Rush TDs": ["TD"], "Receptions": ["REC"], "Receiving Yards": ["YDS"], "Receiving TDs": ["TD"],
  "Kicking Points": ["PTS"], "Field Goals Made": ["FG"], "Sacks": ["SACKS"], "Def. Interceptions": ["INT"],
};
function actualFor(type, ps) {
  if (!ps) return null;
  const labels = STAT_LABEL_FOR[type];
  if (!labels) return null;
  for (const l of labels) if (ps[l] != null) return ps[l];
  return null;
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
  const [boardSort, setBoardSort] = useState("ev_desc");
  const [minEdge, setMinEdge] = useState("");
  const [minModel, setMinModel] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const [boardSearch, setBoardSearch] = useState("");
  const [gameFilter, setGameFilter] = useState("all");
  const [sideFilter, setSideFilter] = useState("all");
  const [classFilter, setClassFilter] = useState("all"); // all | props | lines
  const [analysisProfile, setAnalysisProfile] = useState(null); // { player, game, side }
  const [analysisQuery, setAnalysisQuery] = useState("");
  const [analysisResults, setAnalysisResults] = useState([]);
  const [analysisSearching, setAnalysisSearching] = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisErr, setAnalysisErr] = useState("");
  const [betStatusFilter, setBetStatusFilter] = useState("all");
  const [betSort, setBetSort] = useState("recent");
  const [betSearch, setBetSearch] = useState("");
  const [stakeMode, setStakeMode] = useState("flat");
  const [myBets, setMyBets] = useState(loadBets());
  const [settleMsg, setSettleMsg] = useState("");
  const eventsRef = useRef({ sportKey: null, events: null });
  const inflight = useRef(new Set());

  useEffect(() => { saveBets(myBets); }, [myBets]);
  useEffect(() => { void settleBoardLog(myBets); }, [myBets]);
  useEffect(() => { boardLogReady.then((rows) => setBoardLogCount(rows.length)); }, []);
  useEffect(() => { if (credits != null) { try { localStorage.setItem(LS_CREDITS, String(credits)); } catch {} } }, [credits]);

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
    const pick = (pos, n) => (byPos[pos] || []).slice().sort((a, b) => rankOf(a) - rankOf(b)).slice(0, n);
    return [...pick("QB", 1), ...pick("RB", 2), ...pick("WR", 3), ...pick("TE", 1), ...pick("PK", 1), ...pick("K", 1)]
      .map((p) => ({ ...p, depthRank: rankOf(p) }));
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
    const tasks = [];
    for (const p of [...featH, ...featA]) {
      tasks.push(fetchAthleteGamelog(p.id, 4).then((gl) => { gamelogs[p.id] = gl; }).catch(() => {}));
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
      gamelogs, lambdaH, lambdaA,
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
    const impliedTeamPts = isHome ? d.lambdaH : d.lambdaA;
    const marketSpread = g.marketSpreadHome != null ? (isHome ? g.marketSpreadHome : -g.marketSpreadHome) : null;
    const modelSpread = isHome ? (d.lambdaA - d.lambdaH) : (d.lambdaH - d.lambdaA); // signed FOR this team (positive = underdog)
    const teamSpread = marketSpread != null ? marketSpread : modelSpread;
    return {
      pos: p.pos === "PK" ? "K" : p.pos,
      season: gl ? gl.season : null, recent: gl ? gl.recent : null,
      teamSpread, weather: d.weather, stadium: d.stadium,
      injuryStatus: p.injuryStatus, depthRank: p.depthRank,
      impliedTeamPts, teamDrivesPerGame: 10.8, redZoneTdRate: 0.58,
      oppPassAtt: LG.teamPassAtt, teamSackRate: LG.sackRatePerPassAtt, teamDefIntRate: LG.defIntRatePerPassAtt,
      // opponent-allowed splits: neutral (1x) until wired to a verified per-position-allowed source —
      // see INTEGRATION.md "known v1 simplifications". oppRAPG-style team proxy IS wired (teamSpread/impliedTeamPts).
      oppPassYdsAllowed: null, lgPassYdsAllowed: null, oppPassTdAllowed: null, lgPassTdAllowed: null,
      oppDefTakeaways: null, lgDefTakeaways: null, oppRushYdsAllowed: null, lgRushYdsAllowed: null,
      oppRushTdAllowed: null, lgRushTdAllowed: null, oppPassYdsAllowedToRB: null, lgPassYdsAllowedToRB: null,
      oppPassYdsAllowedToPos: null, lgPassYdsAllowedToPos: null, oppPassTdAllowedToPos: null, lgPassTdAllowedToPos: null,
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
          const bet = { gamePk: g.pk, game: `${g.away}@${g.home}`, playerId: found.id, name: found.name, type: row.type, line: String(row.point), side, odds, overOdds: row.over, underOdds: row.under, ctx: found.ctx, book };
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
  const grouped = useMemo(() => {
    const minE = parseFloat(minEdge);
    const minM = parseFloat(minModel);
    const f = boardEntries.filter((e) => {
      if (e.modelP == null) return false;
      if (e.modelP >= 0.999 || e.modelP <= 0.001) return false;
      if (!isNaN(minE) && !(e.edge != null && e.edge * 100 >= minE)) return false;
      if (!isNaN(minM) && !(e.modelP * 100 >= minM)) return false;
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
    }[boardSort];
    const out = {};
    for (const t of STAT_ORDER) { const arr = f.filter((e) => e.type === t).sort(cmp); if (arr.length) out[t] = arr; }
    return out;
  }, [boardEntries, boardSort, minEdge, minModel, catFilter, classFilter, gameFilter, sideFilter, boardSearch]);
  const filtersActive = classFilter !== "all" || catFilter !== "all" || gameFilter !== "all" || sideFilter !== "all" || minEdge !== "" || minModel !== "" || boardSearch !== "";
  function clearFilters() { setClassFilter("all"); setCatFilter("all"); setGameFilter("all"); setSideFilter("all"); setMinEdge(""); setMinModel(""); setBoardSearch(""); }

  /* ---- my bets ---- */
  function trackBet(e) {
    const exists = myBets.some((b) => b.key === e.id);
    if (exists) return;
    const sug = suggestedUnits(e.modelP, Number(e.odds));
    const units = stakeMode === "kelly" ? (sug > 0 ? sug : 1) : 1;
    const rec = { key: e.id, week: weekKey, gamePk: e.gamePk, game: e.game, playerId: e.playerId, name: e.name, type: e.type, line: e.line, side: e.side, odds: e.odds, book: e.book, modelP: e.modelP, proj: e.proj, novig: e.novig, units, suggested: sug, status: "open", actual: null };
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
    let graded = 0;
    setMyBets((prev) => prev.map((b) => {
      if (b.status !== "open") return b;
      const res = results[b.gamePk]; if (!res || !res.final) return b;
      if (isLineType(b.type)) {
        const { status, actual } = gradeLine(b.type, b.side, parseFloat(b.line), res.homeScore, res.awayScore);
        if (!status) return b; graded++; return { ...b, status, actual };
      }
      const ps = res.players[b.playerId];
      if (!ps) { graded++; return { ...b, status: "void", actual: "DNP" }; }
      const actual = actualFor(b.type, ps);
      const st = gradeBet(b.side, parseFloat(b.line), actual);
      if (st == null) return b;
      graded++; return { ...b, status: st, actual };
    }));
    setSettleMsg(`Settled ${graded} bet(s). Unsettled games are still in progress.`);
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
      return { ...b, imp, edge, ev, units, suggested, _i: i };
    });
    if (betStatusFilter === "settled") arr = arr.filter((b) => b.status !== "open");
    else if (betStatusFilter !== "all") arr = arr.filter((b) => b.status === betStatusFilter);
    if (betSearch.trim()) arr = arr.filter((b) => matchesQuery(b, betSearch));
    const cmp = {
      recent: (a, b) => a._i - b._i,
      model_desc: (a, b) => (b.modelP ?? -9) - (a.modelP ?? -9),
      ev_desc: (a, b) => (b.ev ?? -9) - (a.ev ?? -9),
      edge_desc: (a, b) => (b.edge ?? -9) - (a.edge ?? -9),
    }[betSort] || ((a, b) => a._i - b._i);
    return arr.sort(cmp);
  }, [myBets, betStatusFilter, betSort, betSearch]);

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
    <div className="min-h-screen bg-slate-950 text-slate-100 text-[13px]">
      <div className="sticky top-0 z-20 bg-slate-950/95 backdrop-blur border-b border-slate-800 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="font-bold text-sm text-emerald-400 mr-2">🏈 NFL Edge Finder</div>
          <Sel label="" v={seasonType} opts={[1, 2, 3]} labels={SEASON_TYPE_LABEL} onChange={(v) => setSeasonType(+v)} compact />
          <NumIn label="Week" v={week} onChange={(v) => setWeek(clamp(+v || 1, 1, 22))} placeholder="wk" />
          <NumIn label="Year" v={year} onChange={(v) => setYear(+v || year)} placeholder="yr" />
          <button onClick={loadSchedule} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs">{loading ? "Loading…" : "Refresh"}</button>
          <Sel label="Book" v={book} opts={BOOKS.map((b) => b.key)} labels={BOOK_LABELS} onChange={setBook} compact />
          <div className="text-[11px] text-slate-500 ml-auto">{credits != null ? `${credits} odds credits left` : ""} · board log {boardLogCount.toLocaleString()}</div>
        </div>
        <div className="flex gap-1 mt-2">
          {TABS.map((t) => (
            <button key={t.k} onClick={() => setTab(t.k)} className={`px-3 py-1.5 rounded text-xs font-semibold ${tab === t.k ? "bg-emerald-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>{t.t}</button>
          ))}
        </div>
        {err ? <div className="mt-2 text-[11px] text-amber-400">{err}</div> : null}
      </div>

      <div className="p-3">
        {/* ---------------- SLATE ---------------- */}
        {tab === "slate" && (
          <div className="space-y-2">
            {stamp ? <div className="text-[11px] text-slate-500">Loaded {stamp.toLocaleTimeString()} · Week {week}, {SEASON_TYPE_LABEL[seasonType]} {year}</div> : null}
            {games.map((g) => (
              <div key={g.pk} className="border border-slate-800 rounded-lg overflow-hidden">
                <button onClick={() => expand(g)} className="w-full flex items-center gap-3 px-3 py-2 bg-slate-900 hover:bg-slate-800 text-left">
                  <Chip s={g.status} />
                  <div className="flex-1 font-semibold">{g.away} @ {g.home}</div>
                  <ScoreLine g={g} />
                  <div className="text-[11px] text-slate-500">{g.time}</div>
                  <div className="text-[11px] text-slate-500">{g.venue}</div>
                </button>
                {open === g.pk && (
                  <div className="p-3 bg-slate-900/40 border-t border-slate-800">
                    {!detail[g.pk] || detail[g.pk].loading ? <div className="text-slate-500 text-xs">Loading rosters, depth chart, weather…</div> : (
                      <div className="grid md:grid-cols-2 gap-3">
                        <LineupCol title={`${g.away} (away)`} d={detail[g.pk]} side="away" onPlayerClick={(p) => goToAnalysis(g, "away", p)} />
                        <LineupCol title={`${g.home} (home)`} d={detail[g.pk]} side="home" onPlayerClick={(p) => goToAnalysis(g, "home", p)} />
                      </div>
                    )}
                    {detail[g.pk] && detail[g.pk].ready && (
                      <div className="mt-2 text-[11px] text-slate-500">
                        Model line: {g.away} {detail[g.pk].lambdaA.toFixed(1)} – {detail[g.pk].lambdaH.toFixed(1)} {g.home}
                        {detail[g.pk].weather ? ` · ${detail[g.pk].weather.temp}°F, wind ${detail[g.pk].weather.wind}mph, precip ${detail[g.pk].weather.pop}%` : detail[g.pk].stadium.dome ? " · dome/closed roof" : ""}
                      </div>
                    )}
                    <div className="mt-2 flex items-center gap-2">
                      <button onClick={() => getOdds(g)} disabled={oddsLoading === g.pk} className="px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-xs font-semibold disabled:opacity-50">
                        {oddsLoading === g.pk ? "Fetching odds…" : `Fetch odds & build board (${book})`}
                      </button>
                      {board[g.pk] ? <span className="text-[11px] text-slate-500">{board[g.pk].length} priced entries → see Board tab</span> : null}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {!games.length && !loading ? <div className="text-slate-500 text-sm p-4">No games loaded. Try a different week/season, or check the season-type toggle (preseason vs regular season).</div> : null}
          </div>
        )}

        {/* ---------------- BOARD ---------------- */}
        {tab === "board" && (
          <div>
            <div className="flex flex-wrap gap-2 mb-3 items-end">
              <Sel label="Class" v={classFilter} opts={["all", "props", "lines"]} onChange={setClassFilter} compact />
              <Sel label="Category" v={catFilter} opts={["all", ...STAT_ORDER]} onChange={setCatFilter} compact />
              <Sel label="Game" v={gameFilter} opts={["all", ...boardGames.map((g) => g.pk)]} labels={Object.fromEntries(boardGames.map((g) => [g.pk, g.label]))} onChange={setGameFilter} compact />
              <Sel label="Side" v={sideFilter} opts={["all", "over", "under", "home", "away"]} onChange={setSideFilter} compact />
              <Sel label="Sort" v={boardSort} opts={["ev_desc", "ev_asc", "edge_desc", "edge_asc", "proj_desc", "proj_asc"]} onChange={setBoardSort} compact />
              <NumIn label="Min edge %" v={minEdge} onChange={setMinEdge} placeholder="e.g. 4" />
              <NumIn label="Min model %" v={minModel} onChange={setMinModel} placeholder="e.g. 55" />
              <input value={boardSearch} onChange={(e) => setBoardSearch(e.target.value)} placeholder="search player/team" className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs" />
              {filtersActive ? <button onClick={clearFilters} className="px-2 py-1 rounded bg-slate-800 text-xs">Clear filters</button> : null}
            </div>
            {Object.keys(grouped).length === 0 ? <div className="text-slate-500 text-sm">No board entries yet — expand a game on the Slate tab and click "Fetch odds & build board".</div> : null}
            {Object.entries(grouped).map(([type, arr]) => (
              <div key={type} className="mb-4">
                <div className="text-xs font-bold text-emerald-400 mb-1">{type} ({arr.length})</div>
                <div className="space-y-1">
                  {arr.map((e) => <BoardRow key={e.id} e={e} tracked={myBets.some((b) => b.key === e.id)} onTrack={trackBet} />)}
                </div>
              </div>
            ))}
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
          <div>
            <div className="flex flex-wrap gap-2 mb-3 items-end">
              <Sel label="Status" v={betStatusFilter} opts={["all", "open", "won", "lost", "push", "void", "settled"]} onChange={setBetStatusFilter} compact />
              <Sel label="Sort" v={betSort} opts={["recent", "model_desc", "ev_desc", "edge_desc"]} onChange={setBetSort} compact />
              <input value={betSearch} onChange={(e) => setBetSearch(e.target.value)} placeholder="search" className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs" />
              <Sel label="Stake mode (new bets)" v={stakeMode} opts={["flat", "kelly"]} onChange={setStakeMode} compact />
              <button onClick={settleBets} className="px-2 py-1 rounded bg-emerald-700 text-xs font-semibold">Settle open bets</button>
              <button onClick={exportCSV} className="px-2 py-1 rounded bg-slate-800 text-xs">Export CSV</button>
              <button onClick={resetStats} className="px-2 py-1 rounded bg-rose-900 text-xs">Clear all</button>
              {settleMsg ? <span className="text-[11px] text-slate-500">{settleMsg}</span> : null}
            </div>
            <div className="space-y-1">
              {myBetsView.map((b) => <MyBetRow key={b.key} b={b} onOdds={updateBetOdds} onUnits={updateBetUnits} onRemove={removeBet} />)}
              {!myBetsView.length ? <div className="text-slate-500 text-sm p-4">No tracked bets yet — click "Track" on a Board row.</div> : null}
            </div>
          </div>
        )}

        {/* ---------------- STATS ---------------- */}
        {tab === "stats" && (
          <div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
              <StatCard label="Record" v={`${stats.overall.w}-${stats.overall.l}-${stats.overall.ps}`} />
              <StatCard label="Win %" v={pct(stats.overall.winPct)} good={stats.overall.winPct > 0.5} />
              <StatCard label="Net units" v={stats.overall.net.toFixed(2)} good={stats.overall.net > 0} />
              <StatCard label="ROI" v={pct(stats.overall.roi)} good={stats.overall.roi > 0} />
            </div>
            <div className="text-xs font-bold text-emerald-400 mb-1">By category</div>
            <div className="space-y-1">
              {Object.entries(stats.byType).map(([t, s]) => (
                <div key={t} className="flex items-center gap-3 px-2 py-1 border border-slate-800 rounded text-xs">
                  <div className="w-32 font-semibold">{t}</div>
                  <div className="text-slate-400">{s.w}-{s.l}-{s.ps}</div>
                  <div className={s.winPct > 0.5 ? "text-emerald-400" : "text-rose-400"}>{pct(s.winPct)}</div>
                  <div className={s.roi > 0 ? "text-emerald-400" : "text-rose-400"}>ROI {pct(s.roi)}</div>
                  <div className="text-slate-500">net {s.net.toFixed(2)}u</div>
                </div>
              ))}
              {!Object.keys(stats.byType).length ? <div className="text-slate-500 text-sm">Settle some bets to see category breakdowns — this is what drives CALIB_KEEP retuning per doc §5.</div> : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  /* helper bound inside component so it can reach games/detail/setAnalysisProfile */
  function goToAnalysis(g, side, p) {
    setAnalysisProfile({ game: g, side, player: p, detail: detail[g.pk] });
    setTab("analysis");
  }
}

/* ---------------------- subcomponents ---------------------- */
function Sel({ label, v, opts, labels, onChange, compact }) {
  return (
    <label className={`flex items-center gap-1 text-[11px] text-slate-400 ${compact ? "" : ""}`}>
      {label ? <span>{label}</span> : null}
      <select value={v} onChange={(e) => onChange(e.target.value)} className="bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-xs text-slate-100">
        {opts.map((o) => <option key={o} value={o}>{(labels && labels[o]) || o}</option>)}
      </select>
    </label>
  );
}
function NumIn({ label, v, onChange, placeholder }) {
  return (
    <label className="flex items-center gap-1 text-[11px] text-slate-400">
      {label ? <span>{label}</span> : null}
      <input value={v} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="w-16 bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-xs text-slate-100" />
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
function InjBadge({ status }) {
  if (!status) return null;
  const c = status === "OUT" || status === "IR" || status === "SUSPENDED" ? "bg-rose-600" : status === "DOUBTFUL" ? "bg-orange-600" : "bg-amber-600";
  return <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold text-white ${c}`}>{status.replace(/_/g, " ")}</span>;
}
function PlayerRow({ p, onClick }) {
  return (
    <button onClick={() => onClick(p)} className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-800 text-left">
      <span className="w-8 text-[10px] text-slate-500">{p.pos}{p.depthRank ? p.depthRank : ""}</span>
      <span className="flex-1 truncate">{p.name}</span>
      <InjBadge status={p.injuryStatus} />
    </button>
  );
}
function LineupCol({ title, d, side, onPlayerClick }) {
  const teamData = side === "home" ? d.home : d.away;
  if (!teamData) return null;
  return (
    <div>
      <div className="text-[11px] font-bold text-slate-400 mb-1">{title}</div>
      <div className="border border-slate-800 rounded divide-y divide-slate-800">
        {teamData.featured.map((p) => <PlayerRow key={p.id} p={p} onClick={onPlayerClick} />)}
        <PlayerRow p={{ id: "dst", pos: "DST", name: `${title.split(" ")[0]} D/ST` }} onClick={onPlayerClick} />
      </div>
    </div>
  );
}
function BoardRow({ e, tracked, onTrack }) {
  const delta = e.proj != null && !isNaN(parseFloat(e.line)) ? e.proj - parseFloat(e.line) : null;
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 border border-slate-800 rounded hover:border-slate-700">
      <div className="w-40 truncate">
        <div className="font-semibold truncate">{e.name}</div>
        <div className="text-[10px] text-slate-500 truncate">{e.game}</div>
      </div>
      <div className="w-24 text-[11px]">{e.side} {e.line}</div>
      <div className="w-16 text-[11px]" style={mono}>{fmtOdds(e.odds)}</div>
      <div className="w-20 text-[11px] text-slate-400">proj {e.proj != null ? e.proj.toFixed(1) : "—"}{delta != null ? <span className={delta > 0 ? " text-emerald-400" : " text-rose-400"}> ({delta > 0 ? "+" : ""}{delta.toFixed(1)})</span> : null}</div>
      <div className="w-16 text-[11px] font-semibold">{pct(e.modelP)}</div>
      <div className={`w-16 text-[11px] font-semibold ${e.edge > 0 ? "text-emerald-400" : "text-rose-400"}`}>{e.edge != null ? `${e.edge > 0 ? "+" : ""}${(e.edge * 100).toFixed(1)}%` : "—"}</div>
      <div className={`w-16 text-[11px] ${e.ev > 0 ? "text-emerald-400" : "text-rose-400"}`}>EV {e.ev != null ? e.ev.toFixed(2) : "—"}</div>
      <button onClick={() => onTrack(e)} disabled={tracked} className={`ml-auto px-2 py-1 rounded text-[11px] font-semibold ${tracked ? "bg-slate-800 text-slate-500" : "bg-emerald-700 hover:bg-emerald-600"}`}>{tracked ? "Tracked" : "Track"}</button>
    </div>
  );
}
function MyBetRow({ b, onOdds, onUnits, onRemove }) {
  const statusColor = { open: "text-slate-300", won: "text-emerald-400", lost: "text-rose-400", push: "text-slate-500", void: "text-slate-600" }[b.status] || "text-slate-300";
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 border border-slate-800 rounded">
      <div className="w-40 truncate"><div className="font-semibold truncate">{b.name}</div><div className="text-[10px] text-slate-500 truncate">{b.game}</div></div>
      <div className="w-28 text-[11px]">{b.type} {b.side} {b.line}</div>
      <input value={b.odds} onChange={(e) => onOdds(b.key, e.target.value)} className="w-16 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px]" style={mono} />
      <input value={b.units} onChange={(e) => onUnits(b.key, e.target.value)} className="w-12 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px]" title="units" />
      <div className="w-16 text-[11px]">{pct(b.modelP)}</div>
      <div className={`w-16 text-[11px] ${b.edge > 0 ? "text-emerald-400" : "text-rose-400"}`}>{b.edge != null ? `${(b.edge * 100).toFixed(1)}%` : "—"}</div>
      <div className={`w-16 text-[11px] font-bold uppercase ${statusColor}`}>{b.status}</div>
      <button onClick={() => onRemove(b.key)} className="ml-auto px-2 py-1 rounded bg-slate-800 hover:bg-rose-900 text-[11px]">✕</button>
    </div>
  );
}
function AnalysisProjectionRow({ r }) {
  return (
    <div className="flex items-center gap-3 px-2 py-1.5 border border-slate-800 rounded text-[11px]">
      <div className="w-36 font-semibold">{r.type}</div>
      <div className="text-slate-400">line {r.line}</div>
      <div className="text-slate-200">proj {r.proj != null ? r.proj.toFixed(2) : "—"}</div>
      <div className="text-emerald-400">O {pct(r.overP)} ({r.overFair})</div>
      <div className="text-rose-400">U {pct(r.underP)} ({r.underFair})</div>
      {r.calc ? <div className="text-slate-600 truncate flex-1">{r.calc.dist} · {r.calc.params}</div> : null}
    </div>
  );
}
function MathPanel({ r }) {
  if (!r || !r.calc) return null;
  const c = r.calc;
  return (
    <div className="text-[10px] text-slate-500 border border-slate-800 rounded p-2 mt-1">
      <div>{c.dist} · {c.params} · proj {c.proj != null ? c.proj.toFixed(2) : "—"}</div>
      <div>{c.baseStr}</div>
      {c.mults && c.mults.length ? <div className="mt-1 flex flex-wrap gap-2">{c.mults.map(([k, v]) => <span key={k}>{k}: {typeof v === "number" ? v.toFixed(3) : v}</span>)}</div> : null}
    </div>
  );
}
function PlayerAnalysisPanel({ profile, ctx, projections, boardEntries, onTrack, myBets }) {
  const p = profile.player;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="text-lg font-bold">{p.name}</div>
        <span className="px-2 py-0.5 rounded bg-slate-800 text-[11px]">{ctx.pos}</span>
        <InjBadge status={ctx.injuryStatus} />
        <div className="text-[11px] text-slate-500 ml-2">{profile.game.away} @ {profile.game.home}</div>
      </div>
      <div className="grid md:grid-cols-3 gap-2 text-[11px]">
        <div className="border border-slate-800 rounded p-2">
          <div className="text-slate-500 uppercase text-[10px] mb-1">Season (this year)</div>
          {ctx.season ? Object.entries(ctx.season).filter(([k]) => k !== "g").map(([k, v]) => <div key={k}>{k}: {typeof v === "number" ? v.toFixed(1) : v}</div>) : <div className="text-slate-600">no season log yet</div>}
        </div>
        <div className="border border-slate-800 rounded p-2">
          <div className="text-slate-500 uppercase text-[10px] mb-1">Last 4 games</div>
          {ctx.recent ? Object.entries(ctx.recent).filter(([k]) => k !== "games").map(([k, v]) => <div key={k}>{k}: {typeof v === "number" ? v.toFixed(1) : v}</div>) : <div className="text-slate-600">no recent log yet</div>}
        </div>
        <div className="border border-slate-800 rounded p-2">
          <div className="text-slate-500 uppercase text-[10px] mb-1">Context</div>
          <div>game script (spread): {ctx.teamSpread != null ? ctx.teamSpread.toFixed(1) : "—"}</div>
          <div>implied team pts: {ctx.impliedTeamPts != null ? ctx.impliedTeamPts.toFixed(1) : "—"}</div>
          <div>weather: {ctx.weather ? `${ctx.weather.temp}°F, wind ${ctx.weather.wind}mph` : ctx.stadium && ctx.stadium.dome ? "dome/closed" : "—"}</div>
        </div>
      </div>
      <div>
        <div className="text-xs font-bold text-emerald-400 mb-1">Default-line projections (every major prop for this position)</div>
        <div className="space-y-1">
          {projections.map((r) => (
            <div key={r.type}>
              <AnalysisProjectionRow r={r} />
              <MathPanel r={r} />
            </div>
          ))}
        </div>
      </div>
      {boardEntries.length ? (
        <div>
          <div className="text-xs font-bold text-emerald-400 mb-1">Live market lines for this player (from Board)</div>
          <div className="space-y-1">{boardEntries.map((e) => <BoardRow key={e.id} e={e} tracked={myBets.some((b) => b.key === e.id)} onTrack={onTrack} />)}</div>
        </div>
      ) : null}
    </div>
  );
}
