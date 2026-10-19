import { LG_BARREL, LG_BBPCT, LG_FB, LG_FIP, LG_HARDHIT, LG_KPCT, LG_KRATE, LG_PITCHER_BARREL_ALLOWED, LG_PITCHER_HARDHIT_ALLOWED, LG_PITCHER_HR9, LG_PITCHER_XWOBA_ALLOWED, LG_PULL_FB, LG_RPG, LG_XBA, LG_XWOBA, STARTER_SHARE, STATCAST_MIN_BBE, STATCAST_SEASON_MIN_BBE_HITTER, STATCAST_SEASON_MIN_BBE_PITCHER } from "./config";
import { RNG, binCdf, clamp, evPerUnit, hashSeed, impliedProb, negativeBinomialPMF, noVigProb, poiCdf, probToAmerican, runMonteCarlo, sampleGamma, sampleNegBin, withSeededRng } from "../../core/math";


/* ---------- engine constants (tunable) ---------- */
export const RECENT_WEIGHT = 0.20;
export const RECENT_MULT_STRENGTH = 0.0;          // extra hot/cold mult (off; recency already in blend)
export const MIN_L15_AB = 20;                     // require this many recent AB before blending L15
export const LINEUP_PA_MULT = [1.10, 1.08, 1.05, 1.03, 1.00, 0.97, 0.95, 0.92, 0.90];
export const NB_PHI = { tb: 3.0, hrr: 2.0, k: 1.1, outs: 1.50 };
// tb: 3.0 calibrated to Aug data (actual var/mean=2.13, N=575 at line=1.5). NB(mean,phi=3) gives P(>=2)=0.345 vs actual 0.336.
//     Note: tb phi is now USED (switched from per-AB sim to NB for the P calculation).
// hrr: raised 1.85→2.0 to match actual Aug var/mean=2.0 (N=748). Slightly narrows overconfident high-end tails.
// k: lowered 1.5→1.1 because actual K var/mean=0.97 (near-Poisson). Wider NB was inflating P(over) when line>mean.
// outs: kept 1.50 as reference but Outs now uses Poisson family (actual phi=0.71, Poisson is better approximation).
// GAME_FACTOR_K: shape parameter for per-trial game-level offensive factor in the per-AB MC.
// All ABs in a single simulated game share one Gamma(k, 1/k) draw (mean=1, CV=1/√k).
// k=8 → CV≈35%: too aggressive — inflates P(0 hits) in ~8% of trials when gf<0.30.
// k=20 → CV≈22%: tighter, still models intra-game correlation without creating structural under bias.
export const GAME_FACTOR_K = 20;
export const RUNS_PHI = 2.0; // team runs/game overdispersion (variance ≈ RUNS_PHI × mean); used by game-line NB distribution
// early-sample shrinkage of hitter per-AB rates toward league priors
export const SHRINK_ENABLED = true;
export const LG_PRIOR = { hPerAB: 0.245, hrPerAB: 0.033, tbPerAB: 0.400, hrrG: 1.70 }; // rough MLB rates (hrrG = avg H+R+RBI/game)
export const SHRINK_AB = { h: 100, hr: 250, tb: 150 };                     // regression strength (AB)
export const SPOT_AB = [4.5, 4.4, 4.3, 4.2, 4.1, 4.0, 3.9, 3.8, 3.7];      // expected AB/game by lineup spot (starter)
export const HRR_SHRINK_G = 10;   // games of league-avg prior mixed into H+R+RBI/game (thin-sample fallback)
export const AB_SHRINK_G = 8;     // games of spot-AB prior mixed into AB/game
// OFFENSIVE CALIBRATION: tracked bets on 6/19 showed the model under-projects hitting
// by ~10% (actual/proj ≈ 1.10 across Hits/TB/H+R+RBI), which made nearly every UNDER a
// losing bet. This multiplier corrects the location bias. It is a calibration knob:
// retune across days toward the value that makes over and under win% both sit near break-even.
export const OFF_CALIB = 1.0; // offensive calibration. Was 1.07 (fit to a tiny early sample); 450+ settled bets showed overs at 41% / unders 57%, i.e. offense was over-projected. Back to neutral.
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
export const CALIB_KEEP = { "Hits": 0.30, "Total Bases": 0.45, "Home Run": 0.30, "H+R+RBI": 0.35, "Strikeouts": 0.55, "Outs": 0.55, "Run Line": 0.50 };
// 8/20 recalibration: raised hitter prop weights now that distributions are fixed (NB phi, Poisson Outs, K soft cap).
// K/Outs reduced slightly — model was already high-trust and we just patched known biases; slightly more market weight warranted.
// Prior sessions reduced these toward 0.10 as a band-aid. The real fixes are:
//   Hits/TB/HR: game-level correlated Gamma factor in simBatterGame (breaks false i.i.d. AB assumption).
//   H+R+RBI: NB_PHI.hrr → 3.0 (variance=3×mean, genuinely wider than original 1.85);
//             mean reverted to single formula (decomposed version inflated projections for good hitters).
export const CALIB_KEEP_DEFAULT = 0.6; // moneyline / total and any uncategorized market
export function keepFor(type) { return (type != null && CALIB_KEEP[type] != null) ? CALIB_KEEP[type] : CALIB_KEEP_DEFAULT; }
// K projection calibration: Sep 2-7 data (N=220): bias=-0.485 (model underprojects vs actual by 0.485 Ks).
// Prior 10% deflation (0.90) overcorrected past zero — model was already underestimating.
// Removing deflation (1.00). K_SOFT_CAP compression stays to handle elite-starter IP limits.
// K_SOFT_CAP / K_SOFT_COMPRESS: elite K starters (K/9>11) burn more pitches per inning → shorter actual IP.
export const K_PROJ_CALIB = 1.00;
export const K_SOFT_CAP = 5.5;       // K projections above this regress toward the cap
export const K_SOFT_COMPRESS = 0.50; // 50% of excess above cap is kept (e.g., 7.80 → 5.5 + 1.15 = 6.65)
// Outs mean calibration: Sep 2-7 data (N=92): bias=-0.476 (model underprojects vs actual; mean proj=15.15, actual=15.63).
// Prior deflation (0.963) was based on Aug data showing overestimation — reversed sign in Sep. Flipped to 1.032.
// Actual Outs var/mean=0.71 (sub-Poisson; Poisson family retained).
export const OUTS_PROJ_CALIB = 1.032;
// Sanity cap: if |proj_outs - line| > this threshold, pitcher role/IP data is stale
// (swingman evolved to starter, injury return on pitch limit, etc.). Force edge to 0.
// All extreme-edge Outs blowups in Aug data had |delta| > 3 outs. 3.5 catches these
// without aggressively suppressing legitimate moderate-delta under plays.
export const OUTS_SANITY_DELTA = 3.5;

// PLATOON: league-average production multipliers, season-relative, by batter hand -> SP throwing hand.
// A hitter's season rate already blends both hands (mostly vs RHP), so these re-weight toward the
// hand actually faced. Same-handed (esp. LHB vs LHP) is a real penalty; opposite-handed is a boost.
// If the hitter has enough of his OWN vs-L/vs-R split data, we blend his split toward this prior.
export const LG_PLATOON = { L: { L: 0.91, R: 1.035 }, R: { L: 1.045, R: 0.985 }, S: { L: 1.02, R: 1.00 } };
export const PLATOON_SHRINK_AB = 50; // split AB before a hitter's own L/R split outweighs the league prior
export function calculatePlatoonAdjustment(ctx) {
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
// calibration: blend the model toward the sharp market price, keeping keepFor(type) of the disagreement.
// This corrects overconfident favorites AND over-projected longshots (shrinking toward 0.5 would inflate longshots).
export function calibrateToMarket(p, market, type) { return (p == null || market == null) ? p : clamp(market + keepFor(type) * (p - market), 0.001, 0.999); }

// Per-team run distribution. Negative Binomial (overdispersed) rather than Poisson:
// MLB team runs/game have variance ≈ 2× the mean (big innings), so NB fits the tails of
// totals and run lines far better than Poisson. Teams modeled independently (no in-game
// run correlation) — a known simplification, but the marginal overdispersion is the big win.
export function runPmf(k, lambda) { return negativeBinomialPMF(k, Math.max(lambda, 1e-6), RUNS_PHI); }

export function gameProbs(lh, la) {
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
export function jointGameProbs(lhEff, laEff, hc, ac, totalLine) {
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
export function marginProb(lhEff, laEff, hc, ac, cmp) {
  const N = 26; let p = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    if (cmp((hc + i) - (ac + j))) p += runPmf(i, lhEff) * runPmf(j, laEff);
  }
  return p;
}

/* ============================================================
   PROJECTION ENGINE
   ============================================================ */
export const blendRate = (seasonRate, recentRate) =>
  (recentRate == null || isNaN(recentRate)) ? seasonRate : seasonRate * (1 - RECENT_WEIGHT) + recentRate * RECENT_WEIGHT;
export const parkHitMultiplier = (rf) => rf;
export const parkHRMultiplier = (rf) => Math.pow(rf, 1.25);
// empirical-Bayes shrinkage of a per-AB rate toward a league prior
export function shrinkRate(obsRate, ab, prior, kAB) {
  if (!SHRINK_ENABLED) return obsRate;
  if (!ab) return prior;                                   // no AB -> league prior (not zero)
  return (obsRate * ab + prior * kAB) / (ab + kAB);
}
// generic shrinkage of an observed value toward a prior, weighted by sample count
export function shrinkValue(obs, count, prior, k) {
  const o = isFinite(obs) ? obs : prior;
  return (o * (count || 0) + prior * k) / ((count || 0) + k);
}

export function calculateBaseProjection(ctx) {
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
export function calculateMatchupAdjustment(ctx) {
  const b = ctx.bvp, s = ctx.season;
  if (!b || !s || (b.ab || 0) < 20 || !s.ab) return 1;
  const bvpAvg = b.h / b.ab, seasonAvg = s.h / s.ab;
  if (!seasonAvg) return 1;
  // BvP is mostly noise in modern research; keep only a light touch (was 0.5, reduced ~60%). Caps retained.
  return clamp(1 + (bvpAvg / seasonAvg - 1) * 0.2, 0.92, 1.08);
}
export function calculateParkAdjustment(ctx, type) {
  const rf = ctx.park ? ctx.park.rf : 1;
  if (ctx.kind === "pitcher") return 1;
  return type === "Home Run" ? parkHRMultiplier(rf) : parkHitMultiplier(rf);
}
export function calculateWeatherAdjustment(ctx) {
  const w = ctx.weather;
  if (!w || (ctx.park && ctx.park.dome)) return 1;
  let m = 1;
  if (w.temp != null) { if (w.temp >= 85) m += 0.03; else if (w.temp <= 60) m -= 0.03; }
  if (w.wind != null && w.wind >= 12) m += 0.02;
  if (w.pop != null && w.pop >= 50) m -= 0.02;
  return clamp(m, 0.94, 1.06);
}
export function calculateLineupAdjustment(ctx) {
  if (ctx.kind === "pitcher") return 1;
  const i = ctx.lineupIndex;
  if (i == null || i < 0 || i > 8) return 1;
  return LINEUP_PA_MULT[i];
}
export function calculateRecentFormAdjustment(ctx) {
  if (RECENT_MULT_STRENGTH <= 0) return 1;
  const l = ctx.l15, s = ctx.season;
  if (!l || !s || !s.ab || !l.ab) return 1;
  const seasonProxy = (s.h / s.ab) + (s.tb / s.ab);
  if (!seasonProxy || l.ops == null) return 1;
  return clamp(1 + (l.ops - seasonProxy) * RECENT_MULT_STRENGTH, 0.95, 1.05);
}
export function calculateTeamRunAdjustment(ctx) {
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
export function calculateOppPitchingAdjustment(ctx) {
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
export function calculateStatcastAdjustment(ctx) {
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

export function pitcherStatcastRunAdjustment(sp) {
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
export function pitcherStatcastKAdjustment(ctx) {
  const sc = ctx && ctx.statcastSeason;
  if (!sc || sc.verdict !== "season_confirmed" || !sc.pitches || sc.pitches < 250) return 1;
  const w = clamp(sc.pitches / 1200, 0.25, 1);
  let m = 1;
  if (sc.whiffRate != null) m *= clamp(1 + (sc.whiffRate - 0.115) * 0.35 * w, 0.92, 1.10);
  if (sc.cswRate != null) m *= clamp(1 + (sc.cswRate - 0.285) * 0.25 * w, 0.94, 1.08);
  return clamp(m, 0.90, 1.12);
}
export function pitcherStatcastOutsAdjustment(ctx) {
  const sc = ctx && ctx.statcastSeason;
  if (!sc || sc.verdict !== "season_confirmed" || (sc.bbe || 0) < STATCAST_SEASON_MIN_BBE_PITCHER) return 1;
  const runPenalty = pitcherStatcastRunAdjustment({ statcastSeason: sc });
  // Strong contact allowed shortens leash and raises blow-up risk; weak contact helps pitchers work deeper.
  return clamp(1 - (runPenalty - 1) * 0.18, 0.96, 1.04);
}
export function applyStatcastToGameLambda(lambda, oppSP) { return clamp(lambda * pitcherStatcastRunAdjustment(oppSP), 2.0, 8.5); }


/* ---------------- live layer ---------------- */
export function gameFractionRemaining(inning, inningState, outs) {
  if (!inning) return 1;
  const st = (inningState || "").toLowerCase();
  const topHalf = st.startsWith("top") || st.startsWith("mid");
  const outsCompleted = (inning - 1) * 6 + (topHalf ? 0 : 3) + (outs || 0);
  return clamp(1 - outsCompleted / 54, 0.02, 1);
}
export function getCurrentStatTotal(totals, key) { return totals && totals[key] != null ? totals[key] : 0; }
export function ipToOuts(ipStr) { if (ipStr == null) return 0; const f = parseFloat(ipStr); if (isNaN(f)) return 0; const w = Math.floor(f); return w * 3 + Math.round((f - w) * 10); }
export function probabilityOver(family, line, side, seed, params) {
  let over;
  if (family === "binom") over = 1 - binCdf(Math.floor(line), params.n, params.p);
  else if (family === "poisson") over = 1 - poiCdf(Math.floor(line), params.mean);
  else over = runMonteCarlo(() => sampleNegBin(params.mean, params.phi), line, "over", seed);
  return side === "over" ? over : 1 - over;
}
export function liveProbabilityOver(family, seed, params, currentTotal, line) {
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
export const BATTER_SIM_N = 15000;
export function batterPerAB(ctx) {
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
export function simBatterGame(r) {
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
export function simBatterProb(rates, statKey, line, side, seed, currentTotal, fr, N = BATTER_SIM_N) {
  return withSeededRng(seed, () => {
    const r = { ...rates, expAB: rates.expAB * (fr == null ? 1 : fr) };
    let over = 0;
    for (let i = 0; i < N; i++) {
      const g = simBatterGame(r);
      const v = (currentTotal || 0) + (statKey === "hits" ? g.hits : statKey === "tb" ? g.tb : g.hr);
      if (v > line) over++;
    }
    const pOver = over / N;
    return side === "over" ? pOver : 1 - pOver;
  });
}


export function projectProp(ctx, type, line) {
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
export function fullCalc(dist, params, proj, baseStr, mults) { return { dist, params, proj, baseStr, mults, live: null }; }
export function liveCalc(dist, params, current, projFinal, baseStr, fr) { return { dist, params, proj: projFinal, baseStr, mults: [], live: { current, fr } }; }

/* full evaluation of a single priced bet (model + market). */
export function evalBet(b, pre) {
  const { pOver, proj, calc } = pre || projectProp(b.ctx, b.type, parseFloat(b.line));
  // a missing/invalid model probability stays missing on BOTH sides (was 1 - null = 1: a fake 100% under)
  if (pOver == null || !isFinite(pOver)) return { modelP: null, rawModelP: null, proj, calc, imp: null, novig: null, edge: null, ev: null, b: 0, fair: "—", devigged: false, outsSanityFailed: false };
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
