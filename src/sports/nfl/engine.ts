/* NFL projection engine (moved from the old src/nfl/NFLApp.tsx; model math unchanged, nfl-v2). */
import { clamp, evPerUnit, hashSeed, impliedProb, negativeBinomialPMF, noVigProb, poiCdf, probToAmerican, runMonteCarlo, sampleNegBin, oneSidedFair } from "../../core/math";
import { DST_PROPS, K_PROPS, LG_PPG, NFL_PTS_PHI, QB_PROPS, RB_PROPS, WR_PROPS } from "./config";

export function probabilityOver(family, line, side, seed, params) {
  let over;
  if (family === "poisson" || (params && params.phi != null && params.phi <= 1)) over = 1 - poiCdf(Math.floor(line), params.mean); // v4: phi 1 = Poisson
  else over = runMonteCarlo(() => sampleNegBin(params.mean, params.phi), line, "over", seed);
  return side === "over" ? over : 1 - over;
}
export function liveProbabilityOver(family, seed, params, currentTotal, line) {
  const adj = line - (currentTotal || 0);
  if (adj < 0) return 1;
  return probabilityOver(family, adj, "over", seed, params);
}


// per-market calibration: DAY-1 PRIOR. MLB's per-category CALIB_KEEP values took months of
// settled bets to earn (see App.tsx's dated calibration log). We have no settled-bet history
// for football yet, so every category starts at a conservative, uniform "trust the market a lot"
// weight. Retune per-category from the Stats tab exactly the way MLB did — do NOT hand-tune
// these from vibes; wait for graded volume.
export const MODEL_VERSION = "nfl-v4.1-2026-11-16";   // v4.1: Anytime TD one-sided de-vig. Bump on every model change (part of every board-log id). v3: opponent positional matchups (nflverse weekly stats). v4: replay-fit priors / shrinkage / spreads, QB volume from starts
/* v4 (2026-11-12): every prior, shrink weight and spread refit by replaying the 2025 season week by week from
   nflverse box scores (inputs built only from earlier weeks, the way the page builds them; the app's own
   projections match the replay at a median ratio of 1.000) and checked on 2026 weeks 1-9 (held out).
   Biggest fix: QB volume. v3 averaged a QB's attempts over every game he appeared in and shrank toward his
   own per-game average from last season, so a backup thrust into a start (Minshew 6 att vs a 34.5 line,
   Milton 6 vs 31.5) or any QB with a few partial games projected far too low; starters overall ran ~6% low.
   v4 counts only starts (15+ attempts) and shrinks toward his last-season per-start average (3+ starts) or a
   30-attempt starter prior. See V4 below for every setting. */

export const CALIB_KEEP = {
  "Pass Yards": 0.45, "Pass TDs": 0.40, "Interceptions": 0.35, "Pass Completions": 0.45, "Pass Attempts": 0.45, "Longest Completion": 0.35,
  "Rush Yards": 0.45, "Rush TDs": 0.35, "Longest Rush": 0.35,
  "Receptions": 0.45, "Receiving Yards": 0.45, "Receiving TDs": 0.35, "Longest Reception": 0.35,
  "Anytime TD": 0.35, "Kicking Points": 0.40, "Field Goals Made": 0.40, "Sacks": 0.35, "Def. Interceptions": 0.30,
  // v2: game lines are EXPERIMENTAL. When market odds exist, buildGameLineEntries anchors the team
  // means to the market total/spread, so any "edge" is only the NB shape (which can't see key
  // numbers 3/7). Trust the market heavily until a real score model exists.
  "Spread": 0.25, "Total": 0.25, "Moneyline": 0.25,
};
export const EXPERIMENTAL_TYPES = new Set(["Spread", "Total", "Moneyline", "Longest Completion", "Longest Rush", "Longest Reception", "Kicking Points", "Field Goals Made", "Sacks", "Def. Interceptions"]);
// 2026-11-16: Anytime TD is one-sided (Yes only), so its posted price still carries the hold. Power de-vig
// (core/math oneSidedFair), gamma fitted on the board logs (256 settled ATD rows: hit 0.865x implied -> gamma 1.12).
export const ONE_SIDED_GAMMA = { "Anytime TD": 1.12 };
export const CALIB_KEEP_DEFAULT = 0.5;
export function keepFor(type) { return (type != null && CALIB_KEEP[type] != null) ? CALIB_KEEP[type] : CALIB_KEEP_DEFAULT; }
export function calibrateToMarket(p, market, type) { return (p == null || market == null) ? p : clamp(market + keepFor(type) * (p - market), 0.001, 0.999); }

/* ============================================================
   TEAM SCORING MODEL — game lines (Moneyline / Spread / Total)
   Doc §2. Two-team Negative Binomial grid, same shape as MLB's
   gameProbs/jointGameProbs/marginProb over runs, generalized for
   NFL: bigger grid (points, not runs), and TIES are a real outcome
   (MLB has none). Live (in-progress) reduces "remaining" scoring
   by elapsed-game fraction, same as MLB's fractionRemaining.
   ============================================================ */
export function teamPtsPmf(k, lambda) { return negativeBinomialPMF(k, Math.max(lambda, 1e-6), NFL_PTS_PHI); }
export function gameProbs(lh, la) {
  const N = 66; let pH = 0, pA = 0, pT = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const pr = teamPtsPmf(i, lh) * teamPtsPmf(j, la);
    if (i > j) pH += pr; else if (j > i) pA += pr; else pT += pr;
  }
  return { home: pH, away: pA, tie: pT, totalLambda: lh + la };
}
// generalized for LIVE lines: final = current score + NegBin(remaining lambda) per team.
export function jointGameProbs(lhEff, laEff, hc, ac, totalLine) {
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
export function marginProb(lhEff, laEff, hc, ac, cmp) {
  const N = 66; let p = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    if (cmp((hc + i) - (ac + j))) p += teamPtsPmf(i, lhEff) * teamPtsPmf(j, laEff);
  }
  return p;
}

/* ============================================================
   SHRINKAGE HELPERS (verbatim from MLB — sport-agnostic)
   ============================================================ */
export const blendRate = (seasonRate, recentRate, recentWeight) =>
  (recentRate == null || isNaN(recentRate)) ? seasonRate : seasonRate * (1 - recentWeight) + recentRate * recentWeight;
export function shrinkRate(obsRate, n, prior, k) {
  if (!n) return prior;
  return (obsRate * n + prior * k) / (n + k);
}
export function shrinkValue(obs, count, prior, k) {
  const o = isFinite(obs) ? obs : prior;
  return (o * (count || 0) + prior * k) / ((count || 0) + k);
}
// This player's own prior-season rate (numKey/denKey, e.g. passCmp/passAtt for completion %),
// falling back to the flat league default only when no prior-season log exists at all (a rookie,
// or a player ESPN has no gamelog history for). Used as the `prior` fed into shrinkRate/shrinkValue
// in place of a league-wide constant, so early-season sample thinness shrinks toward "this player's
// own career rate" instead of "average NFL player at this position" — the fix for every player at
// the same depth-chart slot projecting identically in week 1.
export function priorRate(ctx, numKey, denKey, lgDefault, k = 0) {
  const ps = ctx.priorSeason;
  if (!ps || !ps[denKey]) return lgDefault;
  // v4: last season's rate is itself shrunk toward the league default by k (same units as the denominator),
  // so 3 backup games last season can't set a starter's prior (v3: k = 0, his raw rate)
  return (ps[numKey] + k * lgDefault) / (ps[denKey] + k);
}
// Blend + shrink a player's own "longest play" history (season + recent, both averages — see
// fetchAthleteGamelog's avgLong) toward a prior, instead of the old ratio-of-other-stats approach
// that canceled out to one flat number for every player. Prefers this player's own prior-season
// long-play average when available; otherwise falls back to `fallbackPrior` (role-varying — WR1 vs
// slot vs TE, etc. — see callers), never a single league-wide constant.
export function projectLongestStat(ctx, key, fallbackPrior) {
  const s = ctx.season || {}; const l = ctx.recent || null; const ps = ctx.priorSeason;
  // v4: his own last-season average when there is one, else the role prior x 0.9; shrink 8 games (v3: 60)
  const fb = fallbackPrior * V4.long.priorScale;
  const prior = (ps && ps[`${key}Avg`] != null) ? (ps[`${key}Avg`] * (ps[`${key}N`] || 0) + fb * V4.long.k) / ((ps[`${key}N`] || 0) + V4.long.k) : fb; // last season's average, itself shrunk 8 games
  const seasonAvg = s[`${key}Avg`] != null ? s[`${key}Avg`] : null;
  const seasonN = s[`${key}N`] || 0;
  const recentAvg = (l && l[`${key}Avg`] != null) ? l[`${key}Avg`] : null;
  const blended = blendRate(seasonAvg, recentAvg, V4.long.rw);
  return shrinkValue(blended, seasonN, prior, V4.long.k);
}

/* ============================================================
   PROJECTION ENGINE — per position (doc §3)
   ============================================================ */
export const RECENT_WEIGHT = 0.30;       // v3 value; v4 projectors use the per-group settings in V4       // L4-game blend weight — heavier than MLB's 0.20 L15 weight because
                                   // an NFL season (17 games) has far less season-to-date signal to lean on
export const MIN_L4_SNAPS = 2;           // require >=2 recent games with snaps before blending recent form in
// v2 (2026-10-18): refit from the settled board log (weeks 3-6, 827 unique player/game/prop rows).
// The Day-1 yardage priors (2.0-2.4) implied a ~23-yd SD on a 240-yd QB; the observed predictive
// spread is ~65-70 yds (var/mean ~20). That made raw yardage Brier 0.31-0.38 (worse than a coin flip)
// and inflated claimed edge ~3.5x (claimed +10.5pp, realized +2.9pp). Values below are set slightly
// conservative of the in-sample Brier optimum; retune once more weeks settle.
// v4: refit on the 2025 replay (variance / mean; 1 = Poisson). v3 values in comments.
export const NB_PHI = {
  passYds: 27, passAtt: 2.0, passCmp: 1.6, passTd: 1, ints: 1, longestCmp: 5,   // v3: 20, 3.0, 2.0, 1.4, 1.3, 7
  rushYds: 27, rushAtt: 1.8, rushTd: 1, longestRush: 7,                          // v3: 20, -, 1.5, 6
  rec: 1.3, recYds: 30, recTd: 1, longestRec: 8,                                 // v3: 1.4, 22, 1.5, 8
  anytimeTd: 1, kickPts: 2, fgMade: 1, sacks: 1.4, defInt: 1.4,                  // v3: 1.4, 3.5, 1.3
};
/* v4 settings by projector, fit on the 2025 replay (see MODEL_VERSION note). rw = weight on the last 4 games
   (minL4 = games needed to use them); k = games (volume) or opportunities (rates) of prior mixed in. */
export const V4 = {
  qb: { rw: 0.15, minL4: 2, kAtt: 4, kRate: 60, kTd: 150, startAtt: 15, attPrior: 30, priorStartsMin: 3 },
  rush: { rw: 0.30, minL4: 1, kRush: 3, kRate: 60, share1: 0.65, share2: 0.20 },
  recv: { rw: 0.45, minL4: 1, kTgt: 3, kRate: 30, shareWR1: 0.16, shareWR2: 0.13, shareWR3: 0.06, shareTE: 0.14, shareRB: 0.07 },
  long: { rw: 0.15, k: 8, priorScale: 0.9 },       // "longest" stats: v3 shrank 60 games toward a role prior (always ~the prior)
  td: { k: 60, gl1: 1.0, gl2: 0.85, qbRushPrior: 0.20, kQb: 6 }, // TD rates per opportunity; Poisson counts
  k: { fgPerDrive: 0.17, fgPct: 0.88, xpScale: 0.9 },
  // team implied total from the market (total / 2 - spread / 2) vs league 22.25: mean x (teamTotal / 22.25)^e.
  // Fit on 2025, held up on 2026. Rushing volume and kicking showed no effect.
  env: { ref: 22.25, passAtt: 0.3, passYpc: 0.2, passTdRate: 0.3, intRate: -0.2, targets: 0.3, recTdRate: 0.5, rushTd: 0.8, qbRushTd: 0.8 },
};
export function teamEnv(ctx, e) {
  const t = ctx && ctx.teamTotal;
  return t == null || !Number.isFinite(t) || !e ? 1 : clamp(Math.pow(t / V4.env.ref, e), 0.8, 1.25);
}

/* -------- league-average priors (empirical-Bayes shrinkage targets) --------
   Reasonable, well-known NFL per-game/per-attempt benchmarks. Exactly like
   MLB's LG_PRIOR block, these exist ONLY to stabilize thin samples (a rookie's
   first 2 starts, a backup thrust into action) — once a player has real volume,
   his own rate dominates via shrinkRate's sample-size weighting. */
export const LG = {
  compPct: 0.65, ypa: 7.0, ypc_pass: 10.8,          // yards per completion (pass yards = completions × ypc_pass)
  passTdRate: 0.043, intRate: 0.020,                 // per pass attempt
  teamPassAtt: 33.5, teamRushAtt: 27.0,
  rushYpc: 4.2, rushTdRate: 0.028,                    // rush TDs per carry
  catchRate: 0.65, ypt: 8.0, recTdRate: 0.045,        // yards/TDs per target
  targetShareWR1: 0.22, targetShareWR2: 0.15, targetShareRB: 0.10,
  sackRatePerPassAtt: 0.065, defIntRatePerPassAtt: 0.021,
  fgAttPerDrive: 0.17, fgMakePct: 0.85, // v2: was 0.10 -> projected 0.90 FG/g vs 1.77 actual (n=26); NFL teams attempt ~1.8 FGA/g on ~10.8 drives
  passYdsAllowedPerGame: 234.5, rushYdsAllowedPerGame: 113.4, // teamPassAtt*ypa, teamRushAtt*rushYpc — league-avg denominators for calculateOppDefenseAdjustment
};
export const SHRINK_N = { passAtt: 4, rushAtt: 4, targets: 4, rate: 60 }; // "games" or "attempts" of prior weight

// -------- game script: Vegas-spread-driven pass/rush volume shift (NEW vs MLB) --------
// A team expected to trail passes more (garbage-time + catch-up), a team expected to
// lead runs more (clock control). Spread here is signed FOR the team in question
// (positive = team is an underdog by that many points, negative = favored).
export function gameScriptPassMult(teamSpread) {
  if (teamSpread == null || isNaN(teamSpread)) return 1;
  return clamp(1 + clamp(teamSpread, -14, 14) * 0.008, 0.90, 1.10); // +14 dog -> ~1.10x pass volume; -14 fav -> ~0.90x
}
export function gameScriptRushMult(teamSpread) {
  if (teamSpread == null || isNaN(teamSpread)) return 1;
  return clamp(1 - clamp(teamSpread, -14, 14) * 0.006, 0.92, 1.08); // favorites lean run to protect a lead
}

// -------- weather (doc §4) — wind/precip hit passing; cold has a small broad effect --------
export function calculateWeatherAdjustmentPass(ctx) {
  const w = ctx.weather;
  if (!w || (ctx.stadium && ctx.stadium.dome)) return 1;
  let m = 1;
  if (w.wind != null) { if (w.wind >= 20) m -= 0.10; else if (w.wind >= 15) m -= 0.06; else if (w.wind >= 10) m -= 0.02; }
  if (w.temp != null && w.temp <= 25) m -= 0.03;
  if (w.pop != null && w.pop >= 60) m -= 0.04;
  return clamp(m, 0.80, 1.03);
}
export function calculateWeatherAdjustmentRush(ctx) {
  const w = ctx.weather;
  if (!w || (ctx.stadium && ctx.stadium.dome)) return 1;
  let m = 1;
  // bad passing weather -> teams lean on the run more (shifts volume, not just efficiency)
  const passAdj = calculateWeatherAdjustmentPass(ctx);
  if (passAdj < 1) m += (1 - passAdj) * 0.5;
  return clamp(m, 1.0, 1.06);
}
export function calculateWeatherAdjustmentKicking(ctx) {
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
export function calculateOppDefenseAdjustment(oppAllowedRate, leagueAvgRate, lo = 0.75, hi = 1.30) {
  if (!oppAllowedRate || !leagueAvgRate) return 1;
  return clamp(oppAllowedRate / leagueAvgRate, lo, hi);
}
// v3: a matchup multiplier from ctx.mx (matchups.ts: opponent rate per opportunity / league rate,
// already shrunk by sample), clamped. null when this game has no matchup data -> caller keeps v2.
export function mxMult(ctx, group, key, lo = 0.80, hi = 1.25) {
  const v = ctx && ctx.mx && ctx.mx[group] ? ctx.mx[group][key] : null;
  return v == null || !Number.isFinite(v) ? null : clamp(v, lo, hi);
}

// -------- injury adjustment (doc §4, NEW vs MLB) --------
// status: "OUT" | "DOUBTFUL" | "QUESTIONABLE" | "IR" | null (healthy/no report)
export function calculateInjuryAvailability(status) {
  if (status === "OUT" || status === "IR" || status === "SUSPENDED") return 0;      // excluded from slate, like an MLB scratch
  if (status === "DOUBTFUL") return 0.30;                                            // heavy shrink toward backup usage
  if (status === "QUESTIONABLE") return 0.85;                                        // light shrink
  return 1;
}

// -------- rest/travel adjustment (doc §4, NEW vs MLB — no baseball analog) --------
export function calculateRestAdjustment(ctx) {
  let m = 1;
  if (ctx.shortWeek) m -= 0.02;         // Thursday game off a Sunday (≤4 days rest)
  if (ctx.crossCountryTravel) m -= 0.01; // long westward/eastward road trip, small documented effect
  if (ctx.onBye) m += 0.01;              // coming off a bye, fully rested
  return clamp(m, 0.95, 1.02);
}

/* ---- QB projections ---- */
// v4: QB volume comes from his STARTS this season (games with 15+ attempts; season.qbAtt lists every game's
// attempts in order), shrunk toward his last-season per-start average (3+ starts) or a 30-attempt starter
// prior. A depth-chart starter with no starts yet projects as a starter, not as the backup he was.
export function qbStarts(agg) {
  if (!agg) return [];
  if (Array.isArray(agg.qbAtt)) return agg.qbAtt.filter((a) => a >= V4.qb.startAtt);
  // a log built without the per-game list: treat every game as a start if his average says he's a starter
  const avg = agg.g ? (agg.passAtt || 0) / agg.g : 0;
  return avg >= V4.qb.startAtt ? Array(agg.g).fill(avg) : [];
}
export function qbBaseRates(ctx) {
  const s = ctx.season || {}; const Q = V4.qb;
  const cur = qbStarts(s), priorStarts = qbStarts(ctx.priorSeason);
  const avgOf = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const priorPassAtt = priorStarts.length >= Q.priorStartsMin ? avgOf(priorStarts) : Q.attPrior;
  const recent = cur.slice(-4);
  const passAttRaw = blendRate(cur.length ? avgOf(cur) : priorPassAtt, recent.length >= Q.minL4 ? avgOf(recent) : null, Q.rw);
  const passAtt = shrinkValue(passAttRaw, cur.length, priorPassAtt, Q.kAtt);
  const priorCompPct = priorRate(ctx, "passCmp", "passAtt", LG.compPct, Q.kRate);
  const priorYpc = priorRate(ctx, "passYds", "passCmp", LG.ypa / LG.compPct, Q.kRate);
  const priorPassTdRate = priorRate(ctx, "passTd", "passAtt", LG.passTdRate, Q.kTd);
  const priorIntRate = priorRate(ctx, "ints", "passAtt", LG.intRate, Q.kTd);
  const compPct = shrinkRate(s.passAtt ? s.passCmp / s.passAtt : 0, s.passAtt || 0, priorCompPct, Q.kRate);
  const ypc = shrinkRate(s.passCmp ? s.passYds / s.passCmp : 0, s.passCmp || 0, priorYpc, Q.kRate);
  const passTdRate = shrinkRate(s.passAtt ? s.passTd / s.passAtt : 0, s.passAtt || 0, priorPassTdRate, Q.kTd);
  const intRate = shrinkRate(s.passAtt ? s.ints / s.passAtt : 0, s.passAtt || 0, priorIntRate, Q.kTd);
  return { passAtt, compPct, ypc, passTdRate, intRate, starts: cur.length };
}
export function projectQB(ctx, type, line) {
  const base = qbBaseRates(ctx);
  const gs = gameScriptPassMult(ctx.teamSpread);
  const wx = calculateWeatherAdjustmentPass(ctx);
  const oppPass = calculateOppDefenseAdjustment(ctx.oppPassYdsAllowed, ctx.lgPassYdsAllowed);
  // v3: the opposing defense's completion %, yards per completion, pass TDs and INTs allowed per
  // attempt (matchups.ts). Completion % and yards/completion multiply to yards/attempt allowed, so
  // the pass defense counts once (v2 applied its one factor to completions AND to yards).
  const mCmp = mxMult(ctx, "def", "compPct", 0.90, 1.10);
  const mYpc = mxMult(ctx, "def", "ypCmp", 0.85, 1.18);
  const mTd = mxMult(ctx, "def", "passTdRate", 0.70, 1.40);
  const mInt = mxMult(ctx, "def", "intRate", 0.70, 1.40);
  const v3 = mCmp != null;
  const oppCmp = v3 ? mCmp : clamp(oppPass, 0.85, 1.15);
  const oppYpc = v3 ? mYpc : oppPass;
  const oppTd = mTd != null ? mTd : calculateOppDefenseAdjustment(ctx.oppPassTdAllowed, ctx.lgPassTdAllowed);
  const oppInt = mInt != null ? mInt : calculateOppDefenseAdjustment(ctx.oppDefTakeaways, ctx.lgDefTakeaways, 0.8, 1.25);
  const avail = calculateInjuryAvailability(ctx.injuryStatus);
  const rest = calculateRestAdjustment(ctx);
  const env = teamEnv(ctx, V4.env.passAtt);
  const passAtt = base.passAtt * gs * rest * avail * env;
  const passCmp = passAtt * base.compPct * oppCmp;
  const passYds = passCmp * base.ypc * wx * oppYpc * teamEnv(ctx, V4.env.passYpc);
  const passTd = passAtt * base.passTdRate * oppTd * teamEnv(ctx, V4.env.passTdRate);
  const ints = passAtt * base.intRate * oppInt * clamp(2 - wx, 0.95, 1.15) * teamEnv(ctx, V4.env.intRate); // bad weather -> more picks
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
  return { pOver, proj: t.mean, calc: fullCalc("Neg.Binom", `μ=${t.mean.toFixed(2)}, φ=${t.phi}`, t.mean, `${base.passAtt.toFixed(1)} att/start base (${base.starts} start${base.starts === 1 ? "" : "s"} this season)`, [["game script", gs], ["team total", env], ["weather", wx], ...(v3 ? [["opp comp% allowed", oppCmp], ["opp yds/cmp allowed", oppYpc]] : [["opp pass D", oppPass]]), ["opp pass TD", oppTd], ["opp INT rate", oppInt], ["availability", avail], ["rest", rest]]) };
}

/* ---- RB projections ---- */
export function rbBaseRates(ctx) {
  const s = ctx.season || {}; const l = ctx.recent || null;
  const R = V4.rush, C = V4.recv;
  const share = ctx.depthRank === 1 ? R.share1 : R.share2;
  const lgRushAtt = LG.teamRushAtt * share, lgTargets = C.shareRB * LG.teamPassAtt;
  const priorRushAtt = priorRate(ctx, "rushAtt", "g", lgRushAtt, R.kRush);
  const priorYpc = priorRate(ctx, "rushYds", "rushAtt", LG.rushYpc, R.kRate);
  const priorRushTdRate = priorRate(ctx, "rushTd", "rushAtt", LG.rushTdRate, V4.td.k);
  const priorTargets = priorRate(ctx, "targets", "g", lgTargets, C.kTgt);
  const priorCatchRate = priorRate(ctx, "rec", "targets", LG.catchRate + 0.05, C.kRate);
  const priorYpt = priorRate(ctx, "recYds", "targets", LG.ypt * 0.7, C.kRate);
  const rushAttRaw = blendRate(s.rushAtt && s.g ? s.rushAtt / s.g : priorRushAtt, l && l.games >= R.minL4 ? l.rushAtt / l.games : null, R.rw);
  const rushAtt = shrinkValue(rushAttRaw, s.g || 0, priorRushAtt, R.kRush);
  const ypc = shrinkRate(s.rushAtt ? s.rushYds / s.rushAtt : 0, s.rushAtt || 0, priorYpc, R.kRate);
  const rushTdRate = shrinkRate(s.rushAtt ? s.rushTd / s.rushAtt : 0, s.rushAtt || 0, priorRushTdRate, V4.td.k);
  const targetsRaw = blendRate(s.targets && s.g ? s.targets / s.g : priorTargets, l && l.games >= C.minL4 ? l.targets / l.games : null, C.rw);
  const targets = shrinkValue(targetsRaw, s.g || 0, priorTargets, C.kTgt);
  const catchRate = shrinkRate(s.targets ? s.rec / s.targets : 0, s.targets || 0, priorCatchRate, C.kRate); // RBs catch a slightly higher % of (shorter) targets
  const ypt = shrinkRate(s.targets ? s.recYds / s.targets : 0, s.targets || 0, priorYpt, C.kRate); // RB targets are shorter-developing than WR targets
  return { rushAtt, ypc, rushTdRate, targets, catchRate, ypt };
}
export function projectRB(ctx, type, line) {
  const base = rbBaseRates(ctx);
  const gsRush = gameScriptRushMult(ctx.teamSpread);
  const gsPass = gameScriptPassMult(ctx.teamSpread); // RB receiving work rides the team's pass-volume game script
  const wxRush = calculateWeatherAdjustmentRush(ctx);
  const wxPass = calculateWeatherAdjustmentPass(ctx);
  // v3: what the opposing defense allows to RBs specifically: yards and TDs per RB carry, catch
  // rate, yards and TDs per RB target (matchups.ts). v2's team-wide per-game numbers are the fallback.
  const mYpc = mxMult(ctx, "def", "rbYpc", 0.85, 1.18);
  const mRushTd = mxMult(ctx, "def", "rbRushTdRate", 0.70, 1.40);
  const mCatch = mxMult(ctx, "def", "rbCatch", 0.92, 1.08);
  const mYpt = mxMult(ctx, "def", "rbYpt", 0.80, 1.25);
  const oppRun = mYpc != null ? mYpc : clamp(calculateOppDefenseAdjustment(ctx.oppRushYdsAllowed, ctx.lgRushYdsAllowed), 0.8, 1.25);
  const oppRunTd = mRushTd != null ? mRushTd : clamp(calculateOppDefenseAdjustment(ctx.oppRushTdAllowed, ctx.lgRushTdAllowed), 0.75, 1.35);
  const oppCatch = mCatch != null ? mCatch : 1;
  const oppPass = mYpt != null ? mYpt : calculateOppDefenseAdjustment(ctx.oppPassYdsAllowedToRB, ctx.lgPassYdsAllowedToRB);
  const avail = calculateInjuryAvailability(ctx.injuryStatus);
  const rest = calculateRestAdjustment(ctx);
  const rushAtt = base.rushAtt * gsRush * wxRush * rest * avail * (ctx.touchShareMult || 1);
  const rushYds = rushAtt * base.ypc * oppRun;
  const rushTd = rushAtt * base.rushTdRate * oppRunTd * (ctx.depthRank === 1 ? V4.td.gl1 : V4.td.gl2) * teamEnv(ctx, V4.env.rushTd); // v4: goal-line share by depth (v3: ctx 1.15 / 0.7)
  const targets = base.targets * gsPass * rest * avail * teamEnv(ctx, V4.env.targets);
  const rec = targets * base.catchRate * oppCatch;
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
  return { pOver, proj: t.mean, calc: fullCalc("Neg.Binom", `μ=${t.mean.toFixed(2)}, φ=${t.phi}`, t.mean, `${base.rushAtt.toFixed(1)} car/g season base`, [["game script", gsRush], ["weather", wxRush], ["opp run D", oppRun], ["opp rush TD", oppRunTd], ["opp catch% vs RB", oppCatch], ["opp yds/tgt vs RB", oppPass], ["touch share", ctx.touchShareMult || 1], ["availability", avail]]) };
}

/* ---- WR/TE projections ---- */
export function wrBaseRates(ctx) {
  const s = ctx.season || {}; const l = ctx.recent || null; const C = V4.recv;
  // (an RB reaches here only for Anytime TD's receiving part; v3 and the v4 fit use the WR shares by depth for it)
  const shareDefault = ctx.pos === "TE" ? C.shareTE : (ctx.depthRank === 1 ? C.shareWR1 : ctx.depthRank === 2 ? C.shareWR2 : C.shareWR3);
  const lgTargets = LG.teamPassAtt * shareDefault;
  const priorTargets = priorRate(ctx, "targets", "g", lgTargets, C.kTgt);
  const priorCatchRate = priorRate(ctx, "rec", "targets", LG.catchRate, C.kRate);
  const priorYpt = priorRate(ctx, "recYds", "targets", LG.ypt, C.kRate);
  const priorRecTdRate = priorRate(ctx, "recTd", "targets", LG.recTdRate, V4.td.k);
  const targetsRaw = blendRate(s.targets && s.g ? s.targets / s.g : priorTargets, l && l.games >= C.minL4 ? l.targets / l.games : null, C.rw);
  const targets = shrinkValue(targetsRaw, s.g || 0, priorTargets, C.kTgt);
  const catchRate = shrinkRate(s.targets ? s.rec / s.targets : 0, s.targets || 0, priorCatchRate, C.kRate);
  const ypt = shrinkRate(s.targets ? s.recYds / s.targets : 0, s.targets || 0, priorYpt, C.kRate);
  const recTdRate = shrinkRate(s.targets ? s.recTd / s.targets : 0, s.targets || 0, priorRecTdRate, V4.td.k);
  return { targets, catchRate, ypt, recTdRate };
}
export function projectWR(ctx, type, line) {
  const base = wrBaseRates(ctx);
  const gs = gameScriptPassMult(ctx.teamSpread);
  const wx = calculateWeatherAdjustmentPass(ctx);
  // v3: what the opposing defense allows to this position group (WR or TE separately): catch rate,
  // yards per target, receiving TDs per target (matchups.ts). v2's team-wide number is the fallback.
  const grp = ctx.pos === "TE" ? "te" : ctx.pos === "RB" ? "rb" : "wr"; // RB: Anytime TD prices RB receiving TDs here
  const mCatch = mxMult(ctx, "def", `${grp}Catch`, 0.92, 1.08);
  const mYpt = mxMult(ctx, "def", `${grp}Ypt`, 0.80, 1.25);
  const mTd = mxMult(ctx, "def", `${grp}RecTdRate`, 0.70, 1.40);
  const oppCatch = mCatch != null ? mCatch : 1;
  const oppYds = mYpt != null ? mYpt : calculateOppDefenseAdjustment(ctx.oppPassYdsAllowedToPos, ctx.lgPassYdsAllowedToPos);
  const oppTd = mTd != null ? mTd : calculateOppDefenseAdjustment(ctx.oppPassTdAllowedToPos, ctx.lgPassTdAllowedToPos);
  const avail = calculateInjuryAvailability(ctx.injuryStatus);
  const rest = calculateRestAdjustment(ctx);
  const targets = base.targets * gs * rest * avail * (ctx.injuredTeammateBoost || 1) * teamEnv(ctx, V4.env.targets); // a hurt WR1 bumps WR2/3 target share
  const rec = targets * base.catchRate * oppCatch;
  const recYds = targets * base.ypt * wx * oppYds;
  const recTd = targets * base.recTdRate * oppTd * (ctx.redZoneShareMult || 1) * teamEnv(ctx, V4.env.recTdRate);
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
  return { pOver, proj: t.mean, calc: fullCalc("Neg.Binom", `μ=${t.mean.toFixed(2)}, φ=${t.phi}`, t.mean, `${base.targets.toFixed(1)} tgt/g season base`, [["game script", gs], ["weather", wx], ["opp catch% vs pos", oppCatch], ["opp yds/tgt vs pos", oppYds], ["opp rec TD vs pos", oppTd], ["availability", avail], ["target-share boost", ctx.injuredTeammateBoost || 1]]) };
}

// -------- Anytime TD: union of a player's rushing-TD and receiving-TD probability --------
// P(>=1 TD) = 1 - P(0 rush TD) x P(0 rec TD), each from that player's own NB(mean,phi) above.
// v2: QBs previously got a hardcoded 0 rushing-TD mean (so every QB anytime-TD under looked like an
// edge) AND a fake receiving-TD mean from WR target priors. A QB scores an anytime TD only by rushing
// (passing TDs credit the receiver), so QBs now use their own rush-TD/game rate, shrunk toward their
// prior season (or a 0.12/g league prior), and get no receiving component.
export const QB_RUSH_TD_PRIOR_PER_G = V4.td.qbRushPrior; // v4: 0.20 (v3 0.12)
export function qbRushTdMean(ctx) {
  const s = ctx.season || {};
  const prior = priorRate(ctx, "rushTd", "g", QB_RUSH_TD_PRIOR_PER_G, V4.td.kQb);
  const obs = s.g ? (s.rushTd || 0) / s.g : prior;
  return shrinkValue(obs, s.g || 0, prior, V4.td.kQb) * calculateInjuryAvailability(ctx.injuryStatus) * teamEnv(ctx, V4.env.qbRushTd);
}
export function projectAnytimeTD(ctx) {
  let pNoRush = 1, pNoRec = 1, pNoPass = 1;
  if (ctx.pos === "RB" || ctx.pos === "QB") { const r = ctx.pos === "QB" ? { proj: qbRushTdMean(ctx) } : projectRB(ctx, "Rush TDs", -1); pNoRush = 1 - negativeBinomialCDFComplement(r.proj, NB_PHI.rushTd); }
  if (ctx.pos !== "K" && ctx.pos !== "DST" && ctx.pos !== "QB") { const r = projectWR(ctx, "Receiving TDs", -1); pNoRec = 1 - negativeBinomialCDFComplement(r.proj, NB_PHI.recTd); }
  const pAtLeastOne = 1 - pNoRush * pNoRec * pNoPass;
  return clamp(pAtLeastOne, 0.001, 0.98);
}
export function negativeBinomialCDFComplement(mean, phi) { return mean ? (1 - negativeBinomialPMF(0, mean, phi)) : 0; } // P(>=1) shortcut

/* ---- Kicker projections ---- */
export function projectKicker(ctx, type, line) {
  const impliedTeamPts = ctx.impliedTeamPts != null ? ctx.impliedTeamPts : LG_PPG;
  const rzTdRate = ctx.redZoneTdRate != null ? ctx.redZoneTdRate : 0.58; // share of red-zone trips that end in a TD (not a FG)
  const wxK = calculateWeatherAdjustmentKicking(ctx);
  const drives = ctx.teamDrivesPerGame || 10.8;
  const fgAtt = drives * V4.k.fgPerDrive * (1 + (0.58 - rzTdRate)) * wxK; // fewer RZ TDs -> more FG tries, all else equal
  const fgMakePct = clamp(V4.k.fgPct * wxK, 0.65, 0.95);
  const fgMade = fgAtt * fgMakePct;
  const xpMade = clamp(impliedTeamPts / 7 * (1 - (1 - rzTdRate) * 0.3) * V4.k.xpScale, 0, 5); // rough TD-count proxy for extra points
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
export function projectDST(ctx, type, line) {
  const oppPassAtt = ctx.oppPassAtt != null ? ctx.oppPassAtt : LG.teamPassAtt;
  const sackRate = ctx.teamSackRate != null ? ctx.teamSackRate : LG.sackRatePerPassAtt;
  const intRate = ctx.teamDefIntRate != null ? ctx.teamDefIntRate : LG.defIntRatePerPassAtt;
  // v3: the opposing offense's sacks per dropback and INTs per attempt (matchups.ts); v2 fallback
  const mSack = mxMult(ctx, "off", "sackRate", 0.75, 1.30);
  const mInt = mxMult(ctx, "off", "offIntRate", 0.75, 1.30);
  const oppOlineMult = mSack != null ? mSack : clamp(ctx.oppSackRateAllowed && ctx.lgSackRateAllowed ? ctx.oppSackRateAllowed / ctx.lgSackRateAllowed : 1, 0.75, 1.3);
  const oppQbIntMult = mInt != null ? mInt : clamp(ctx.oppQbIntRate && ctx.lgQbIntRate ? ctx.oppQbIntRate / ctx.lgQbIntRate : 1, 0.75, 1.3);
  const sacks = oppPassAtt * sackRate * oppOlineMult;
  const ints = oppPassAtt * intRate * oppQbIntMult;
  const table = { "Sacks": { mean: sacks, phi: NB_PHI.sacks }, "Def. Interceptions": { mean: ints, phi: NB_PHI.defInt } };
  const t = table[type]; if (!t) return { pOver: null, proj: null, calc: null };
  const seed = hashSeed(`dst|${type}|${line}|${sacks.toFixed(2)}`);
  const pOver = probabilityOver("nb", line, "over", seed, t);
  return { pOver, proj: t.mean, calc: fullCalc("Neg.Binom", `μ=${t.mean.toFixed(2)}, φ=${t.phi}`, t.mean, `opp ${oppPassAtt.toFixed(1)} pass att/g`, [["opp O-line (sack allowed)", oppOlineMult], ["opp QB INT rate", oppQbIntMult]]) };
}

/* ---- dispatch: route a (position, propType) pair to its projector ---- */
export function projectProp(ctx, type, line) {
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
export function fullCalc(dist, params, proj, baseStr, mults) { return { dist, params, proj, baseStr, mults, live: null }; }
export function liveCalc(dist, params, current, projFinal, baseStr, fr) { return { dist, params, proj: projFinal, baseStr, mults: [], live: { current, fr } }; }

/* full evaluation of a single priced bet (model + market) — verbatim from MLB */
// v2 role-check gate (NFL analog of MLB's Outs sanity cap). When the projection and the posted
// line disagree by BOTH a large ratio and a large absolute amount, the usual cause is a role the
// model can't see (backup QB thrust into a start, a returning starter, a demoted RB) — e.g. a
// 70-yd projection vs a 201.5 line priced as a 72% under. Those rows keep their raw numbers for
// research but get edge suppressed to the market, and are flagged in the UI.
export const ROLE_CHECK_ABS = { "Pass Yards": 60, "Pass Attempts": 10, "Pass Completions": 7, "Rush Yards": 30, "Receiving Yards": 30, "Receptions": 2.5 };
export function roleCheckFailed(type, proj, line) {
  const abs = ROLE_CHECK_ABS[type];
  if (abs == null || proj == null || !(line > 0)) return false;
  const ratio = proj / line;
  return (ratio < 0.5 || ratio > 2.0) && Math.abs(proj - line) > abs;
}
export function evalBet(b, pre) {
  const { pOver, proj, calc } = pre || projectProp(b.ctx, b.type, parseFloat(b.line));
  const odds = Number(b.odds);
  const imp = isNaN(odds) ? null : impliedProb(odds);
  const twoSided = b.overOdds != null && b.underOdds != null;
  const novig = !twoSided && ONE_SIDED_GAMMA[b.type] ? oneSidedFair(imp, ONE_SIDED_GAMMA[b.type]) : (b.overOdds != null || b.underOdds != null) ? noVigProb(b.overOdds, b.underOdds, b.side) : imp;
  const bmult = isNaN(odds) ? 0 : (odds > 0 ? odds / 100 : 100 / -odds);
  // v2: a missing/invalid model probability stays missing on BOTH sides (previously 1 - null = 1,
  // i.e. a fake 100% raw under).
  if (pOver == null || !isFinite(pOver)) {
    return { modelP: null, rawModelP: null, proj, calc, imp, novig, edge: null, ev: null, b: bmult, fair: "—", devigged: b.overOdds != null && b.underOdds != null, roleCheck: false };
  }
  const rawP = b.side === "over" ? pOver : 1 - pOver;
  const fairRef = novig != null ? novig : imp;
  const roleCheck = roleCheckFailed(b.type, proj, parseFloat(b.line));
  const modelP = roleCheck && fairRef != null ? fairRef : calibrateToMarket(rawP, fairRef, b.type);
  const edge = (modelP != null && fairRef != null) ? modelP - fairRef : null;
  const ev = (modelP != null && !isNaN(odds)) ? evPerUnit(modelP, odds) : null;
  return { modelP, rawModelP: rawP, proj, calc, imp, novig, edge, ev, b: bmult, fair: modelP != null ? probToAmerican(modelP) : "—", devigged: b.overOdds != null && b.underOdds != null, roleCheck };
}

