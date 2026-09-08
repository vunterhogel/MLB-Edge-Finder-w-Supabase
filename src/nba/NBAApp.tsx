import React, { useState, useEffect, useMemo, useRef } from "react";

/* ============================================================
   NBA EDGE FINDER v1
   ------------------------------------------------------------
   Clone of MLB/NFL Edge Finder's engine/UI, rebuilt for basketball.
   Full methodology: ../../NBA_PROJECTION_MODELS.md — read that
   first; this file is the implementation of that spec.

   DATA (all browser-reachable, no paid key except the odds proxy
   which already exists in this project and is sport-agnostic):
     - site.api.espn.com / sports.core.api.espn.com (basketball/nba):
       schedule, rosters, gamelogs, injuries, depth charts, team
       stats/standings — same URL convention as football/nfl, but
       NOT verified live from this sandboxed build environment (no
       network path to espn.com here). Every parser below degrades
       to a neutral default instead of throwing if a field has moved
       — same defensive posture as the NFL app's pickCat/alias tables.
     - api.the-odds-api.com (via the EXISTING odds-proxy edge
       function, unmodified — sport key basketball_nba).
     - nba-stats-proxy (NEW edge function, mirrors nfl-stats-proxy) —
       generic ?url= passthrough for the ESPN hosts above.

   WHAT'S GENUINELY NEW VS THE MLB/NFL ENGINES (see doc §6):
     1. Pace as a shared per-game multiplier on every counting stat.
     2. Blowout-risk minutes reduction (garbage time).
     3. Back-to-back / rest-days as the dominant fatigue signal.
     4. ONE unified per-player projector (no QB/RB/WR-style split —
        NBA stats don't divide by role the way football/baseball do).
     5. Joint double-double/triple-double Monte Carlo simulation.
     6. Daily cadence (like MLB) but with back-to-backs (unlike MLB).

   Everything else — the core math (Poisson/NegBin/Gamma Monte
   Carlo), the odds/calibration helpers, the Kelly stake sizing, the
   board-log-everything-then-settle-and-retune workflow — is
   sport-agnostic and ported from App.tsx/NFLApp.tsx unchanged.

   TABS: Slate · Board (categorized, sortable) · Player Analysis ·
   My Bets (tracked, editable odds, persisted) · Stats (win% / ROI).
   My Bets + Board Log persist to localStorage/IndexedDB, same as
   MLB/NFL, so this works outside Claude / in your own deploy.

   Structured edge-finder, not a money printer. Every prior below
   is a reasonable starting point, NOT a calibrated number — there
   is no settled-bet history for this engine yet. Retune CALIB_KEEP,
   the NB_PHI dispersion constants, and the league-average priors
   once the Stats tab has real graded bets.
   ============================================================ */

/* ---------- team reference (ESPN id-keyed) ----------
   Standard, long-stable ESPN NBA team id scheme. Verify against a live
   GET /apis/site/v2/sports/basketball/nba/teams before relying on it —
   same "verify/adjust yearly" caution the NFL app gives its STADIUMS
   table, since this file was written without network access to confirm
   it live. */
const TEAMS = {
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
const ABBR_TO_NAME = Object.fromEntries(Object.values(TEAMS).map((t) => [t.ab, t.name]));
function matchesQuery(item, q) {
  if (!q) return true;
  const parts = [item.name || "", item.game || ""];
  for (const ab of String(item.game || "").split("@")) { const nm = ABBR_TO_NAME[ab.trim()]; if (nm) parts.push(nm); }
  return parts.join(" ").toLowerCase().includes(q.toLowerCase().trim());
}
const LG_PPG = 114.0;          // league-avg team points/game (prior — retune from settled Stats data)
const LG_PACE = 99.5;          // league-avg possessions/48 min (prior)
const NBA_PTS_PHI = 1.3;       // team points variance ≈ NBA_PTS_PHI × mean — far less overdispersed than NFL (6.5) or MLB runs (2.0)
const HOME_COURT_MULT = { home: 1.015, away: 0.985 }; // ~2.5-3pt NBA home edge on a ~225pt combined total, proportionally like NFL's home field mult

/* ---------- prop + odds config ---------- */
const CORE_PROPS = ["Points", "Rebounds", "Assists", "Three-Pointers Made", "Steals", "Blocks", "Turnovers"];
const COMBO_PROPS = ["Pts+Reb+Ast", "Pts+Reb", "Pts+Ast", "Reb+Ast", "Blocks+Steals"];
const SPECIAL_PROPS = ["Double-Double", "Triple-Double"];
const ALL_PLAYER_PROPS = [...CORE_PROPS, ...COMBO_PROPS, ...SPECIAL_PROPS];
const DEFAULT_LINE = {
  "Points": "22.5", "Rebounds": "7.5", "Assists": "5.5", "Three-Pointers Made": "2.5",
  "Steals": "1.5", "Blocks": "1.5", "Turnovers": "2.5",
  "Pts+Reb+Ast": "35.5", "Pts+Reb": "28.5", "Pts+Ast": "27.5", "Reb+Ast": "12.5", "Blocks+Steals": "2.5",
  "Double-Double": "0.5", "Triple-Double": "0.5",
};
const ODDS_SPORT = "basketball_nba";
const TYPE_TO_MARKET = {
  "Points": "player_points", "Rebounds": "player_rebounds", "Assists": "player_assists",
  "Three-Pointers Made": "player_threes", "Steals": "player_steals", "Blocks": "player_blocks", "Turnovers": "player_turnovers",
  "Pts+Reb+Ast": "player_points_rebounds_assists", "Pts+Reb": "player_points_rebounds", "Pts+Ast": "player_points_assists",
  "Reb+Ast": "player_rebounds_assists", "Blocks+Steals": "player_blocks_steals",
  "Double-Double": "player_double_double", "Triple-Double": "player_triple_double",
};
const MARKET_TO_TYPE = Object.fromEntries(Object.entries(TYPE_TO_MARKET).map(([k, v]) => [v, k]));
const GAME_MARKETS = ["h2h", "spreads", "totals"]; // moneyline, spread, total — identical shape to MLB/NFL
const GAME_PROPS = ["Moneyline", "Spread", "Total"];
const CATEGORY_ORDER = [...CORE_PROPS, ...COMBO_PROPS, ...SPECIAL_PROPS, ...GAME_PROPS];
const isLineType = (t) => GAME_PROPS.includes(t);
const isYesNoType = (t) => t === "Double-Double" || t === "Triple-Double";
const BOOKS = [
  { key: "draftkings", label: "DraftKings" }, { key: "fanduel", label: "FanDuel" },
  { key: "betmgm", label: "BetMGM" }, { key: "caesars", label: "Caesars" },
  { key: "espnbet", label: "ESPN BET" }, { key: "fanatics", label: "Fanatics" },
];
const BOOK_LABELS = { ...Object.fromEntries(BOOKS.map((b) => [b.key, b.label])), manual: "Manual" };
const ODDS_TESTING_LIMIT = 400; // per-session safety rail against runaway loops — same rail as MLB/NFL

/* ---------- stake sizing (verbatim from MLB/NFL — sport-agnostic) ---------- */
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

/* ---------------------- core math (verbatim from MLB/NFL — sport-agnostic) ---------------------- */
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

/* ---------------------- odds + format (verbatim from MLB/NFL — sport-agnostic) ---------------------- */
const impliedProb = (o) => (o < 0 ? -o / (-o + 100) : 100 / (o + 100));
const probToAmerican = (p) => { if (p <= 0 || p >= 1) return "—"; return p > 0.5 ? `-${Math.round((p / (1 - p)) * 100)}` : `+${Math.round(((1 - p) / p) * 100)}`; };
const evPerUnit = (p, o) => { const b = o > 0 ? o / 100 : 100 / -o; return p * b - (1 - p); };
// per-market calibration: DAY-1 PRIOR. No settled-bet history for basketball yet, so every
// category starts at a conservative, uniform "trust the market a lot" weight — same posture
// NFL launched with. Retune per-category from the Stats tab; don't hand-tune from vibes.
const CALIB_KEEP = {
  "Points": 0.45, "Rebounds": 0.45, "Assists": 0.45, "Three-Pointers Made": 0.40, "Steals": 0.35, "Blocks": 0.35, "Turnovers": 0.35,
  "Pts+Reb+Ast": 0.45, "Pts+Reb": 0.45, "Pts+Ast": 0.45, "Reb+Ast": 0.40, "Blocks+Steals": 0.35,
  "Double-Double": 0.35, "Triple-Double": 0.30, "Spread": 0.50, "Total": 0.50,
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
   run grid / NFL's points grid, tuned for NBA: bigger grid (NBA
   teams routinely score 90-140), much lower relative overdispersion
   (NBA_PTS_PHI=1.3 vs NFL's 6.5), and a shared pace multiplier
   applied once to BOTH teams rather than per-team.
   ============================================================ */
function teamPtsPmf(k, lambda) { return negativeBinomialPMF(k, Math.max(lambda, 1e-6), NBA_PTS_PHI); }
function gameProbs(lh, la) {
  const N = 180; let pH = 0, pA = 0, pT = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const pr = teamPtsPmf(i, lh) * teamPtsPmf(j, la);
    if (i > j) pH += pr; else if (j > i) pA += pr; else pT += pr;
  }
  return { home: pH, away: pA, tie: pT, totalLambda: lh + la };
}
function jointGameProbs(lhEff, laEff, hc, ac, totalLine) {
  const N = 180; let pH = 0, pA = 0, pT = 0, over = 0, under = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const pr = teamPtsPmf(i, lhEff) * teamPtsPmf(j, laEff);
    const hs = hc + i, as = ac + j;
    if (hs > as) pH += pr; else if (as > hs) pA += pr; else pT += pr;
    if (totalLine != null) { const tot = hs + as; if (tot > totalLine) over += pr; else if (tot < totalLine) under += pr; }
  }
  return { home: pH, away: pA, tie: pT, over, under };
}
function marginProb(lhEff, laEff, hc, ac, cmp) {
  const N = 180; let p = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    if (cmp((hc + i) - (ac + j))) p += teamPtsPmf(i, lhEff) * teamPtsPmf(j, laEff);
  }
  return p;
}

/* ============================================================
   SHRINKAGE HELPERS (verbatim from MLB/NFL — sport-agnostic)
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
   PROJECTION ENGINE — unified per-player model (doc §3)
   ============================================================ */
const RECENT_WEIGHT = 0.35;       // L10-game blend weight
const MIN_L10_GAMES = 3;          // require >=3 recent games before blending recent form in
const SHRINK_N = { minutes: 5, rate: 150 }; // "games" / "minutes" of prior weight
const NB_PHI = {                  // dispersion priors (var/mean) — DAY-1, retune from settled data
  pts: 1.8, reb: 1.5, ast: 1.6, fg3m: 1.7, stl: 1.6, blk: 1.6, tov: 1.4, combo: 2.6,
};
// position-group league priors (per-36, plus a minutes-per-game prior) — exist ONLY to
// stabilize thin samples (rookie's first few games, a two-way call-up); once a player has
// real minutes, his own rate dominates via shrinkRate's sample-size weighting.
const POS_PRIOR = {
  G: { mpg: 26, pts36: 16.5, reb36: 3.8, ast36: 5.2, stl36: 1.3, blk36: 0.3, tov36: 2.3, fg3m36: 2.4 },
  F: { mpg: 27, pts36: 16.0, reb36: 6.5, ast36: 3.0, stl36: 1.0, blk36: 0.6, tov36: 2.0, fg3m36: 1.6 },
  C: { mpg: 25, pts36: 15.5, reb36: 9.5, ast36: 2.2, stl36: 0.8, blk36: 1.4, tov36: 1.9, fg3m36: 0.6 },
};
function posGroup(pos) {
  const p = String(pos || "").toUpperCase();
  if (p === "C") return "C";
  if (p === "PF" || p === "SF" || p === "F") return "F";
  return "G"; // PG, SG, G, or unknown default
}

/* -------- pace adjustment (doc §4, NEW vs NFL/MLB) --------
   Applied ONCE per game to both teams' counting stats — a fast-pace matchup
   inflates points/rebounds/assists for everyone on the floor, not just one side. */
function calculatePaceAdjustment(teamPace, oppPace, lgPace) {
  const tp = teamPace || lgPace || LG_PACE, op = oppPace || lgPace || LG_PACE, lg = lgPace || LG_PACE;
  return clamp(((tp + op) / 2) / lg, 0.85, 1.18);
}

/* -------- opponent defense adjustment (doc §4) --------
   Points uses a real opponent-DRTG signal; other categories are neutral (1.0×) in v1 —
   see NBA_PROJECTION_MODELS.md §7 "known v1 simplifications", same honest scope cut NFL
   made for its opponent-allowed-by-position splits. */
function calculateOppDefenseAdjustment(oppAllowedRate, leagueAvgRate, lo = 0.80, hi = 1.25) {
  if (!oppAllowedRate || !leagueAvgRate) return 1;
  return clamp(oppAllowedRate / leagueAvgRate, lo, hi);
}

/* -------- injury adjustment (doc §4) --------
   NBA's daily injury report: Out | Doubtful | Questionable | Day-To-Day | Probable | null. */
function calculateInjuryAvailability(status) {
  const s = String(status || "").toUpperCase();
  if (s === "OUT" || s === "SUSPENDED" || s === "INJURED_RESERVE") return 0;
  if (s === "DOUBTFUL") return 0.25;
  if (s === "QUESTIONABLE" || s === "DAY_TO_DAY" || s === "DAY-TO-DAY") return 0.85;
  if (s === "PROBABLE") return 0.95;
  return 1;
}

/* -------- usage boost when a teammate is out (doc §4, NEW framing vs NFL) --------
   Broader than NFL's injuredTeammateBoost (which only lifted WR2/3 target share): in NBA
   every rotation player left on the floor sees SOME usage bump when a teammate sits, so this
   applies across points/threes/turnovers, weighted by how much usage/points share is missing. */
function calculateUsageBoost(missingUsageShare) {
  if (!missingUsageShare) return 1;
  return clamp(1 + missingUsageShare * 0.6, 1, 1.35);
}

/* -------- rest / back-to-back adjustment (doc §4) --------
   The single biggest NBA-specific fatigue signal — no comparable-magnitude analog in NFL
   (plays once a week) or MLB (no true zero-rest scheduling quirk). */
function calculateRestAdjustment(ctx) {
  let m = 1;
  if (ctx.backToBack) m -= 0.06;
  else if (ctx.daysRest >= 2) m += 0.02;
  return clamp(m, 0.90, 1.03);
}

/* -------- blowout-risk minutes reduction (doc §3 step 1, §4, NEW vs NFL/MLB) --------
   A team on either side of a wide model-projected spread sees its starters' 4th-quarter
   minutes cut as the game gets out of hand — a real NBA coaching pattern (garbage time)
   with no MLB/NFL equivalent. */
function calculateBlowoutRiskAdjustment(projSpreadAbs, isStarter) {
  if (!isStarter || projSpreadAbs == null || projSpreadAbs < 10) return 1;
  const over = clamp(projSpreadAbs - 10, 0, 10); // 10..20+
  return clamp(1 - over * 0.008, 0.92, 1);
}

/* ---- unified player projection (doc §3) ---- */
function playerBaseRates(ctx) {
  const s = ctx.season || {}; const l = ctx.recent || null;
  const lOK = l && l.games >= MIN_L10_GAMES;
  const pg = posGroup(ctx.pos);
  const prior = POS_PRIOR[pg];
  const minutesRaw = blendRate(s.g ? s.min / s.g : prior.mpg, lOK ? l.min / l.games : null, RECENT_WEIGHT);
  const minutes0 = shrinkValue(minutesRaw, s.g || 0, prior.mpg, SHRINK_N.minutes);
  const per36 = (key) => {
    const seasonPer36 = s.min ? (s[key] || 0) / s.min * 36 : prior[`${key}36`];
    const recentPer36 = lOK && l.min ? (l[key] || 0) / l.min * 36 : null;
    const blended = blendRate(seasonPer36, recentPer36, RECENT_WEIGHT);
    return shrinkRate(blended, s.min || 0, prior[`${key}36`], SHRINK_N.rate);
  };
  return {
    minutes0,
    pts36: per36("pts"), reb36: per36("reb"), ast36: per36("ast"),
    stl36: per36("stl"), blk36: per36("blk"), tov36: per36("tov"), fg3m36: per36("fg3m"),
  };
}
function projectPlayer(ctx, type, line) {
  const base = playerBaseRates(ctx);
  const pace = calculatePaceAdjustment(ctx.teamPace, ctx.oppPace, ctx.lgPace);
  const rest = calculateRestAdjustment(ctx);
  const blowout = calculateBlowoutRiskAdjustment(ctx.projSpreadAbs, !!ctx.isStarter);
  const avail = calculateInjuryAvailability(ctx.injuryStatus);
  const usage = calculateUsageBoost(ctx.missingUsageShare);
  const oppPtsD = calculateOppDefenseAdjustment(ctx.oppDRTG, ctx.lgDRTG);
  const oppReb = calculateOppDefenseAdjustment(ctx.oppRebRateAllowed, ctx.lgRebRateAllowed);
  const oppAst = calculateOppDefenseAdjustment(ctx.oppAstAllowed, ctx.lgAstAllowed);
  const opp3pt = calculateOppDefenseAdjustment(ctx.opp3ptPctAllowed, ctx.lg3ptPctAllowed);
  const oppStl = calculateOppDefenseAdjustment(ctx.oppTovForced, ctx.lgTovForced);
  const oppBlk = calculateOppDefenseAdjustment(ctx.oppFgaRimAllowed, ctx.lgFgaRimAllowed);

  const minutes = base.minutes0 * rest * blowout * avail;
  const m36 = minutes / 36;
  const pts = m36 * base.pts36 * pace * oppPtsD * usage;
  const reb = m36 * base.reb36 * pace * oppReb;
  const ast = m36 * base.ast36 * pace * oppAst;
  const fg3m = m36 * base.fg3m36 * pace * opp3pt;
  const stl = m36 * base.stl36 * pace * oppStl;
  const blk = m36 * base.blk36 * pace * oppBlk;
  const tov = m36 * base.tov36 * pace * clamp(usage, 1, 1.25);

  const mults = [["pace", pace], ["rest/B2B", rest], ["blowout risk", blowout], ["availability", avail], ["usage boost", usage]];
  const baseStr = `${base.minutes0.toFixed(1)} min/g season base (${posGroup(ctx.pos)} prior)`;
  const single = {
    "Points": { mean: pts, phi: NB_PHI.pts, mults: [...mults, ["opp DRTG", oppPtsD]] },
    "Rebounds": { mean: reb, phi: NB_PHI.reb, mults: [...mults, ["opp reb rate allowed", oppReb]] },
    "Assists": { mean: ast, phi: NB_PHI.ast, mults: [...mults, ["opp ast allowed", oppAst]] },
    "Three-Pointers Made": { mean: fg3m, phi: NB_PHI.fg3m, mults: [...mults, ["opp 3PT D", opp3pt]] },
    "Steals": { mean: stl, phi: NB_PHI.stl, mults: [...mults, ["opp TOs forced", oppStl]] },
    "Blocks": { mean: blk, phi: NB_PHI.blk, mults: [...mults, ["opp rim pressure", oppBlk]] },
    "Turnovers": { mean: tov, phi: NB_PHI.tov, mults: [...mults, ["usage (TOs rise w/ usage)", clamp(usage, 1, 1.25)]] },
  };
  // combo props: sum of means, inflated phi to approximate positive correlation across
  // stats that all scale off the same minutes/usage swings (doc §3 step 4)
  const combo = {
    "Pts+Reb+Ast": { mean: pts + reb + ast, phi: NB_PHI.combo, mults },
    "Pts+Reb": { mean: pts + reb, phi: NB_PHI.combo, mults },
    "Pts+Ast": { mean: pts + ast, phi: NB_PHI.combo, mults },
    "Reb+Ast": { mean: reb + ast, phi: NB_PHI.combo, mults },
    "Blocks+Steals": { mean: blk + stl, phi: NB_PHI.combo, mults },
  };
  if (single[type]) {
    const t = single[type];
    const seed = hashSeed(`p|${type}|${line}|${minutes.toFixed(2)}|${pts.toFixed(2)}`);
    const pOver = probabilityOver("nb", line, "over", seed, t);
    return { pOver, proj: t.mean, calc: fullCalc("Neg.Binom", `μ=${t.mean.toFixed(2)}, φ=${t.phi}`, t.mean, baseStr, t.mults) };
  }
  if (combo[type]) {
    const t = combo[type];
    const seed = hashSeed(`c|${type}|${line}|${minutes.toFixed(2)}`);
    const pOver = probabilityOver("nb", line, "over", seed, t);
    return { pOver, proj: t.mean, calc: fullCalc("Neg.Binom·combo", `μ=${t.mean.toFixed(2)}, φ=${t.phi} (correlation-inflated)`, t.mean, baseStr, t.mults) };
  }
  if (type === "Double-Double" || type === "Triple-Double") {
    const need = type === "Double-Double" ? 2 : 3;
    const p = simulateDoubleTriple({ pts, reb, ast, stl, blk, minutesMean: minutes }, need);
    return { pOver: p, proj: p, calc: fullCalc("Joint MC", "≥N of {pts,reb,ast,stl,blk} ≥10, shared-minutes-correlated", p, `${need} of 5 stat lines ≥ 10`, mults) };
  }
  return { pOver: null, proj: null, calc: null };
}
// -------- joint double-double / triple-double simulation (doc §3 step 5, NEW vs NFL/MLB) --------
// Each simulated game draws ONE shared minutes-multiplier (captures the "big-night/foul-trouble"
// correlation across every category at once), then draws each stat conditional on that game's
// scaled means. Counts how many of {points, rebounds, assists, steals, blocks} land >= 10.
function simulateDoubleTriple(means, need, seed, N = 20000) {
  const prev = RNG; RNG = mulberry32((seed >>> 0) || hashSeed(`dd|${means.pts.toFixed(2)}|${means.reb.toFixed(2)}|${means.ast.toFixed(2)}`)); _spareGaussian = null;
  let hits = 0;
  const cats = [["pts", NB_PHI.pts], ["reb", NB_PHI.reb], ["ast", NB_PHI.ast], ["stl", NB_PHI.stl], ["blk", NB_PHI.blk]];
  for (let i = 0; i < N; i++) {
    // shared per-game noise (bounded so it can't flip means negative): a hot/cold/foul-trouble night
    const shared = clamp(1 + gaussian() * 0.18, 0.5, 1.7);
    let count = 0;
    for (const [k, phi] of cats) {
      const mean = Math.max((means[k] || 0) * shared, 0.01);
      if (sampleNegBin(mean, phi) >= 10) count++;
    }
    if (count >= need) hits++;
  }
  RNG = prev; _spareGaussian = null;
  return hits / N;
}
function fullCalc(dist, params, proj, baseStr, mults) { return { dist, params, proj, baseStr, mults, live: null }; }

/* full evaluation of a single priced bet (model + market) — verbatim from MLB/NFL */
function evalBet(b, pre) {
  const { pOver, proj, calc } = pre || projectPlayer(b.ctx, b.type, parseFloat(b.line));
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
   Same URL convention verified live for football/nfl elsewhere in this
   project; NOT independently confirmed live for basketball/nba from
   this build environment (no network egress here) — see doc §8. Every
   parser is column/shape-tolerant: a moved field degrades to a league
   prior instead of throwing.
   ============================================================ */
const ESPN_SITE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const ESPN_WEB = "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba";
const ESPN_CORE = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba";
async function jget(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status}`); return r.json(); }
function refId(ref) {
  if (!ref) return null;
  const matches = [...String(ref).matchAll(/\/(\d+)(?=[/?]|$)/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}
function ymd(d) { return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`; }
function dateKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

/* ---- schedule / scoreboard (by calendar date, like MLB) ---- */
function classify(comp) {
  const st = comp && comp.status && comp.status.type;
  if (!st) return "SCHEDULED";
  if (st.completed) return "FINAL";
  if (st.state === "in") return "LIVE";
  return "SCHEDULED";
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
    dateLabel: ev.date ? new Date(ev.date).toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" }) : "",
    venue: (comp.venue && comp.venue.fullName) || "",
    status: classify(comp),
    homeScore: home.score != null ? +home.score : null, awayScore: away.score != null ? +away.score : null,
    period: comp.status && comp.status.period, clock: comp.status && comp.status.displayClock,
    manual: false,
  };
}
async function fetchSchedule(date) {
  const d = await jget(`${ESPN_SITE}/scoreboard?dates=${ymd(date)}`);
  return (d.events || []).map(mapGame);
}
/* ---- team schedule (for rest/back-to-back computation, doc §4) ---- */
async function fetchTeamSchedule(teamId, year) {
  try {
    const d = await jget(`${ESPN_SITE}/teams/${teamId}/schedule?season=${year}`);
    return (d.events || []).map((ev) => ({ date: ev.date ? new Date(ev.date) : null, completed: !!(ev.competitions && ev.competitions[0] && ev.competitions[0].status && ev.competitions[0].status.type && ev.competitions[0].status.type.completed) })).filter((e) => e.date).sort((a, b) => a.date - b.date);
  } catch { return []; }
}
function computeRest(sched, gameDate) {
  if (!sched.length) return { daysRest: 2, backToBack: false };
  const t = gameDate.getTime();
  let prev = null;
  for (const g of sched) { if (g.date.getTime() < t) prev = g; else break; }
  if (!prev) return { daysRest: 2, backToBack: false };
  const days = Math.round((t - prev.date.getTime()) / 86400000);
  return { daysRest: days, backToBack: days <= 1 };
}

/* ---- roster (embeds injuries — one call per team gets both) ---- */
async function fetchRoster(teamId) {
  const d = await jget(`${ESPN_SITE}/teams/${teamId}/roster`);
  const out = [];
  const list = Array.isArray(d.athletes) && d.athletes.length && d.athletes[0].items ? d.athletes.flatMap((g) => g.items || []) : (d.athletes || []);
  for (const a of list) {
    const inj = (a.injuries && a.injuries[0]) || null;
    out.push({
      id: a.id, name: a.fullName || a.displayName || "",
      pos: (a.position && (a.position.abbreviation || a.position.name)) || "",
      jersey: a.jersey || "",
      injuryStatus: inj ? String(inj.status || "").toUpperCase().replace(/\s+/g, "_") : null,
    });
  }
  return out;
}
/* ---- universal player search (the NBA equivalent of MLB/NFL's player search) ---- */
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
      .filter((p) => p.defaultLeagueSlug === "nba")
      .map((p) => {
        const m = String(p.uid || "").match(/a:(\d+)/);
        const id = m ? m[1] : refId(p.link && p.link.web);
        const teamName = p.subtitle || "";
        return { id, name: p.displayName || "", teamName, teamId: espnIdForTeamName(teamName) };
      })
      .filter((p) => p.id);
  } catch { return []; }
}
/* ---- depth chart: athlete id -> {slot label, rank} (starter=1, first man off bench=2, ...) ---- */
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
const STAT_ALIASES = {
  min: ["minutes"], pts: ["points"], reb: ["rebounds", "totalRebounds"], ast: ["assists"],
  stl: ["steals"], blk: ["blocks"], tov: ["turnovers"],
  fg3m: ["threePointFieldGoalsMade", "3PM"], fga: ["fieldGoalsAttempted"], fgm: ["fieldGoalsMade"],
};
function pickAlias(names, key) {
  const cands = STAT_ALIASES[key] || [key];
  for (const c of cands) { const i = names.findIndex((n) => String(n).toLowerCase() === c.toLowerCase()); if (i >= 0) return i; }
  return -1;
}
const GAMELOG_ROWS = 10; // "Last N Games" log table
async function fetchAthleteGamelog(athleteId, n = 10) {
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

    let games = [];
    const eventsObj = (d.events && typeof d.events === "object" && !Array.isArray(d.events)) ? d.events : null;
    if (eventsObj) {
      const eventIds = Object.keys(eventsObj);
      if (eventIds.length && eventIds.length === all.length) {
        games = eventIds.map((eid, i) => {
          const ev = eventsObj[eid] || {};
          const opp = (ev.opponent && (ev.opponent.abbreviation || ev.opponent.displayName)) || null;
          return { eventId: eid, date: ev.gameDate || ev.date || null, atVs: ev.atVs || null, opp, score: ev.score || null, result: ev.gameResult || null, ...all[i] };
        });
      }
    }
    games = games.slice(-GAMELOG_ROWS).reverse();
    return { season, recent, games };
  } catch { return null; }
}

/* ---- team season stats + standings ---- */
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
    const categories = (d.results && d.results.stats && d.results.stats.categories) || (d.splits && d.splits.categories) || d.categories || [];
    const off = pickCat(categories, ["avgPoints", "pace", "possessions", "offensiveRating", "avgRebounds", "avgAssists"]);
    const def = pickCat(categories, ["avgPointsAllowed", "defensiveRating", "opponentAvgPoints"]);
    return { off, def, raw: categories.length > 0 };
  } catch { return { off: {}, def: {}, raw: false }; }
}
async function fetchStandings(year) {
  try {
    const d = await jget(`${ESPN_SITE.replace("/apis/site/v2", "/apis/v2")}/standings?season=${year}`);
    const out = {};
    const walk = (node) => {
      if (node && node.standings && node.standings.entries) {
        for (const e of node.standings.entries) {
          const id = e.team && +e.team.id; if (!id) continue;
          const stat = (name) => { const s = (e.stats || []).find((x) => x.name === name); return s ? numOrNull(s.value) : null; };
          const w = stat("wins") || 0, l = stat("losses") || 0;
          const g = Math.max(w + l, 1);
          out[id] = { pf: stat("pointsFor"), pa: stat("pointsAgainst"), g, ppgFor: (stat("pointsFor") || 0) / g, ppgAgainst: (stat("pointsAgainst") || 0) / g };
        }
      }
      for (const c of (node && node.children) || []) walk(c);
    };
    walk(d);
    return out;
  } catch { return {}; }
}

/* ---- boxscore (settling tracked bets) ---- */
async function fetchGameSummary(eventId) {
  try {
    const d = await jget(`${ESPN_SITE}/summary?event=${eventId}`);
    const comp = d.header && d.header.competitions && d.header.competitions[0];
    const statusType = comp && comp.status && comp.status.type;
    const final = !!(statusType && statusType.completed);
    const canceled = !!(statusType && /CANCELED|CANCELLED|POSTPONED/i.test(String(statusType.name || "")));
    const home = comp && (comp.competitors || []).find((c) => c.homeAway === "home");
    const away = comp && (comp.competitors || []).find((c) => c.homeAway === "away");
    const players = {};
    for (const team of (d.boxscore && d.boxscore.players) || []) {
      for (const cat of team.statistics || []) {
        const labels = (cat.labels || cat.names || []).map((x) => String(x).toUpperCase());
        const keys = cat.keys || [];
        for (const ath of cat.athletes || []) {
          const id = ath.athlete && ath.athlete.id; if (!id) continue;
          const p = (players[id] = players[id] || { participated: true });
          (ath.stats || []).forEach((v, i) => {
            const key = keys[i], label = labels[i];
            const n = num(v);
            if (key) p[key] = n;
            if (label) p[label] = n;
          });
        }
      }
    }
    return { final, canceled, homeScore: home ? +home.score : null, awayScore: away ? +away.score : null, players };
  } catch { return { final: false, canceled: false, homeScore: null, awayScore: null, players: {} }; }
}

/* ============================================================
   THE ODDS API — reuses the EXISTING odds-proxy edge function
   unmodified (it's already sport-agnostic). Only the sport key and
   market list change vs MLB/NFL.
   ============================================================ */
const SUPABASE_URL = "https://jkpctgapbsyzqjfiiuoe.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprcGN0Z2FwYnN5enFqZmlpdW9lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4NzE5MDMsImV4cCI6MjEwMzQ0NzkwM30.9UT8ILqf6Xpk9LNangxZKfQZmv6Woa7WlbzRVyxdttg";
const ODDS_PROXY_URL = `${SUPABASE_URL}/functions/v1/odds-proxy`;

function normName(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, " ").replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/\s+/g, " ").trim();
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
   ported from MLB/NFL's storage layer verbatim (prefix renamed nba*).
   ============================================================ */
const MODEL_VERSION = "nba-v1-2026-09";
const LS_BETS = "nbaef_mybets_v1";
function loadBets() { try { return JSON.parse(localStorage.getItem(LS_BETS)) || []; } catch { return []; } }
function saveBets(b) { try { localStorage.setItem(LS_BETS, JSON.stringify(b)); } catch { /* storage unavailable */ } }
const LS_CREDITS = "nbaef_credits_v1";
function loadCredits() { try { const v = localStorage.getItem(LS_CREDITS); return v == null || v === "" ? null : +v; } catch { return null; } }

const BOARD_LOG_MAX_ROWS = 100000;
const BOARD_LOG_RETENTION_DAYS = 60;
const BOARD_DB_NAME = "nbaef_boardlog_db";
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
async function appendBoardLog(entries, modelVersion, dateKeyStr) {
  if (!entries || !entries.length) return;
  await boardLogReady;
  const existing = loadBoardLog();
  const existingIds = new Set(existing.map((e) => e.logId));
  const now = new Date().toISOString();
  const cutoffMs = Date.now() - BOARD_LOG_RETENTION_DAYS * 86400000;
  const newRows = entries.filter((e) => e.modelP != null && e.novig != null).map((e) => {
    const logId = `${dateKeyStr}|${e.id}`;
    return {
      logId, loggedAt: now, modelVersion, date: dateKeyStr,
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
  for (const b of settledBets) { if (b.status === "open") continue; const key = `${b.date}|${b.gamePk}|${b.playerId}|${b.type}|${b.line}|${b.side}`; lookup[key] = { actual: b.actual, result: b.status }; }
  let changed = false;
  const updated = log.map((e) => {
    if (e.settled) return e;
    const key = `${e.date}|${e.gamePk}|${e.playerId}|${e.type}|${e.line}|${e.side}`;
    const hit = lookup[key]; if (!hit) return e;
    changed = true; return { ...e, settled: true, actualStat: hit.actual, result: hit.result };
  });
  if (changed) saveBoardLog(updated);
}

/* ---- settling helpers ----
   ESPN's NBA box score (unlike NFL's multi-category passing/rushing/receiving split) reports
   one flat stat line per player — no cross-category label collisions to worry about, so
   actualFor() looks the field up directly by key/label. */
const BOX_STAT_FOR = {
  "Points": ["points", "PTS"], "Rebounds": ["rebounds", "REB"], "Assists": ["assists", "AST"],
  "Three-Pointers Made": ["threePointFieldGoalsMade", "3PM"], "Steals": ["steals", "STL"], "Blocks": ["blocks", "BLK"], "Turnovers": ["turnovers", "TO"],
};
function actualFor(type, ps) {
  if (!ps) return null; // player never appeared in the box score -> void/DNP, handled upstream
  if (type === "Pts+Reb+Ast" || type === "Pts+Reb" || type === "Pts+Ast" || type === "Reb+Ast" || type === "Blocks+Steals" || type === "Double-Double" || type === "Triple-Double") {
    const p = num(ps.points ?? ps.PTS), r = num(ps.rebounds ?? ps.REB), a = num(ps.assists ?? ps.AST), s = num(ps.steals ?? ps.STL), bl = num(ps.blocks ?? ps.BLK);
    if (type === "Pts+Reb+Ast") return p + r + a;
    if (type === "Pts+Reb") return p + r;
    if (type === "Pts+Ast") return p + a;
    if (type === "Reb+Ast") return r + a;
    if (type === "Blocks+Steals") return bl + s;
    const cats = [p, r, a, s, bl].filter((x) => x >= 10).length;
    return (type === "Double-Double" ? cats >= 2 : cats >= 3) ? 1 : 0;
  }
  const cands = BOX_STAT_FOR[type];
  if (!cands) return null;
  for (const key of cands) { if (ps[key] != null) return num(ps[key]); }
  return 0; // participated, recorded zero in this category — a real gradeable zero, not an unknown
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
    if (homeScore === awayScore) return { status: "push", actual: `${awayScore}-${homeScore}` }; // practically never happens (OT resolves it) but keep the grid honest
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
export default function NBAApp() {
  const [date, setDate] = useState(() => new Date());
  const dKey = dateKey(date);
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [stamp, setStamp] = useState(null);
  const [tab, setTab] = useState("slate");
  const [open, setOpen] = useState(null);
  const [detail, setDetail] = useState({});
  const [book, setBook] = useState("draftkings");
  const [board, setBoard] = useState({});
  const [oddsLoading, setOddsLoading] = useState(null);
  const [credits, setCredits] = useState(loadCredits());
  const [oddsFetches, setOddsFetches] = useState(0);
  const [boardLogCount, setBoardLogCount] = useState(() => loadBoardLog().length);
  const [boardLogSettling, setBoardLogSettling] = useState(false);
  const [boardLogSettleMsg, setBoardLogSettleMsg] = useState("");
  const [boardSort, setBoardSort] = useState("ev_desc");
  const [minEdge, setMinEdge] = useState("");
  const [minModel, setMinModel] = useState("");
  const [minOdds, setMinOdds] = useState("");
  const [maxOdds, setMaxOdds] = useState("");
  const [minDelta, setMinDelta] = useState("");
  const [maxDelta, setMaxDelta] = useState("");
  const [dirAligned, setDirAligned] = useState(false);
  const [showMoreBoard, setShowMoreBoard] = useState(false);
  const [catFilter, setCatFilter] = useState("all");
  const [boardSearch, setBoardSearch] = useState("");
  const [gameFilter, setGameFilter] = useState("all");
  const [sideFilter, setSideFilter] = useState("all");
  const [classFilter, setClassFilter] = useState("all");
  const [showProjBar, setShowProjBar] = useState(true);
  const [analysisProfile, setAnalysisProfile] = useState(null);
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

  async function loadSchedule() {
    setLoading(true); setErr(""); setOpen(null); setDetail({}); setBoard({});
    eventsRef.current = { sportKey: null, events: null };
    try {
      const gs = await fetchSchedule(date); setGames(gs); setStamp(new Date());
      if (!gs.length) setErr("No games on this date (off-day, all-star break, or offseason). Try a different date.");
    } catch (e) { setErr(`Schedule fetch blocked (${e.message}).`); setGames([]); }
    finally { setLoading(false); }
  }
  useEffect(() => { loadSchedule(); /* eslint-disable-next-line */ }, [dKey]);

  const standingsRef = useRef({});
  async function ensureStandings(yr) {
    if (standingsRef.current[yr]) return standingsRef.current[yr];
    const s = await fetchStandings(yr).catch(() => ({}));
    standingsRef.current[yr] = s;
    return s;
  }
  const scheduleRef = useRef({}); // teamId -> games[]
  async function ensureTeamSchedule(teamId, year) {
    const k = `${teamId}-${year}`;
    if (scheduleRef.current[k]) return scheduleRef.current[k];
    const s = await fetchTeamSchedule(teamId, year).catch(() => []);
    scheduleRef.current[k] = s;
    return s;
  }
  function featuredFromRosterAndDepth(roster, depth) {
    // Pick the ~10 players worth pricing: starters (depth rank 1 per position) + primary
    // bench (rank 2), falling back to roster order when depth-chart data is missing —
    // depthConfirmed surfaces which case applies (same pattern as the NFL app's).
    const byPos = {};
    for (const p of roster) { const g = posGroup(p.pos); (byPos[g] = byPos[g] || []).push(p); }
    const rankOf = (p) => (depth[p.id] ? depth[p.id].rank : 99);
    const pick = (g, n) => {
      const sorted = (byPos[g] || []).slice().sort((a, b) => rankOf(a) - rankOf(b)).slice(0, n);
      const topConfirmed = sorted.length === 0 || rankOf(sorted[0]) < 99;
      return sorted.map((p, i) => ({ ...p, depthRank: rankOf(p), depthConfirmed: i === 0 ? topConfirmed : true, isStarter: rankOf(p) === 1 }));
    };
    return [...pick("G", 4), ...pick("F", 4), ...pick("C", 2)];
  }
  async function loadDetail(g) {
    if (detail[g.pk] && detail[g.pk].ready) return detail[g.pk];
    if (inflight.current.has(g.pk)) return null;
    inflight.current.add(g.pk);
    setDetail((p) => ({ ...p, [g.pk]: { loading: true } }));
    const year = date.getMonth() >= 6 ? date.getFullYear() + 1 : date.getFullYear(); // NBA "season year" = the year the season ends (Oct start -> next calendar year)
    const standings = await ensureStandings(year);
    const [rosterH, rosterA, depthH, depthA, teamStatsH, teamStatsA, schedH, schedA] = await Promise.all([
      fetchRoster(g.homeId).catch(() => []), fetchRoster(g.awayId).catch(() => []),
      fetchDepthChart(g.homeId, year).catch(() => ({})), fetchDepthChart(g.awayId, year).catch(() => ({})),
      fetchTeamStats(g.homeId).catch(() => ({ off: {}, def: {} })), fetchTeamStats(g.awayId).catch(() => ({ off: {}, def: {} })),
      ensureTeamSchedule(g.homeId, year), ensureTeamSchedule(g.awayId, year),
    ]);
    const featH = featuredFromRosterAndDepth(rosterH, depthH);
    const featA = featuredFromRosterAndDepth(rosterA, depthA);
    const gamelogs = {};
    const tasks = [];
    for (const p of [...featH, ...featA]) {
      tasks.push(fetchAthleteGamelog(p.id, 10).then((gl) => { gamelogs[p.id] = gl; }).catch(() => {}));
    }
    await Promise.allSettled(tasks);
    const sH = standings[g.homeId] || {}, sA = standings[g.awayId] || {};
    const offH = clamp((sH.ppgFor || LG_PPG) / LG_PPG, 0.75, 1.35);
    const offA = clamp((sA.ppgFor || LG_PPG) / LG_PPG, 0.75, 1.35);
    const defAllowH = clamp((sA.ppgAgainst || LG_PPG) / LG_PPG, 0.75, 1.35);
    const defAllowA = clamp((sH.ppgAgainst || LG_PPG) / LG_PPG, 0.75, 1.35);
    const lambdaH = +clamp(LG_PPG * offH * defAllowH * HOME_COURT_MULT.home, 85, 145).toFixed(2);
    const lambdaA = +clamp(LG_PPG * offA * defAllowA * HOME_COURT_MULT.away, 85, 145).toFixed(2);
    const restH = computeRest(schedH, date), restA = computeRest(schedA, date);
    const obj = {
      ready: true, loading: false,
      home: { roster: rosterH, depth: depthH, featured: featH, teamStats: teamStatsH, standings: sH, rest: restH },
      away: { roster: rosterA, depth: depthA, featured: featA, teamStats: teamStatsA, standings: sA, rest: restA },
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

  /* ---- context builder: one featured player -> the ctx object projectPlayer consumes ---- */
  function playerCtx(d, g, side, p) {
    const isHome = side === "home";
    const teamData = isHome ? d.home : d.away;
    const gl = gamelogFor(d, p.id);
    const impliedTeamPts = isHome ? d.lambdaH : d.lambdaA;
    const projSpreadAbs = Math.abs(d.lambdaH - d.lambdaA);
    // usage boost: sum of "starter-out" flags among this player's own teammates (excluding self),
    // weighted lightly per missing starter — a proxy for missing-usage-share (doc §4)
    const missingUsageShare = (teamData.roster || []).filter((tp) => tp.id !== p.id && (teamData.featured || []).some((f) => f.id === tp.id && f.isStarter) && calculateInjuryAvailability(tp.injuryStatus) === 0).length * 0.08;
    return {
      pos: p.pos, isStarter: !!p.isStarter,
      season: gl ? gl.season : null, recent: gl ? gl.recent : null, games: gl ? gl.games : null,
      injuryStatus: p.injuryStatus, depthRank: p.depthRank,
      impliedTeamPts, projSpreadAbs,
      teamPace: null, oppPace: null, lgPace: LG_PACE, // v1: pace signal not wired from a verified team-stats field yet (see doc §7); neutral until confirmed live
      oppDRTG: null, lgDRTG: null, // v1: uses neutral 1.0x for now (opponent PPG-allowed already feeds the TEAM total via lambdaH/lambdaA)
      oppRebRateAllowed: null, lgRebRateAllowed: null, oppAstAllowed: null, lgAstAllowed: null,
      opp3ptPctAllowed: null, lg3ptPctAllowed: null, oppTovForced: null, lgTovForced: null, oppFgaRimAllowed: null, lgFgaRimAllowed: null,
      missingUsageShare,
      daysRest: (isHome ? d.home.rest : d.away.rest).daysRest, backToBack: (isHome ? d.home.rest : d.away.rest).backToBack,
      crossCountryTravel: false, // v1 simplification — see doc §7
    };
  }
  function gamelogFor(d, pid) { return d && d.gamelogs ? d.gamelogs[pid] : null; }

  async function runAnalysisSearch() {
    const q = analysisQuery.trim();
    if (!q) return;
    setAnalysisSearching(true); setAnalysisErr(""); setAnalysisResults([]);
    try {
      const res = await searchPlayers(q);
      setAnalysisResults(res);
      if (!res.length) setAnalysisErr(`No NBA players matched "${q}".`);
    } catch (e) {
      setAnalysisResults([]);
      setAnalysisErr(`Player search failed (${String((e && e.message) || e)}).`);
    } finally { setAnalysisSearching(false); }
  }
  async function selectAnalysisPlayer(result) {
    setAnalysisLoading(true); setAnalysisErr(""); setAnalysisResults([]); setAnalysisQuery(result.name || "");
    try {
      if (!result.teamId) { setAnalysisErr(`Could not resolve "${result.teamName}" to an NBA team.`); return; }
      const g = games.find((x) => x.homeId === result.teamId || x.awayId === result.teamId);
      if (!g) {
        setAnalysisErr(`${result.name} (${result.teamName}) has no game loaded for ${date.toLocaleDateString()} — switch dates and search again.`);
        return;
      }
      const side = g.homeId === result.teamId ? "home" : "away";
      let d = await loadDetail(g);
      if (!d) { setAnalysisErr("Could not load game context."); return; }
      const teamData = side === "home" ? d.home : d.away;
      let player = teamData.roster.find((p) => String(p.id) === String(result.id));
      if (!player) { setAnalysisErr(`${result.name} wasn't found on ${result.teamName}'s current roster (may be a very recent signing/trade — ESPN's roster feed can lag).`); return; }
      const depth = teamData.depth[player.id];
      player = { ...player, depthRank: depth ? depth.rank : 99, isStarter: depth ? depth.rank === 1 : false };
      if (!d.gamelogs[player.id]) {
        const gl = await fetchAthleteGamelog(player.id, 10).catch(() => null);
        d = { ...d, gamelogs: { ...d.gamelogs, [player.id]: gl } };
        setDetail((p) => ({ ...p, [g.pk]: d }));
      }
      setAnalysisProfile({ game: g, side, player, detail: d });
      setTab("analysis");
    } catch (e) {
      setAnalysisErr(`Could not load player profile (${String((e && e.message) || e)}).`);
    } finally { setAnalysisLoading(false); }
  }

  async function getOdds(g) {
    if (oddsFetches >= ODDS_TESTING_LIMIT) { setErr(`Per-session fetch cap (${ODDS_TESTING_LIMIT}) reached — reload to reset, or raise ODDS_TESTING_LIMIT.`); return; }
    setOddsLoading(g.pk); setErr("");
    try {
      const d = await loadDetail(g);
      if (!d) { setOddsLoading(null); return; }
      if (!eventsRef.current.events || eventsRef.current.sportKey !== ODDS_SPORT) {
        const ev = await fetchOddsEvents(ODDS_SPORT); eventsRef.current = { sportKey: ODDS_SPORT, events: ev.events }; if (ev.remaining != null) setCredits(ev.remaining);
      }
      const ev = matchEvent(eventsRef.current.events, g);
      if (!ev) { setErr(`No odds event matched ${g.away}@${g.home} (book may not have posted lines yet).`); setOddsLoading(null); return; }
      const res = await fetchEventOdds(ODDS_SPORT, ev.id, book); if (res.remaining != null) setCredits(res.remaining);
      setOddsFetches((n) => n + 1);
      const rows = parseEventOdds(res.data, book);
      const gl = parseGameOdds(res.data, book, g);
      const byName = {};
      for (const side of ["home", "away"]) {
        const teamData = side === "home" ? d.home : d.away;
        for (const p of teamData.featured) byName[normName(p.name)] = { ctx: playerCtx(d, g, side, p), name: p.name, id: p.id, pos: p.pos };
      }
      const entries = [];
      for (const row of rows) {
        const found = byName[normName(row.player)];
        if (!found) continue;
        const pre = projectPlayer(found.ctx, row.type, parseFloat(row.point));
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
      if (!entries.length) setErr(`Got odds for ${g.away}@${g.home} but matched no players (props may not be posted yet this far out — try closer to tip-off).`);
    } catch (e) {
      setErr(`Odds fetch failed (${e.message}). Check the key/credits or CORS.`);
    } finally { setOddsLoading(null); }
  }

  const boardEntries = useMemo(() => Object.values(board).flat(), [board]);
  useEffect(() => {
    if (boardEntries.length > 0) {
      appendBoardLog(boardEntries, MODEL_VERSION, dKey).then(() => { setBoardLogCount(loadBoardLog().length); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardEntries]);
  const boardGames = useMemo(() => {
    const seen = {}; const out = [];
    for (const e of boardEntries) if (!seen[e.gamePk]) { seen[e.gamePk] = 1; out.push({ pk: String(e.gamePk), label: e.game }); }
    return out;
  }, [boardEntries]);
  const getDelta = (e) => (e.proj ?? 0) - parseFloat(e.line ?? 0);
  const grouped = useMemo(() => {
    const minE = parseFloat(minEdge);
    const minM = parseFloat(minModel);
    const minO = parseFloat(minOdds);
    const maxO = parseFloat(maxOdds);
    const minD = parseFloat(minDelta);
    const maxD = parseFloat(maxDelta);
    const f = boardEntries.filter((e) => {
      if (e.modelP == null) return false;
      if (e.modelP >= 0.999 || e.modelP <= 0.001) return false;
      if (!isNaN(minE) && !(e.edge != null && e.edge * 100 >= minE)) return false;
      if (!isNaN(minM) && !(e.modelP * 100 >= minM)) return false;
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
  }, [boardEntries, boardSort, minEdge, minModel, minOdds, maxOdds, minDelta, maxDelta, dirAligned, catFilter, classFilter, gameFilter, sideFilter, boardSearch]);
  const filtersActive = classFilter !== "all" || catFilter !== "all" || gameFilter !== "all" || sideFilter !== "all" || minEdge !== "" || minModel !== "" || minOdds !== "" || maxOdds !== "" || minDelta !== "" || maxDelta !== "" || dirAligned || boardSearch !== "";
  function clearFilters() { setClassFilter("all"); setCatFilter("all"); setGameFilter("all"); setSideFilter("all"); setMinEdge(""); setMinModel(""); setMinOdds(""); setMaxOdds(""); setMinDelta(""); setMaxDelta(""); setDirAligned(false); setBoardSearch(""); }

  function trackBet(e) {
    const exists = myBets.some((b) => b.key === e.id);
    if (exists) return;
    const sug = suggestedUnits(e.modelP, Number(e.odds));
    const units = stakeMode === "kelly" ? (sug > 0 ? sug : 1) : 1;
    const rec = { key: e.id, date: dKey, gamePk: e.gamePk, game: e.game, playerId: e.playerId, name: e.name, type: e.type, line: e.line, side: e.side, odds: e.odds, book: e.book, modelP: e.modelP, proj: e.proj, novig: e.novig, units, suggested: sug, status: "open", actual: null };
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
      const res = results[b.gamePk]; if (!res) return b;
      if (res.canceled) { graded++; return { ...b, status: "void", actual: "CANCELED" }; }
      if (!res.final) return b;
      if (isLineType(b.type)) {
        const { status, actual } = gradeLine(b.type, b.side, parseFloat(b.line), res.homeScore, res.awayScore);
        if (!status) return b; graded++; return { ...b, status, actual };
      }
      const ps = res.players[b.playerId];
      if (!ps) { graded++; return { ...b, status: "void", actual: "DNP" }; }
      const actual = actualFor(b.type, ps);
      const st = isYesNoType(b.type) ? (actual === 1 ? (b.side === "over" ? "won" : "lost") : (b.side === "over" ? "lost" : "won")) : gradeBet(b.side, parseFloat(b.line), actual);
      if (st == null) return b;
      graded++; return { ...b, status: st, actual };
    }));
    setSettleMsg(`Settled ${graded} bet(s). Unsettled games are still in progress.`);
  }

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
      let graded = 0;
      const updated = log.map((e) => {
        if (e.settled) return e;
        const res = results[e.gamePk];
        if (!res) return e;
        if (res.canceled) { graded++; return { ...e, settled: true, actualStat: "CANCELED", result: "void" }; }
        if (!res.final) return e;
        if (isLineType(e.type)) {
          const { status, actual } = gradeLine(e.type, e.side, parseFloat(e.line || "0"), res.homeScore, res.awayScore);
          if (!status) return e;
          graded++; return { ...e, settled: true, actualStat: actual, result: status };
        }
        const ps = res.players[e.playerId];
        if (!ps) { graded++; return { ...e, settled: true, actualStat: "DNP", result: "void" }; }
        const actual = actualFor(e.type, ps);
        const status = isYesNoType(e.type) ? (actual === 1 ? (e.side === "over" ? "won" : "lost") : (e.side === "over" ? "lost" : "won")) : gradeBet(e.side, parseFloat(String(e.line)), actual);
        if (status == null) return e;
        graded++; return { ...e, settled: true, actualStat: actual, result: status };
      });
      saveBoardLog(updated);
      const totalSettled = updated.filter((e) => e.settled).length;
      setBoardLogCount(updated.length);
      setBoardLogSettleMsg(`Graded ${graded} board log entr${graded === 1 ? "y" : "ies"} across ${pks.length} game(s). ${totalSettled.toLocaleString()} / ${updated.length.toLocaleString()} total entries now settled.`);
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
    const headers = ["logId", "loggedAt", "modelVersion", "date", "game", "gamePk", "playerId", "name", "type", "line", "side", "odds", "novig", "rawModelP", "calibratedP", "edge", "ev", "proj", "settled", "actualStat", "result"];
    const rows = [headers.join(",")];
    for (const e of log) {
      rows.push([
        esc(e.logId), esc(e.loggedAt), esc(e.modelVersion), esc(e.date),
        esc(e.game), esc(e.gamePk), esc(e.playerId), esc(e.name),
        esc(e.type), esc(e.line), esc(e.side), esc(e.odds),
        e.novig ?? "", e.rawModelP ?? "", e.calibratedP ?? "",
        e.edge ?? "", e.ev ?? "", e.proj ?? "",
        e.settled ? "true" : "false", e.actualStat ?? "", esc(e.result),
      ].join(","));
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `nba-board-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function clearBoardLog() {
    if (typeof window !== "undefined" && !window.confirm("Clear ALL board log entries? This cannot be undone. Export a CSV first.")) return;
    saveBoardLog([]);
    setBoardLogCount(0);
    setBoardLogSettleMsg("");
  }

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
    const header = ["date", "game", "name", "type", "line", "side", "odds", "book", "units", "modelP", "novig", "edge", "status", "actual"];
    const rows = myBets.map((b) => [b.date, b.game, b.name, b.type, b.line, b.side, b.odds, b.book, b.units, b.modelP, b.novig, (b.modelP != null && b.novig != null) ? (b.modelP - b.novig) : "", b.status, b.actual].map(esc).join(","));
    const csv = [header.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `nba-edge-finder-bets-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }
  function backupBets() {
    const data = JSON.stringify({ app: "nba-edge-finder", v: 1, exported: new Date().toISOString(), bets: myBets }, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `nba-edge-finder-bets-${new Date().toISOString().slice(0, 10)}.json`;
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

  const analysisCtx = useMemo(() => {
    if (!analysisProfile || !analysisProfile.detail || !analysisProfile.detail.ready) return null;
    return playerCtx(analysisProfile.detail, analysisProfile.game, analysisProfile.side, analysisProfile.player);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisProfile]);
  const analysisProjections = useMemo(() => {
    if (!analysisCtx) return [];
    return ALL_PLAYER_PROPS.map((type) => {
      const line = DEFAULT_LINE[type] || "0.5";
      const pr = projectPlayer(analysisCtx, type, parseFloat(line));
      return { type, line, ...pr, overP: pr.pOver, underP: pr.pOver != null ? 1 - pr.pOver : null, overFair: pr.pOver != null ? probToAmerican(pr.pOver) : "—", underFair: pr.pOver != null ? probToAmerican(1 - pr.pOver) : "—" };
    });
  }, [analysisCtx]);
  const analysisBoardEntries = useMemo(() => {
    if (!analysisProfile) return [];
    const pid = String(analysisProfile.player.id);
    return boardEntries.filter((e) => String(e.playerId) === pid);
  }, [analysisProfile, boardEntries]);

  const TABS = [
    { k: "slate", t: "Slate" }, { k: "board", t: `Board${boardEntries.length ? ` (${boardEntries.length})` : ""}` },
    { k: "analysis", t: "Player Analysis" }, { k: "bets", t: `My Bets${myBets.filter((b) => b.status === "open").length ? ` (${myBets.filter((b) => b.status === "open").length})` : ""}` },
    { k: "stats", t: "Stats" },
  ];
  function shiftDate(days) { setDate((d) => { const n = new Date(d); n.setDate(n.getDate() + days); return n; }); }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <div className="max-w-5xl mx-auto px-4 pb-28">
        <header className="pt-6 pb-3 sticky top-0 bg-slate-950 z-20 border-b border-slate-800">
          <div className="flex items-end justify-between flex-wrap gap-3">
            <div>
              <h1 className="text-2xl font-black tracking-tight">🏀 NBA <span className="text-emerald-400">EDGE</span> FINDER</h1>
              <p className="text-[11px] text-slate-500 mt-0.5" style={mono}>live odds · de-vigged edge · Monte-Carlo props</p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1">
                <button onClick={() => shiftDate(-1)} className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-800">◂</button>
                <input type="date" value={dKey} onChange={(e) => { const [y, m, d] = e.target.value.split("-").map(Number); if (y) setDate(new Date(y, m - 1, d)); }} className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100" />
                <button onClick={() => shiftDate(1)} className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-800">▸</button>
                <button onClick={() => setDate(new Date())} className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs hover:bg-slate-800 text-slate-400">today</button>
              </div>
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
                    {hasOdds ? <span className="shrink-0 text-[10px] font-bold text-emerald-300 bg-emerald-900/40 border border-emerald-800 rounded-full px-1.5 py-0.5" style={mono}>● {hasOdds}</span> : null}
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
                      {(!d || d.loading) && <div className="py-6 text-center text-sm text-slate-500" style={mono}>loading rosters, depth chart, rest/schedule…</div>}
                      {d && d.ready && (
                        <>
                          <div className="flex flex-wrap gap-2 mt-3 text-[11px]" style={mono}>
                            <Env label="VENUE" v={g.venue || "—"} />
                            <Env label={`${g.home} REST`} v={d.home.rest.backToBack ? "B2B" : `${d.home.rest.daysRest}d`} hot={d.home.rest.backToBack} />
                            <Env label={`${g.away} REST`} v={d.away.rest.backToBack ? "B2B" : `${d.away.rest.daysRest}d`} hot={d.away.rest.backToBack} />
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
                            <div className="text-[10px] text-slate-600 mt-1.5">model line from team scoring env (standings PF/PA × home court) — compare to market for game-line edges once moneyline odds are wired in.</div>
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
            {!games.length && !loading ? <div className="text-slate-500 text-sm py-10 text-center">No games loaded. Try a different date (off-days and the All-Star break are normal — this isn't necessarily a fetch error).</div> : null}
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
              {(() => { const n = [minEdge, minModel, minOdds, maxOdds, minDelta, maxDelta].filter((x) => x !== "").length + (dirAligned ? 1 : 0); return (
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
                  <input value={maxDelta} onChange={(e) => setMaxDelta(e.target.value)} placeholder="e.g. 5.0" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">min odds
                  <input value={minOdds} onChange={(e) => setMinOdds(e.target.value)} placeholder="-300" inputMode="numeric" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">max odds
                  <input value={maxOdds} onChange={(e) => setMaxOdds(e.target.value)} placeholder="+300" inputMode="numeric" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">proj aligned
                  <button onClick={() => setDirAligned((s) => !s)} className={`text-xs rounded px-3 py-1.5 border font-medium ${dirAligned ? "border-sky-600 bg-sky-950 text-sky-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`} title="Only show plays where proj direction agrees with the bet side">{dirAligned ? "on" : "off"}</button>
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
                    placeholder="Nikola Jokic"
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
                League-wide NBA player lookup (any team, any date). Only players with a game loaded for the
                currently selected date get full matchup context, projections, and odds — switch dates above if a
                search hit's team isn't playing today. You can also click a player name directly on the Slate tab
                after expanding a game, which skips the search step.
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
              <div className="text-slate-500 text-sm p-4">Search any NBA player above, or click a player name on the Slate tab (after expanding a game) to see their full projection breakdown here.</div>
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
            <div className="flex flex-wrap gap-2 mb-3 items-end">
              <Sel label="status" v={betStatusFilter} opts={["all", "open", "won", "lost", "push", "void", "settled"]} onChange={setBetStatusFilter} compact />
              <Sel label="sort" v={betSort} opts={["recent", "model_desc", "ev_desc", "edge_desc"]} labels={{ recent: "Recent", model_desc: "Model %", ev_desc: "EV", edge_desc: "Edge" }} onChange={setBetSort} compact />
              <input value={betSearch} onChange={(e) => setBetSearch(e.target.value)} placeholder="search" className="bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-sm text-slate-100" />
              <Sel label="stake mode (new bets)" v={stakeMode} opts={["flat", "kelly"]} onChange={setStakeMode} compact />
              <button onClick={settleBets} className="bg-emerald-700 hover:bg-emerald-600 text-white font-bold text-xs rounded-lg px-3 py-1.5">Settle open bets</button>
              <button onClick={exportCSV} className="border border-slate-700 text-slate-300 hover:text-slate-100 text-xs rounded-lg px-3 py-1.5">Export CSV</button>
              <button onClick={backupBets} disabled={myBets.length === 0} className="border border-slate-700 text-slate-300 hover:text-slate-100 disabled:opacity-40 text-xs rounded-lg px-3 py-1.5" title="Save a .json backup you can restore later or on another device">Backup</button>
              <label className="border border-slate-700 text-slate-300 hover:text-slate-100 text-xs rounded-lg px-3 py-1.5 cursor-pointer" title="Restore bets from a .json backup">Restore
                <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => { restoreBets(e.target.files && e.target.files[0]); e.target.value = ""; }} />
              </label>
              <button onClick={resetStats} className="border border-rose-900 text-rose-400 hover:text-rose-300 text-xs rounded-lg px-3 py-1.5">Clear all</button>
              {settleMsg ? <span className="text-[11px] text-slate-500">{settleMsg}</span> : null}
            </div>
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
  const c = status === "OUT" || status === "SUSPENDED" ? "bg-rose-600" : status === "DOUBTFUL" ? "bg-orange-600" : "bg-amber-600";
  return <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold text-white ${c}`}>{status.replace(/_/g, " ")}</span>;
}
function L10Hint({ gl }) {
  if (!gl || !gl.recent || !gl.recent.games) return null;
  const ppg = (gl.recent.pts || 0) / gl.recent.games;
  return <span className="text-[9px] text-slate-500 shrink-0" style={mono} title={`last ${gl.recent.games} games`}>L{gl.recent.games} {ppg.toFixed(1)} ppg</span>;
}
function PlayerRow({ idx, p, onClick, gl }) {
  return (
    <div className="flex items-center gap-2 text-[12px] px-1 py-1 rounded hover:bg-slate-900/60">
      <span className="text-slate-600 w-4 shrink-0" style={mono}>{idx}</span>
      <span className="w-9 text-[10px] text-slate-500 shrink-0 inline-flex items-center gap-0.5" style={mono}>
        {p.pos}{p.isStarter ? "*" : ""}
        {p.depthConfirmed === false && <span className="text-amber-500" title="No confirmed depth chart for this team — pick order falls back to arbitrary roster listing, not a verified starter">?</span>}
      </span>
      <button onClick={() => onClick(p)} className="flex-1 text-left truncate hover:text-sky-300 cursor-pointer" title="Open player analysis">{p.name}</button>
      <L10Hint gl={gl} />
      <InjBadge status={p.injuryStatus} />
    </div>
  );
}
function LineupCol({ title, d, side, onPlayerClick }) {
  const teamData = side === "home" ? d.home : d.away;
  if (!teamData) return null;
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1.5">{title}</div>
      <div className="space-y-0.5">
        {teamData.featured.map((p, i) => <PlayerRow key={p.id} idx={i + 1} p={p} onClick={onPlayerClick} gl={d.gamelogs && d.gamelogs[p.id]} />)}
      </div>
    </div>
  );
}
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
  const pm = !isLineType(e.type) && !isYesNoType(e.type) ? projMeta(e.proj, e.line, e.side) : null;
  return (
    <div className="bg-slate-900/70 border border-slate-800 rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 flex-wrap">
        <div className="flex-1 min-w-[160px]">
          <div className="font-semibold truncate">{e.name} <span className="text-slate-500 text-xs">{e.game}</span></div>
          <div className="text-[11px] text-slate-400" style={mono}>
            {isYesNoType(e.type) ? (e.side === "over" ? "Yes" : "No") : `${e.side} ${e.line}`} {e.type} @ {fmtOdds(e.odds)} · <span className="text-sky-300">{isYesNoType(e.type) ? `p ${pct(e.proj)}` : `proj ${e.proj != null ? e.proj.toFixed(2) : "—"}`}</span>
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
  return (
    <div className="flex items-center gap-3 bg-slate-900/70 border border-slate-800 rounded-xl px-4 py-3 flex-wrap">
      <div className="flex-1 min-w-[160px]">
        <div className="font-semibold truncate">{b.name}</div>
        <div className="text-[11px] text-slate-500 truncate" style={mono}>{b.game} · {b.book}</div>
      </div>
      <div className="text-[11px] text-slate-300" style={mono}>{b.type} {b.side} {b.line}</div>
      <input value={b.odds} onChange={(e) => onOdds(b.key, e.target.value)} className="w-16 bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-100" style={mono} />
      <input value={b.units} onChange={(e) => onUnits(b.key, e.target.value)} className="w-14 bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-100" title="units" />
      <div className="text-[11px] text-slate-400" style={mono}>model {pct(b.modelP)}</div>
      <div className={`text-[11px] font-bold ${b.edge > 0 ? "text-emerald-400" : "text-rose-400"}`} style={mono}>{b.edge != null ? `${(b.edge * 100).toFixed(1)}%` : "—"}</div>
      <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${statusColor}`}>{b.status}</span>
      <button onClick={() => onRemove(b.key)} className="text-[11px] text-slate-500 hover:text-rose-400 border border-slate-700 rounded px-2 py-1">✕</button>
    </div>
  );
}
function AnalysisProjectionRow({ r }) {
  const [show, setShow] = useState(false);
  return (
    <div className="bg-slate-900/70 border border-slate-800 rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 flex-wrap">
        <div className="w-32 font-semibold shrink-0">{r.type}</div>
        <div className="text-[11px] text-slate-400" style={mono}>{isYesNoType(r.type) ? null : <>line {r.line} · </>}<span className="text-sky-300">{isYesNoType(r.type) ? `p(yes) ${pct(r.proj)}` : `proj ${r.proj != null ? r.proj.toFixed(2) : "—"}`}</span></div>
        <div className="text-[11px] ml-auto flex items-center gap-3" style={mono}>
          {isYesNoType(r.type) ? (
            <span className="text-emerald-400">Yes {pct(r.overP)} ({r.overFair})</span>
          ) : (
            <>
              <span className="text-emerald-400">O {pct(r.overP)} ({r.overFair})</span>
              <span className="text-rose-400">U {pct(r.underP)} ({r.underFair})</span>
            </>
          )}
          {r.calc ? <button onClick={() => setShow((s) => !s)} className="text-slate-500 hover:text-emerald-300 border border-slate-700 rounded px-2 py-1">{show ? "hide" : "math"}</button> : null}
        </div>
      </div>
      {show && <MathPanel r={r} />}
    </div>
  );
}
function PlayerAnalysisPanel({ profile, ctx, projections, boardEntries, onTrack, myBets }) {
  const p = profile.player;
  const season = ctx.season, recent = ctx.recent;
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
              src={`https://a.espncdn.com/i/headshots/nba/players/full/${p.id}.png`}
              alt=""
              className="w-16 h-16 rounded-xl object-cover border border-slate-700 bg-slate-800 flex-shrink-0"
              onError={(e) => { e.currentTarget.style.display = "none"; }}
            />
            <div>
              <div className="text-2xl font-black tracking-tight">{p.name}</div>
              <div className="text-[11px] text-slate-500 mt-1" style={mono}>
                {teamName || "—"} · {ctx.pos}{ctx.isStarter ? " · starter" : ""}
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
          <MiniMetric label="Pts/G" value={rate(season, "pts")} />
          <MiniMetric label="Reb/G" value={rate(season, "reb")} />
          <MiniMetric label="Ast/G" value={rate(season, "ast")} />
          <MiniMetric label="Min/G" value={rate(season, "min")} />
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-3">
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
          <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1.5">MATCHUP</div>
          <div className="text-[11px] text-slate-300 space-y-1" style={mono}>
            <div>{profile.game.away} @ {profile.game.home}</div>
            <div>proj spread (abs): {ctx.projSpreadAbs != null ? ctx.projSpreadAbs.toFixed(1) : "—"}</div>
            <div>implied team pts: {ctx.impliedTeamPts != null ? ctx.impliedTeamPts.toFixed(1) : "—"}</div>
            <div>rest: {ctx.backToBack ? "back-to-back" : `${ctx.daysRest != null ? ctx.daysRest : "—"} day(s)`}</div>
          </div>
        </div>
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
          <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1.5">SEASON (THIS YEAR)</div>
          <div className="text-[11px] text-slate-300 space-y-0.5" style={mono}>
            {hasSeason ? Object.entries(season).filter(([k]) => k !== "g").map(([k, v]) => <div key={k}>{k}: {typeof v === "number" ? v.toFixed(1) : v}</div>) : <div className="text-slate-600">no season log yet</div>}
          </div>
        </div>
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
          <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1.5">LAST 10 GAMES</div>
          <div className="text-[11px] text-slate-300 space-y-0.5" style={mono}>
            {hasRecent ? Object.entries(recent).filter(([k]) => k !== "games").map(([k, v]) => <div key={k}>{k}: {typeof v === "number" ? v.toFixed(1) : v}</div>) : <div className="text-slate-600">no recent log yet</div>}
          </div>
        </div>
      </div>

      <GameLogCard games={ctx.games} />

      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
        <div className="text-xs font-bold text-slate-300">Model Projections</div>
        <div className="text-[11px] text-slate-500 mb-2" style={mono}>every tracked prop, priced to the default line</div>
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
function GameLogCard({ games }) {
  const rows = (games || []).slice(0, GAMELOG_ROWS);
  const cols = [["min", "MIN"], ["pts", "PTS"], ["reb", "REB"], ["ast", "AST"], ["stl", "STL"], ["blk", "BLK"], ["tov", "TO"], ["fg3m", "3PM"]];
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">LAST {GAMELOG_ROWS} GAMES</div>
      {!rows.length ? <div className="text-sm text-slate-500">No game log returned.</div> : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]" style={mono}>
            <thead className="text-slate-600">
              <tr>{["date", "opp", ...cols.map(([, h]) => h)].map((h) => <th key={h} className="text-right font-semibold py-1 first:text-left">{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((g, i) => (
                <tr key={g.eventId || i} className="border-t border-slate-800/80">
                  <td className="py-1 text-left text-slate-400">{g.date ? new Date(g.date).toLocaleDateString([], { month: "numeric", day: "numeric" }) : "—"}</td>
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
