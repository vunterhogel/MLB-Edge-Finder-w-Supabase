/* NBA projection engine. Methodology: NBA_PROJECTION_MODELS.md (v4: role model + fitted shapes, replay-validated). */
import { clamp, evPerUnit, gaussian, hashSeed, impliedProb, negativeBinomialPMF, noVigProb, poiCdf, probToAmerican, runMonteCarlo, sampleNegBin, sampleShiftedGammaCount, withSeededRng } from "../../core/math";
import { NBA_PTS_PHI } from "./config";

export function probabilityOver(family, line, side, seed, params) {
  let over;
  if (family === "poisson") over = 1 - poiCdf(Math.floor(line), params.mean);
  else over = runMonteCarlo(() => sampleNegBin(params.mean, params.phi), line, "over", seed);
  return side === "over" ? over : 1 - over;
}


// per-market calibration: DAY-1 PRIOR. No settled-bet history for basketball yet, so every
// category starts at a conservative, uniform "trust the market a lot" weight — same posture
// NFL launched with. Retune per-category from the Stats tab; don't hand-tune from vibes.
export const MODEL_VERSION = "nba-v4-2026-10-28";   // bump on every model change (part of every board-log id). v3: opponent defense by position + real pace (matchups.ts). v4: role/minutes model, fitted spreads, points shape

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
   PLAYER PROJECTION — v4 role model (doc §3, "v4" section)
   Validated by replaying 2024-25 (tuning) and 2025-26 (held out) game by game from hoopR box scores,
   each player's inputs built only from games before that night, same as the page.
   ============================================================ */
// minutes and per-minute rates from the player's own games: this season's games count by recency (a game's
// weight halves every V4.minHalfLife games for minutes, every V4.rateHalfLife for rates), and last season's
// average is an anchor worth a fixed number of recent games, so a real role change (a young player's
// minutes growing, a veteran's shrinking) shows up within a few games instead of being held back by last
// season. A team change discounts last season (and in-season games for a former team). Players with under
// 10 games last season fall back to the season before. Fitted on 2024-25; see NBA_PROJECTION_MODELS.md.
export const V4 = {
  minHalfLife: 3,       // games
  priorMinGames: 1,     // last season's minutes average counts as this many recent games
  rateHalfLife: 100,    // games (rates are far more stable than minutes)
  priorRateGames: 10,   // last season's per-minute rates count as this many games of his minutes
  teamChange: 0.35,     // last-season (and former-team) weight after a team change
  roleMpg: { starter: 30, bench: 18 }, roleGames: 0.25, // fallback minutes by role, and its weight in games
  starterShift: 4,      // minutes: + this x (starting tonight - his recent share of starts)
  posShrinkMin: 100,    // per-minute rates shrink toward the position prior by this many minutes
  // per regular starter OUT tonight beyond how many were missing in the games his numbers came from:
  // teammates' minutes, and pts/ast/3PM/TO per minute (missBase: assumed count when a game's isn't known)
  perStarterOut: { minutes: 0.06, usage: 0.04 }, missBase: 0.5,
};
// dispersion, fitted on 2024-25 (var = phi x mean). Points and point combos use a shifted-gamma count
// (SG_SHIFT): the negative binomial at their spread is too right-skewed and priced overs ~4 points low.
export const NB_PHI = { reb: 1.45, ast: 1.25, fg3m: 1.2, stl: 1.1, blk: 1.1, tov: 1.05, "Reb+Ast": 1.7, "Blocks+Steals": 1.15 };
export const SG = { pts: { phi: 3.5, shift: 12 }, "Pts+Reb+Ast": { phi: 3.55, shift: 12 }, "Pts+Reb": { phi: 3.5, shift: 10 }, "Pts+Ast": { phi: 3.4, shift: 10 } };
const DD_PHI = { pts: 1.8, reb: 1.5, ast: 1.6, stl: 1.6, blk: 1.6 }; // double/triple-double sim (replay: already calibrated, unchanged)
// position-group league priors (per-36) — only stabilize thin samples (a rookie's first games)
export const POS_PRIOR = {
  G: { pts36: 16.5, reb36: 3.8, ast36: 5.2, stl36: 1.3, blk36: 0.3, tov36: 2.3, fg3m36: 2.4 },
  F: { pts36: 16.0, reb36: 6.5, ast36: 3.0, stl36: 1.0, blk36: 0.6, tov36: 2.0, fg3m36: 1.6 },
  C: { pts36: 15.5, reb36: 9.5, ast36: 2.2, stl36: 0.8, blk36: 1.4, tov36: 1.9, fg3m36: 0.6 },
};
export function posGroup(pos) {
  const p = String(pos || "").toUpperCase();
  if (p === "C") return "C";
  if (p === "PF" || p === "SF" || p === "F") return "F";
  return "G"; // PG, SG, G, or unknown default
}
const RATE_KEYS = ["pts", "reb", "ast", "fg3m", "stl", "blk", "tov"];
const avg = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);

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

/* ctx.hist = { cur, prior, prior2 } regular-season rows (minutes > 0), newest first: { min, pts, reb, ast,
   fg3m, stl, blk, tov, team?, starter? } (team / starter come from the hoopR box scores; null = unknown,
   treated as his current team / ignored). ctx.teamId, ctx.priorTeam, ctx.priorStartShare (hoopR, or null),
   ctx.isStarter (tonight, depth chart; null = unknown). */
export function playerRoleRates(ctx) {
  const h = ctx.hist || {}; const team = ctx.teamId != null ? Number(ctx.teamId) : null;
  const cur = h.cur || [];
  let prior = h.prior || [], priorW = 1, priorLabel = "last season", priorStart = ctx.priorStartShare;
  if (prior.length < 10 && (h.prior2 || []).length >= 10) { prior = h.prior2; priorLabel = "2 seasons ago"; priorStart = null; }
  const teamChange = priorLabel === "last season" && ctx.priorTeam != null && team != null && Number(ctx.priorTeam) !== team;
  if (teamChange) priorW *= V4.teamChange;
  if (!prior.length) { priorW = 0; priorLabel = "none"; }
  const pMpg = prior.length ? avg(prior.map((x) => x.min)) : 0;
  const tonight = ctx.isStarter == null ? null : ctx.isStarter ? 1 : 0;
  let wS = 0, mS = 0, sW = 0, sS = 0, rW = 0, rMin = 0; const st = {}; for (const k of RATE_KEYS) st[k] = 0;
  let qW = 0, qS = 0, qrW = 0, qrS = 0; // missing-starter counts behind his minutes / rates (own-team games)
  for (let i = 0; i < cur.length; i++) {
    const x = cur[i], own = x.team == null || team == null || Number(x.team) === team, tw = own ? 1 : V4.teamChange;
    if (own) { const q = x.miss != null ? x.miss : V4.missBase, a = Math.pow(0.5, i / V4.minHalfLife), b = Math.pow(0.5, i / V4.rateHalfLife); qW += a; qS += a * q; qrW += b; qrS += b * q; }
    const w = Math.pow(0.5, i / V4.minHalfLife) * tw; wS += w; mS += w * x.min;
    if (x.starter != null) { sW += w; sS += w * (x.starter ? 1 : 0); }
    const wr = Math.pow(0.5, i / V4.rateHalfLife) * tw; rW += wr; rMin += wr * x.min; for (const k of RATE_KEYS) st[k] += wr * (x[k] || 0);
  }
  const kp = V4.priorMinGames * priorW;
  const role = tonight ? V4.roleMpg.starter : V4.roleMpg.bench;
  const minutesBase = (mS + kp * pMpg + V4.roleGames * role) / (wS + kp + V4.roleGames);
  let startShare = null, shift = 0;
  if (tonight != null) {
    const kps = priorStart != null ? kp : 0;
    startShare = (sS + kps * (priorStart || 0) + V4.roleGames * tonight) / (sW + kps + V4.roleGames);
    shift = V4.starterShift * (tonight - startShare);
  }
  const minutes0 = clamp(minutesBase + shift, 4, 42);
  const pp = POS_PRIOR[posGroup(ctx.pos)];
  const kpr = V4.priorRateGames * priorW, pMin = prior.reduce((s, x) => s + x.min, 0);
  const rates = {};
  for (const k of RATE_KEYS) {
    const pr = pMin ? prior.reduce((s, x) => s + (x[k] || 0), 0) / pMin : 0;
    const den = rMin + kpr * pMpg;
    const r36 = den ? ((st[k] + pr * kpr * pMpg) / den) * 36 : pp[`${k}36`];
    const n = rMin + pMin * priorW; // minutes actually seen
    rates[`${k}36`] = (r36 * n + pp[`${k}36`] * V4.posShrinkMin) / (n + V4.posShrinkMin);
  }
  const kq = kp + V4.roleGames;
  const missMin = (qS + kq * V4.missBase) / (qW + kq), missRate = (qrS + kpr * V4.missBase) / (qrW + kpr || 1);
  return { minutes0, minutesBase, shift, startShare, missMin, missRate, curGames: cur.length, priorGames: prior.length, priorLabel, priorMpg: pMpg, teamChange, ...rates };
}

// v3: a matchup multiplier for this player's position from ctx.mx (matchups.ts: what this opponent
// allows to the position per possession of floor time / league), clamped; null -> neutral
export function mxDef(ctx, stat, lo, hi) {
  const v = ctx && ctx.mx && ctx.mx.def ? (ctx.mx.def[posGroup(ctx.pos)] || {})[stat] : null;
  return v == null || !Number.isFinite(v) ? null : clamp(v, lo, hi);
}
function probFor(t, line, seed) {
  if (t.fam === "sg") return runMonteCarlo(() => sampleShiftedGammaCount(t.mean, t.phi, t.shift), line, "over", seed);
  return probabilityOver("nb", line, "over", seed, t);
}
// the projected mean of every stat (and the pieces behind it) for one player tonight
export function playerMeans(ctx) {
  const base = playerRoleRates(ctx);
  const pace = ctx && ctx.mx && Number.isFinite(ctx.mx.pace) ? clamp(ctx.mx.pace, 0.92, 1.08) : 1;
  const avail = calculateInjuryAvailability(ctx.injuryStatus);
  const out = ctx.startersOut || 0;
  const minBoost = Math.max(0.5, 1 + V4.perStarterOut.minutes * (out - base.missMin)), usage = Math.max(0.5, 1 + V4.perStarterOut.usage * (out - base.missRate));
  const or = (v) => (v != null ? v : 1);
  const opp = { pts: or(mxDef(ctx, "pts", 0.88, 1.12)), reb: or(mxDef(ctx, "reb", 0.85, 1.15)), ast: or(mxDef(ctx, "ast", 0.85, 1.15)),
    fg3m: or(mxDef(ctx, "fg3m", 0.80, 1.20)), stl: or(mxDef(ctx, "stl", 0.75, 1.25)), blk: or(mxDef(ctx, "blk", 0.75, 1.25)), tov: or(mxDef(ctx, "tov", 0.80, 1.20)) };
  const minutes = base.minutes0 * avail * minBoost;
  const m36 = minutes / 36;
  const usageOn = { pts: 1, ast: 1, fg3m: 1, tov: 1 };
  const mean = {};
  for (const k of RATE_KEYS) mean[k] = m36 * base[`${k}36`] * pace * opp[k] * (usageOn[k] ? usage : 1);
  return { base, minutes, pace, avail, out, minBoost, usage, opp, ...mean };
}
export function projectPlayer(ctx, type, line) {
  const M = playerMeans(ctx);
  const { base, minutes, pace, avail, out, minBoost, usage, pts, reb, ast, fg3m, stl, blk, tov } = M;
  const oppPts = M.opp.pts, oppReb = M.opp.reb, oppAst = M.opp.ast, opp3 = M.opp.fg3m, oppStl = M.opp.stl, oppBlk = M.opp.blk, oppTov = M.opp.tov;

  const pg = posGroup(ctx.pos);
  const mults = [["pace", pace], ["availability", avail], [`starters out (${out} vs ${base.missMin.toFixed(1)} usual): minutes`, minBoost]];
  const um = [["starters out: usage", usage]];
  const baseStr = `${base.minutes0.toFixed(1)} min base (recent ${base.minutesBase.toFixed(1)}${base.shift ? `, role ${base.shift > 0 ? "+" : ""}${base.shift.toFixed(1)}` : ""}${base.teamChange ? ", new team" : ""}) · ${base.curGames} gm this season + ${base.priorLabel === "none" ? "no prior season" : `${base.priorGames} gm ${base.priorLabel}`}`;
  const sg = (k, mean) => ({ fam: "sg", mean, phi: SG[k].phi, shift: SG[k].shift });
  const nb = (k, mean) => ({ fam: "nb", mean, phi: NB_PHI[k] });
  const single = {
    "Points": { ...sg("pts", pts), mults: [...mults, ...um, [`opp pts allowed vs ${pg}`, oppPts]] },
    "Rebounds": { ...nb("reb", reb), mults: [...mults, [`opp reb allowed vs ${pg}`, oppReb]] },
    "Assists": { ...nb("ast", ast), mults: [...mults, ...um, [`opp ast allowed vs ${pg}`, oppAst]] },
    "Three-Pointers Made": { ...nb("fg3m", fg3m), mults: [...mults, ...um, [`opp 3PM allowed vs ${pg}`, opp3]] },
    "Steals": { ...nb("stl", stl), mults: [...mults, [`opp steals given vs ${pg}`, oppStl]] },
    "Blocks": { ...nb("blk", blk), mults: [...mults, [`opp blocks given vs ${pg}`, oppBlk]] },
    "Turnovers": { ...nb("tov", tov), mults: [...mults, ...um, [`opp TOs forced vs ${pg}`, oppTov]] },
  };
  // combos: sum of the means with their own fitted spread (the stats move together through minutes)
  const combo = {
    "Pts+Reb+Ast": { ...sg("Pts+Reb+Ast", pts + reb + ast), mults: [...mults, ...um, [`opp pts allowed vs ${pg}`, oppPts], [`opp reb allowed vs ${pg}`, oppReb], [`opp ast allowed vs ${pg}`, oppAst]] },
    "Pts+Reb": { ...sg("Pts+Reb", pts + reb), mults: [...mults, ...um, [`opp pts allowed vs ${pg}`, oppPts], [`opp reb allowed vs ${pg}`, oppReb]] },
    "Pts+Ast": { ...sg("Pts+Ast", pts + ast), mults: [...mults, ...um, [`opp pts allowed vs ${pg}`, oppPts], [`opp ast allowed vs ${pg}`, oppAst]] },
    "Reb+Ast": { ...nb("Reb+Ast", reb + ast), mults: [...mults, [`opp reb allowed vs ${pg}`, oppReb], [`opp ast allowed vs ${pg}`, oppAst]] },
    "Blocks+Steals": { ...nb("Blocks+Steals", blk + stl), mults: [...mults, [`opp blocks given vs ${pg}`, oppBlk], [`opp steals given vs ${pg}`, oppStl]] },
  };
  const t = single[type] || combo[type];
  if (t) {
    const seed = hashSeed(`${single[type] ? "p" : "c"}|${type}|${line}|${minutes.toFixed(2)}|${t.mean.toFixed(2)}`);
    const pOver = probFor(t, line, seed);
    const dist = t.fam === "sg" ? "Shifted Gamma·MC" : "Neg.Binom·MC";
    const params = t.fam === "sg" ? `μ=${t.mean.toFixed(2)}, φ=${t.phi}, shift ${t.shift}` : `μ=${t.mean.toFixed(2)}, φ=${t.phi}`;
    return { pOver, proj: t.mean, calc: fullCalc(dist, params, t.mean, baseStr, t.mults) };
  }
  if (type === "Double-Double" || type === "Triple-Double") {
    const need = type === "Double-Double" ? 2 : 3;
    const p = simulateDoubleTriple({ pts, reb, ast, stl, blk, minutesMean: minutes }, need);
    return { pOver: p, proj: p, calc: fullCalc("Joint MC", "≥N of {pts,reb,ast,stl,blk} ≥10, shared-minutes-correlated", p, `${need} of 5 stat lines ≥ 10 · ${baseStr}`, mults) };
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
    const cats = [["pts", DD_PHI.pts], ["reb", DD_PHI.reb], ["ast", DD_PHI.ast], ["stl", DD_PHI.stl], ["blk", DD_PHI.blk]];
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
