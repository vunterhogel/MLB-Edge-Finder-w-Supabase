/* NBA projection engine (moved verbatim from the old NBAApp.tsx; shared math now comes from core/math).
   Methodology: NBA_PROJECTION_MODELS.md. */
import { clamp, evPerUnit, gaussian, hashSeed, impliedProb, negativeBinomialPMF, noVigProb, poiCdf, probToAmerican, runMonteCarlo, sampleNegBin, withSeededRng } from "../../core/math";
import { LG_PACE, NBA_PTS_PHI } from "./config";

export function probabilityOver(family, line, side, seed, params) {
  let over;
  if (family === "poisson") over = 1 - poiCdf(Math.floor(line), params.mean);
  else over = runMonteCarlo(() => sampleNegBin(params.mean, params.phi), line, "over", seed);
  return side === "over" ? over : 1 - over;
}


// per-market calibration: DAY-1 PRIOR. No settled-bet history for basketball yet, so every
// category starts at a conservative, uniform "trust the market a lot" weight — same posture
// NFL launched with. Retune per-category from the Stats tab; don't hand-tune from vibes.
export const MODEL_VERSION = "nba-v3-2026-10-27";   // bump on every model change (part of every board-log id). v3: opponent defense by position + real pace (matchups.ts)

export const CALIB_KEEP = {
  "Points": 0.45, "Rebounds": 0.45, "Assists": 0.45, "Three-Pointers Made": 0.40, "Steals": 0.35, "Blocks": 0.35, "Turnovers": 0.35,
  "Pts+Reb+Ast": 0.45, "Pts+Reb": 0.45, "Pts+Ast": 0.45, "Reb+Ast": 0.40, "Blocks+Steals": 0.35,
  "Double-Double": 0.35, "Triple-Double": 0.30, "Spread": 0.50, "Total": 0.50,
};
export const CALIB_KEEP_DEFAULT = 0.5;
export function keepFor(type) { return (type != null && CALIB_KEEP[type] != null) ? CALIB_KEEP[type] : CALIB_KEEP_DEFAULT; }
export function calibrateToMarket(p, market, type) { return (p == null || market == null) ? p : clamp(market + keepFor(type) * (p - market), 0.001, 0.999); }

/* ============================================================
   TEAM SCORING MODEL — game lines (Moneyline / Spread / Total)
   Doc §2. Two-team Negative Binomial grid, same shape as MLB's
   run grid / NFL's points grid, tuned for NBA: bigger grid (NBA
   teams routinely score 90-140), much lower relative overdispersion
   (NBA_PTS_PHI=1.3 vs NFL's 6.5), and a shared pace multiplier
   applied once to BOTH teams rather than per-team.
   ============================================================ */
export function teamPtsPmf(k, lambda) { return negativeBinomialPMF(k, Math.max(lambda, 1e-6), NBA_PTS_PHI); }
export function gameProbs(lh, la) {
  const N = 180; let pH = 0, pA = 0, pT = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const pr = teamPtsPmf(i, lh) * teamPtsPmf(j, la);
    if (i > j) pH += pr; else if (j > i) pA += pr; else pT += pr;
  }
  return { home: pH + pT / 2, away: pA + pT / 2, tie: pT, totalLambda: lh + la };   // tied after 48 -> OT, ~50/50
}
export function jointGameProbs(lhEff, laEff, hc, ac, totalLine) {
  const N = 180; let pH = 0, pA = 0, pT = 0, over = 0, under = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const pr = teamPtsPmf(i, lhEff) * teamPtsPmf(j, laEff);
    const hs = hc + i, as = ac + j;
    if (hs > as) pH += pr; else if (as > hs) pA += pr; else pT += pr;
    if (totalLine != null) { const tot = hs + as; if (tot > totalLine) over += pr; else if (tot < totalLine) under += pr; }
  }
  return { home: pH + pT / 2, away: pA + pT / 2, tie: pT, over, under };
}
export function marginProb(lhEff, laEff, hc, ac, cmp) {
  const N = 180; let p = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    if (cmp((hc + i) - (ac + j))) p += teamPtsPmf(i, lhEff) * teamPtsPmf(j, laEff);
  }
  return p;
}

/* ============================================================
   SHRINKAGE HELPERS (verbatim from MLB/NFL — sport-agnostic)
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

/* ============================================================
   PROJECTION ENGINE — unified per-player model (doc §3)
   ============================================================ */
export const RECENT_WEIGHT = 0.35;       // L10-game blend weight
export const MIN_L10_GAMES = 3;          // require >=3 recent games before blending recent form in
export const SHRINK_N = { minutes: 5, rate: 150 }; // "games" / "minutes" of prior weight
export const NB_PHI = {                  // dispersion priors (var/mean) — DAY-1, retune from settled data
  pts: 1.8, reb: 1.5, ast: 1.6, fg3m: 1.7, stl: 1.6, blk: 1.6, tov: 1.4, combo: 2.6,
};
// position-group league priors (per-36, plus a minutes-per-game prior) — exist ONLY to
// stabilize thin samples (rookie's first few games, a two-way call-up); once a player has
// real minutes, his own rate dominates via shrinkRate's sample-size weighting.
export const POS_PRIOR = {
  G: { mpg: 26, pts36: 16.5, reb36: 3.8, ast36: 5.2, stl36: 1.3, blk36: 0.3, tov36: 2.3, fg3m36: 2.4 },
  F: { mpg: 27, pts36: 16.0, reb36: 6.5, ast36: 3.0, stl36: 1.0, blk36: 0.6, tov36: 2.0, fg3m36: 1.6 },
  C: { mpg: 25, pts36: 15.5, reb36: 9.5, ast36: 2.2, stl36: 0.8, blk36: 1.4, tov36: 1.9, fg3m36: 0.6 },
};
export function posGroup(pos) {
  const p = String(pos || "").toUpperCase();
  if (p === "C") return "C";
  if (p === "PF" || p === "SF" || p === "F") return "F";
  return "G"; // PG, SG, G, or unknown default
}

/* -------- pace adjustment (doc §4, NEW vs NFL/MLB) --------
   Applied ONCE per game to both teams' counting stats — a fast-pace matchup
   inflates points/rebounds/assists for everyone on the floor, not just one side. */
export function calculatePaceAdjustment(teamPace, oppPace, lgPace) {
  const tp = teamPace || lgPace || LG_PACE, op = oppPace || lgPace || LG_PACE, lg = lgPace || LG_PACE;
  return clamp(((tp + op) / 2) / lg, 0.85, 1.18);
}

/* -------- opponent defense adjustment (doc §4) --------
   Points uses a real opponent-DRTG signal; other categories are neutral (1.0×) in v1 —
   see NBA_PROJECTION_MODELS.md §7 "known v1 simplifications", same honest scope cut NFL
   made for its opponent-allowed-by-position splits. */
export function calculateOppDefenseAdjustment(oppAllowedRate, leagueAvgRate, lo = 0.80, hi = 1.25) {
  if (!oppAllowedRate || !leagueAvgRate) return 1;
  return clamp(oppAllowedRate / leagueAvgRate, lo, hi);
}

/* -------- injury adjustment (doc §4) --------
   NBA's daily injury report: Out | Doubtful | Questionable | Day-To-Day | Probable | null. */
export function calculateInjuryAvailability(status) {
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
export function calculateUsageBoost(missingUsageShare) {
  if (!missingUsageShare) return 1;
  return clamp(1 + missingUsageShare * 0.6, 1, 1.35);
}

/* -------- rest / back-to-back adjustment (doc §4) --------
   The single biggest NBA-specific fatigue signal — no comparable-magnitude analog in NFL
   (plays once a week) or MLB (no true zero-rest scheduling quirk). */
export function calculateRestAdjustment(ctx) {
  let m = 1;
  if (ctx.backToBack) m -= 0.06;
  else if (ctx.daysRest >= 2) m += 0.02;
  return clamp(m, 0.90, 1.03);
}

/* -------- blowout-risk minutes reduction (doc §3 step 1, §4, NEW vs NFL/MLB) --------
   A team on either side of a wide model-projected spread sees its starters' 4th-quarter
   minutes cut as the game gets out of hand — a real NBA coaching pattern (garbage time)
   with no MLB/NFL equivalent. */
export function calculateBlowoutRiskAdjustment(projSpreadAbs, isStarter) {
  if (!isStarter || projSpreadAbs == null || projSpreadAbs < 10) return 1;
  const over = clamp(projSpreadAbs - 10, 0, 10); // 10..20+
  return clamp(1 - over * 0.008, 0.92, 1);
}

/* ---- unified player projection (doc §3) ---- */
export function playerBaseRates(ctx) {
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
// v3: a matchup multiplier for this player's position from ctx.mx (matchups.ts: what this opponent
// allows to the position per possession of floor time / league), clamped; null -> keep the v2 input
export function mxDef(ctx, stat, lo, hi) {
  const v = ctx && ctx.mx && ctx.mx.def ? (ctx.mx.def[posGroup(ctx.pos)] || {})[stat] : null;
  return v == null || !Number.isFinite(v) ? null : clamp(v, lo, hi);
}
export function projectPlayer(ctx, type, line) {
  const base = playerBaseRates(ctx);
  const mxPace = ctx && ctx.mx && Number.isFinite(ctx.mx.pace) ? clamp(ctx.mx.pace, 0.92, 1.08) : null;
  const pace = mxPace != null ? mxPace : calculatePaceAdjustment(ctx.teamPace, ctx.oppPace, ctx.lgPace);
  const rest = calculateRestAdjustment(ctx);
  const blowout = calculateBlowoutRiskAdjustment(ctx.projSpreadAbs, !!ctx.isStarter);
  const avail = calculateInjuryAvailability(ctx.injuryStatus);
  const usage = calculateUsageBoost(ctx.missingUsageShare);
  // v3: what this opponent allows to the player's position (G / F / C), per possession; v2 fallback
  const or = (v, fb) => (v != null ? v : fb);
  const oppPtsD = or(mxDef(ctx, "pts", 0.88, 1.12), calculateOppDefenseAdjustment(ctx.oppDRTG, ctx.lgDRTG));
  const oppReb = or(mxDef(ctx, "reb", 0.85, 1.15), calculateOppDefenseAdjustment(ctx.oppRebRateAllowed, ctx.lgRebRateAllowed));
  const oppAst = or(mxDef(ctx, "ast", 0.85, 1.15), calculateOppDefenseAdjustment(ctx.oppAstAllowed, ctx.lgAstAllowed));
  const opp3pt = or(mxDef(ctx, "fg3m", 0.80, 1.20), calculateOppDefenseAdjustment(ctx.opp3ptPctAllowed, ctx.lg3ptPctAllowed));
  const oppStl = or(mxDef(ctx, "stl", 0.75, 1.25), calculateOppDefenseAdjustment(ctx.oppTovForced, ctx.lgTovForced));
  const oppBlk = or(mxDef(ctx, "blk", 0.75, 1.25), calculateOppDefenseAdjustment(ctx.oppFgaRimAllowed, ctx.lgFgaRimAllowed));
  const oppTov = or(mxDef(ctx, "tov", 0.80, 1.20), 1);

  const minutes = base.minutes0 * rest * blowout * avail;
  const m36 = minutes / 36;
  const pts = m36 * base.pts36 * pace * oppPtsD * usage;
  const reb = m36 * base.reb36 * pace * oppReb;
  const ast = m36 * base.ast36 * pace * oppAst;
  const fg3m = m36 * base.fg3m36 * pace * opp3pt;
  const stl = m36 * base.stl36 * pace * oppStl;
  const blk = m36 * base.blk36 * pace * oppBlk;
  const tov = m36 * base.tov36 * pace * clamp(usage, 1, 1.25) * oppTov;

  const pg = posGroup(ctx.pos);
  const mults = [["pace", pace], ["rest/B2B", rest], ["blowout risk", blowout], ["availability", avail], ["usage boost", usage]];
  const baseStr = `${base.minutes0.toFixed(1)} min/g season base (${posGroup(ctx.pos)} prior)`;
  const single = {
    "Points": { mean: pts, phi: NB_PHI.pts, mults: [...mults, [`opp pts allowed vs ${pg}`, oppPtsD]] },
    "Rebounds": { mean: reb, phi: NB_PHI.reb, mults: [...mults, [`opp reb allowed vs ${pg}`, oppReb]] },
    "Assists": { mean: ast, phi: NB_PHI.ast, mults: [...mults, [`opp ast allowed vs ${pg}`, oppAst]] },
    "Three-Pointers Made": { mean: fg3m, phi: NB_PHI.fg3m, mults: [...mults, [`opp 3PM allowed vs ${pg}`, opp3pt]] },
    "Steals": { mean: stl, phi: NB_PHI.stl, mults: [...mults, [`opp steals given vs ${pg}`, oppStl]] },
    "Blocks": { mean: blk, phi: NB_PHI.blk, mults: [...mults, [`opp blocks given vs ${pg}`, oppBlk]] },
    "Turnovers": { mean: tov, phi: NB_PHI.tov, mults: [...mults, ["usage (TOs rise w/ usage)", clamp(usage, 1, 1.25)], [`opp TOs forced vs ${pg}`, oppTov]] },
  };
  // combo props: sum of means, inflated phi to approximate positive correlation across
  // stats that all scale off the same minutes/usage swings (doc §3 step 4)
  const combo = {
    "Pts+Reb+Ast": { mean: pts + reb + ast, phi: NB_PHI.combo, mults: [...mults, [`opp pts allowed vs ${pg}`, oppPtsD], [`opp reb allowed vs ${pg}`, oppReb], [`opp ast allowed vs ${pg}`, oppAst]] },
    "Pts+Reb": { mean: pts + reb, phi: NB_PHI.combo, mults: [...mults, [`opp pts allowed vs ${pg}`, oppPtsD], [`opp reb allowed vs ${pg}`, oppReb]] },
    "Pts+Ast": { mean: pts + ast, phi: NB_PHI.combo, mults: [...mults, [`opp pts allowed vs ${pg}`, oppPtsD], [`opp ast allowed vs ${pg}`, oppAst]] },
    "Reb+Ast": { mean: reb + ast, phi: NB_PHI.combo, mults: [...mults, [`opp reb allowed vs ${pg}`, oppReb], [`opp ast allowed vs ${pg}`, oppAst]] },
    "Blocks+Steals": { mean: blk + stl, phi: NB_PHI.combo, mults: [...mults, [`opp blocks given vs ${pg}`, oppBlk], [`opp steals given vs ${pg}`, oppStl]] },
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
export function simulateDoubleTriple(means, need, seed, N = 20000) {
  const s0 = (seed >>> 0) || hashSeed(`dd|${means.pts.toFixed(2)}|${means.reb.toFixed(2)}|${means.ast.toFixed(2)}`);
  return withSeededRng(s0, () => {
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
    return hits / N;
  });
}
export function fullCalc(dist, params, proj, baseStr, mults) { return { dist, params, proj, baseStr, mults, live: null }; }

/* full evaluation of a single priced bet (model + market) — verbatim from MLB/NFL */
export function evalBet(b, pre) {
  const { pOver, proj, calc } = pre || projectPlayer(b.ctx, b.type, parseFloat(b.line));
  // a missing/invalid model probability stays missing on BOTH sides (was 1 - null = 1: a fake 100% under)
  if (pOver == null || !isFinite(pOver)) return { modelP: null, rawModelP: null, proj, calc, imp: null, novig: null, edge: null, ev: null, b: 0, fair: "—", devigged: false };
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
