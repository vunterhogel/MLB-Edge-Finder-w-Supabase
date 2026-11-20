/* NHL projection engine (nhl-v1).
   Skaters: per-game rates from this season's games plus last season's (weighted half), shrunk to a
   positional prior, then scaled by ice time trend, opponent shot suppression and the game's goal
   environment. Goalies: expected shots against x shrunk save %. Game lines: two Poisson team scores
   for regulation, with ties going to OT/shootout (one extra goal, home wins 52%).
   Every probability is then blended toward the no-vig market price (CALIB_KEEP), the same
   protection the MLB model uses, since this model has no settled track record yet. */
import { clamp, evPerUnit, impliedProb, negativeBinomialProbabilityOver, noVigProb, poiCdf, poiPmf, probToAmerican } from "../../core/math";
import { LG, PRIOR, PRIOR_SEASON_MAX, PRIOR_SEASON_WEIGHT, SHRINK_G } from "./config";

export const MODEL_VERSION = "nhl-v3.3-2026-11-19";   // v3.3: priced against the market consensus of other books (core/consensus.ts)   // v3.1: calibration weights refit on v3 board logs
/* v3 (2026-11-12): skater base rates rebuilt. v2 shrank every skater's per-game rates 25-30 games toward a league-average forward /
   defenseman, so the players books post props on (top six, power play) were projected 15-30% low on points
   and assists and nearly every flag was an under. v3 projects ice time from recent games, works in per-60
   rates (this season by recency + last season as an anchor) and shrinks toward a prior that scales with
   ice time, so a 20-minute first-liner is pulled toward a first-liner, not the average forward. Points now
   use a Poisson (fitted: NB overstated their spread), SOG phi 1.125, Saves phi 2.05. Replayed 2024-25
   (tuning) and 2025-26 (held out): better on every skater market (points z 14, assists z 10, SOG z 5,
   goals z 5, saves z 3), top-quintile points act/proj 1.14 -> 1.03. Opponent factors are v2's. */
/* v2 (2026-10-27): the skater game-environment factor no longer counts the player's own team offense
   twice. v1 multiplied his per-game rates (which already reflect his team's offense) by a team goal /
   shot expectation that included that same offense; v2 uses only the opponent side: the opponent's
   defense + starting goalie for points / goals / assists, and what the opponent allows by position
   (forwards vs defensemen) for shots on goal and goals. Replaying the 2025-26 regular season game by
   game (inputs built only from games before each one; settings chosen on the first half, judged on
   the held-out second half), v2 scored better than v1 on every skater market it changes: shots on goal
   (z 2.4), points (z 3.6), goals (z 1.8), assists (z 3.2), by average log-likelihood of the actual
   result. Power Play Points keeps v1's factor (the box scores can't validate a change there); saves
   are unchanged (no double count). Game lines are unchanged. */
// dispersion = variance / mean (core/math NB convention), matching the collector's fitted values
export const NB_PHI = { sog: 1.125, saves: 2.05 }; // v3 fit on 2024-25 (points and assists are Poisson)
export const HOME_ICE = 1.025;          // goal-rate multiplier for the home team (inverse-ish for away)
export const OT_HOME_WIN = 0.52;        // P(home wins | tied after regulation)
export const REG_SHARE = 0.97;          // share of a team's goals scored in regulation
/* 2026-11-16 refit on v3 board logs (11/12-11/15, 2,406 settled rows; game lines also on v2 rows, which use the same
   game model): fitted Points 0.95, Assists 0.85, SOG 0.20, Saves 0, Moneyline / Puck Line / Total 0. Four nights is
   thin, so each is set halfway between the fit and the old value (Points 0.30 -> 0.60, Assists 0.30 -> 0.55, SOG
   0.40 -> 0.30, Saves 0.35 -> 0.15); game lines fit 0 on 2+ weeks of v2 + v3 rows -> 0. A weight of 0 = the market
   price (the model's lean adds nothing there yet; it still prices and logs). Leave-one-night-out: log-loss ties the
   market (0.6552) and flags go -8.0% -> -4.6%. Refit weekly. Goals / PPP have no logged rows: unchanged. */
/* v3.2 (2026-11-19): weights = the measured information in the model's lean (slope of (result - no-vig) on
   (raw - no-vig), clustered by player-game), over v3 + v3.1 board logs 11/12-11/18 (same skater model; 2,300 over
   rows): Points +0.47 +/- 0.38, Assists +0.56 +/- 0.42, SOG +0.19 +/- 0.37; pooled skater props +0.39 +/- 0.22.
   Shrunk to the pooled value (empirical Bayes, no between-market spread detected) -> 0.40 for skater props.
   Saves -1.1 +/- 1.1 (87 rows) -> 0; game lines 45 games each, slopes negative -> 0. Refit weekly. */
export const CALIB_KEEP = { "Shots on Goal": 0.40, "Points": 0.40, "Goals": 0.40, "Assists": 0.40, "Power Play Points": 0.40, "Saves": 0.00, "Moneyline": 0.00, "Puck Line": 0.00, "Total": 0.00 };
export const keepFor = (t) => (CALIB_KEEP[t] != null ? CALIB_KEEP[t] : 0.4);
export const calibrateToMarket = (p, market, type) => (p == null || market == null ? p : clamp(market + keepFor(type) * (p - market), 0.001, 0.999));

/* ---------- skater rates ---------- */
// v3 (see MODEL_VERSION): ice time from recent games + per-60 rates with a role prior that scales with ice time
export const V3 = {
  toiHalfLife: 2,       // games: a game's weight in the ice-time projection halves every 2 games
  priorToiGames: 1,     // last season's average ice time counts as this many recent games
  roleToiGames: 0.25,   // position-average ice time mixed in (games)
  rateHalfLife: 120,    // games: per-60 rates have a long memory
  priorRateGames: 25,   // last season's per-60 rates count as this many games of his ice time
  priorMinutes: 300,    // per-60 rates shrink toward the role prior by this many minutes
  roleGamma: 0.8,       // role prior per 60 = position average x (proj TOI / position TOI)^0.8
};
// league per-60 by position, 2025-26 regular season (NHL box scores)
export const LG60 = { F: { sog: 6.68, g: 0.867, a: 1.186, toi: 15.14 }, D: { sog: 3.96, g: 0.240, a: 0.837, toi: 19.30 } };
function v2Rates(cur, prior, pos) { // v1/v2 per-game shrink: still used for Power Play Points (no box data to refit it)
  const P = PRIOR[pos === "D" ? "D" : "F"];
  const rows = [...cur.map((r) => ({ r, w: 1 })), ...prior.slice(0, PRIOR_SEASON_MAX).map((r) => ({ r, w: PRIOR_SEASON_WEIGHT }))];
  let wsum = 0; const tot = { ppp: 0, toi: 0 };
  for (const { r, w } of rows) { const s = r.s || {}; wsum += w; tot.ppp += w * ((s.powerPlayGoals || 0) + (s.powerPlayAssists || 0)); tot.toi += w * (s.timeOnIcePerGame || 0); }
  const shr = (k) => (tot[k] + SHRINK_G[k] * P[k]) / (wsum + SHRINK_G[k]);
  return { ppp: shr("ppp"), toi: shr("toi"), effGames: wsum };
}
// rows: newest-first game rows from core/espn fetchGamelog. Returns per-game means (before opponent factors).
export function skaterRates(cur0, prior0, pos) {
  const cur = (cur0 || []).filter((r) => !r.postseason), prior = (prior0 || []).filter((r) => !r.postseason);
  const L = LG60[pos === "D" ? "D" : "F"];
  const toiOf = (r) => (r.s && r.s.timeOnIcePerGame) || 0;
  const pToi = prior.length ? prior.reduce((a, r) => a + toiOf(r), 0) / prior.length : 0;
  const pw = prior.length ? 1 : 0;
  let w = 0, tS = 0, rw = 0, rMin = 0; const st = { sog: 0, g: 0, a: 0 };
  for (let i = 0; i < cur.length; i++) {
    const s = cur[i].s || {}, m = toiOf(cur[i]), a = Math.pow(0.5, i / V3.toiHalfLife), b = Math.pow(0.5, i / V3.rateHalfLife);
    w += a; tS += a * m; rw += b; rMin += b * m; st.sog += b * (s.shotsTotal || 0); st.g += b * (s.goals || 0); st.a += b * (s.assists || 0);
  }
  const kt = V3.priorToiGames * pw;
  const toi = (tS + kt * pToi + V3.roleToiGames * L.toi) / (w + kt + V3.roleToiGames);
  const pMin = prior.reduce((a, r) => a + toiOf(r), 0);
  const pSum = { sog: 0, g: 0, a: 0 }; for (const r of prior) { const s = r.s || {}; pSum.sog += s.shotsTotal || 0; pSum.g += s.goals || 0; pSum.a += s.assists || 0; }
  const anchorMin = V3.priorRateGames * pw * pToi;
  const role = Math.pow(Math.max(toi, 5) / L.toi, V3.roleGamma);
  const per = {};
  for (const k of ["sog", "g", "a"]) {
    const pRate = pMin ? pSum[k] / pMin : 0;
    const den = rMin + anchorMin, seen = den ? (st[k] + pRate * anchorMin) / den : 0;
    per[k] = (seen * den + (L[k] / 60) * role * V3.priorMinutes) / (den + V3.priorMinutes);
  }
  const old = v2Rates(cur, prior, pos);
  const last5 = cur.slice(0, 5);
  const recentToi = last5.length >= 3 ? last5.reduce((a, r) => a + toiOf(r), 0) / last5.length : null;
  // Power Play Points keep v2's per-game rate and its ice-time trend multiplier
  const pppToiMult = recentToi && old.toi ? clamp(1 + 0.6 * (recentToi / old.toi - 1), 0.88, 1.12) : 1;
  return { sog: toi * per.sog, g: toi * per.g, a: toi * per.a, ppp: old.ppp, pppToiMult, toi, recentToi: null, per60: { sog: per.sog * 60, g: per.g * 60, a: per.a * 60 },
    games: cur.length, priorGames: Math.min(prior.length, PRIOR_SEASON_MAX), effGames: old.effGames };
}
export function goalieRates(cur, prior) {
  const rows = [...(cur || []).filter((r) => !r.postseason).map((r) => ({ r, w: 1 })), ...(prior || []).filter((r) => !r.postseason).slice(0, PRIOR_SEASON_MAX).map((r) => ({ r, w: PRIOR_SEASON_WEIGHT }))];
  let sa = 0, sv = 0, starts = 0;
  for (const { r, w } of rows) { const s = r.s || {}; sa += w * (s.shotsAgainst || 0); sv += w * (s.saves || 0); starts += w * (s.gameStarted || 0); }
  const SHRINK_SHOTS = 600;   // ~20 starts of league-average goaltending mixed in
  const svPct = (sv + SHRINK_SHOTS * LG.svPct) / (sa + SHRINK_SHOTS);
  const curRows = (cur || []).filter((r) => !r.postseason);
  const curSa = curRows.reduce((a, r) => a + (r.s.shotsAgainst || 0), 0), curSv = curRows.reduce((a, r) => a + (r.s.saves || 0), 0);
  return { svPct, rawSvPct: curSa ? curSv / curSa : null, starts: curRows.filter((r) => r.s.gameStarted).length, games: curRows.length, gaa: curRows.length ? curRows.reduce((a, r) => a + (r.s.goalsAgainst || 0), 0) / curRows.length : null, effStarts: starts };
}

/* ---------- team environment ---------- */
// t: { gp, gf, ga, sf, sa } season totals. Shrunk per-game rates.
export function teamRates(t) {
  const K = 10;
  const gp = (t && t.gp) || 0;
  const per = (tot, lg) => (((t && t[tot]) || 0) + K * lg) / (gp + K);   // shrink to league with K games
  return { gf: per("gf", LG.goals), ga: per("ga", LG.goals), sf: per("sf", LG.shots), sa: per("sa", LG.shots), gp };
}
export function goalieFactor(g) { return g && g.svPct ? clamp((1 - g.svPct) / (1 - LG.svPct), 0.8, 1.25) : 1; }
// expected goals for each side, full game (OT credit included)
export function gameLambdas(home, away, homeGoalie, awayGoalie) {
  const H = teamRates(home), A = teamRates(away);
  const defA = 0.5 * (A.ga / LG.goals) + 0.5 * goalieFactor(awayGoalie);
  const defH = 0.5 * (H.ga / LG.goals) + 0.5 * goalieFactor(homeGoalie);
  const lambdaH = clamp(LG.goals * (H.gf / LG.goals) * defA * HOME_ICE, 1.8, 4.8);
  const lambdaA = clamp(LG.goals * (A.gf / LG.goals) * defH / HOME_ICE, 1.6, 4.6);
  // expected shots on goal for each side (drives skater SOG and goalie saves)
  const shotsH = clamp(H.sf * (A.sa / LG.shots), 20, 40);
  const shotsA = clamp(A.sf * (H.sa / LG.shots), 20, 40);
  return { lambdaH: +lambdaH.toFixed(2), lambdaA: +lambdaA.toFixed(2), shotsH: +shotsH.toFixed(1), shotsA: +shotsA.toFixed(1), H, A };
}

/* ---------- game lines ---------- */
// Regulation scores ~ independent Poisson; tie -> OT/SO, winner credited one goal.
// hc/ac = current score, fr = fraction of regulation remaining (1 pregame).
function forEachOutcome(lh, la, hc, ac, fr, fn) {
  const rh = lh * REG_SHARE * fr, ra = la * REG_SHARE * fr;
  const N = 14;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const pr = poiPmf(i, rh) * poiPmf(j, ra);
    const h = hc + i, a = ac + j;
    if (h !== a) fn(h, a, pr);
    else { fn(h + 1, a, pr * OT_HOME_WIN); fn(h, a + 1, pr * (1 - OT_HOME_WIN)); }
  }
}
export function gameProbs(lh, la, hc = 0, ac = 0, fr = 1, totalLine = null) {
  let home = 0, over = 0, under = 0, homeBy2 = 0, awayBy2 = 0, regTie = 0;
  forEachOutcome(lh, la, hc, ac, fr, (h, a, pr) => {
    if (h > a) home += pr;
    if (h - a >= 2) homeBy2 += pr; if (a - h >= 2) awayBy2 += pr;
    if (totalLine != null) { const t = h + a; if (t > totalLine) over += pr; else if (t < totalLine) under += pr; }
  });
  const rh = lh * REG_SHARE * fr, ra = la * REG_SHARE * fr;
  for (let i = 0; i < 14; i++) if (hc + i - ac >= 0 && hc + i - ac < 14) regTie += poiPmf(i, rh) * poiPmf(hc + i - ac, ra);
  return { home, away: 1 - home, over, under, homeBy2, awayBy2, regTie, totalLambda: lh + la };
}
export function marginProb(lh, la, hc, ac, fr, cmp) {
  let p = 0;
  forEachOutcome(lh, la, hc, ac, fr, (h, a, pr) => { if (cmp(h - a)) p += pr; });
  return p;
}

/* ---------- props ---------- */
function overProb(family, mean, line, phi) {
  mean = Math.max(mean, 1e-6);
  if (line < 0) return 1;
  if (family === "poisson") return 1 - poiCdf(Math.floor(line), mean);
  return negativeBinomialProbabilityOver(line, mean, phi);
}
const PROP_SPEC = {
  "Shots on Goal": { key: "sog", fam: "nb", phi: NB_PHI.sog, cur: (t) => t.shotsTotal || 0 },
  "Points": { key: "pts", fam: "poisson", cur: (t) => (t.goals || 0) + (t.assists || 0) },
  "Goals": { key: "g", fam: "poisson", cur: (t) => t.goals || 0 },
  "Assists": { key: "a", fam: "poisson", cur: (t) => t.assists || 0 },
  "Power Play Points": { key: "ppp", fam: "poisson", cur: (t) => (t.powerPlayGoals || 0) + (t.powerPlayAssists || 0) },
};
export function projectProp(ctx, type, line) {
  ctx = ctx || {};
  const live = ctx.live && ctx.live.fractionRemaining != null ? ctx.live : null;
  const fr = live ? live.fractionRemaining : 1;
  const totals = (live && live.totals) || {};
  if (type === "Saves") {
    if (ctx.kind !== "goalie" || !ctx.rates) return { pOver: null, proj: null, calc: null };
    const sv = ctx.rates.svPct;
    const mean = ctx.expShotsAgainst * sv * 0.97;   // 0.97: pulled-goalie / relief risk
    const cur = live ? (totals.saves || 0) : 0;
    const rem = mean * fr;
    const pOver = overProb("nb", rem, line - cur, NB_PHI.saves);
    const proj = cur + rem;
    return { pOver, proj, calc: { dist: "Neg.Binom", params: `μ=${rem.toFixed(1)}${live ? " rem" : ""}, φ=${NB_PHI.saves}`, proj, baseStr: `${ctx.expShotsAgainst.toFixed(1)} exp shots against × ${(sv * 100).toFixed(1)}% sv (shrunk)`, mults: [["pull risk", 0.97]], live: live ? { current: cur, fr } : null } };
  }
  const spec = PROP_SPEC[type];
  if (!spec || ctx.kind !== "skater" || !ctx.rates) return { pOver: null, proj: null, calc: null };
  const r = ctx.rates;
  const base = spec.key === "pts" ? r.g + r.a : r[spec.key];
  // v3: sog / goals / assists already come from projected ice time; only PPP keeps v2's trend multiplier
  const toiMult = spec.key === "ppp" ? r.pppToiMult || 1 : 1;
  const env = clamp(ctx.teamLambda / LG.goals, 0.75, 1.3);
  const shotEnv = clamp(1 + 0.7 * (ctx.teamShots / LG.shots - 1), 0.85, 1.15);
  const mx = ctx.mx;
  let ctxMult, envLabel;
  if (mx && spec.key !== "ppp") {
    // v2: opponent side only (see MODEL_VERSION note). Position = forwards (F) or defensemen (D).
    const grp = ctx.pos === "D" ? "D" : "F";
    const pos = mx.pos || null;
    if (spec.key === "sog") {
      const m = pos ? pos.sog[grp] : mx.oppShots;
      ctxMult = clamp(1 + 0.7 * (m - 1), 0.85, 1.15); envLabel = pos ? `opp SOG allowed vs ${grp}` : "opp shots allowed";
    } else if (spec.key === "g" && pos) {
      ctxMult = clamp((0.5 * pos.g[grp] + 0.5 * mx.goalie) * mx.ice, 0.75, 1.3); envLabel = `opp goals allowed vs ${grp} + goalie`;
    } else {
      ctxMult = clamp(mx.defOpp * mx.ice, 0.75, 1.3); envLabel = "opp defense + goalie";
    }
  } else {
    ctxMult = spec.key === "sog" ? shotEnv : spec.key === "ppp" ? Math.sqrt(env) : env;
    envLabel = spec.key === "sog" ? "opp shot env" : "goal env";
  }
  const mean = base * toiMult * ctxMult;
  const cur = live ? spec.cur(totals) : 0;
  const rem = mean * fr;
  const pOver = overProb(spec.fam, rem, line - cur, spec.phi);
  const proj = cur + rem;
  const baseStr = `${base.toFixed(3)} ${type}/gm (${r.games} gm this season + ${r.priorGames} last season) · ${r.toi.toFixed(1)} proj TOI`;
  return { pOver, proj, calc: { dist: spec.fam === "poisson" ? "Poisson" : "Neg.Binom", params: `μ=${rem.toFixed(2)}${live ? " rem" : ""}${spec.phi ? `, φ=${spec.phi}` : ""}`, proj, baseStr, mults: live ? [] : [...(spec.key === "ppp" ? [["ice time trend", toiMult]] : []), [envLabel, ctxMult]], live: live ? { current: cur, fr } : null } };
}

/* full evaluation of a priced prop (model + market), same shape as MLB's evalBet */
export function evalBet(b, pre) {
  const { pOver, proj, calc } = pre || projectProp(b.ctx, b.type, parseFloat(b.line));
  if (pOver == null || !isFinite(pOver)) return { modelP: null, rawModelP: null, proj, calc, imp: null, novig: null, edge: null, ev: null, b: 0, fair: "—", devigged: false };
  const rawP = b.side === "over" ? pOver : 1 - pOver;
  const odds = Number(b.odds);
  const imp = isNaN(odds) ? null : impliedProb(odds);
  const novig = (b.overOdds != null || b.underOdds != null) ? noVigProb(b.overOdds, b.underOdds, b.side) : imp;
  const fairRef = novig != null ? novig : imp;
  // role check: a goalie who is not the listed starter, or a skater flagged injured, gets no edge
  const suppressNote = b.ctx && b.ctx.kind === "goalie" && !b.ctx.starter ? "not the listed starter"
    : b.ctx && b.ctx.injury ? `injury: ${b.ctx.injury}` : null;
  const modelP = suppressNote ? fairRef : calibrateToMarket(rawP, fairRef, b.type);
  const bmult = isNaN(odds) ? 0 : (odds > 0 ? odds / 100 : 100 / -odds);
  const edge = (modelP != null && fairRef != null) ? modelP - fairRef : null;
  const ev = (modelP != null && !isNaN(odds)) ? evPerUnit(modelP, odds) : null;
  return { modelP, rawModelP: rawP, proj, calc, imp, novig, edge, ev, b: bmult, fair: modelP != null ? probToAmerican(modelP) : "—", devigged: b.overOdds != null && b.underOdds != null, suppressNote };
}

/* fraction of regulation left from ESPN period + clock ("12:34") */
export function fractionRemaining(period, clock) {
  if (!period) return 1;
  if (period > 3) return 0.02;
  const [m, s] = String(clock || "20:00").split(":").map(Number);
  const left = (3 - period) * 20 + (m || 0) + (s || 0) / 60;
  return clamp(left / 60, 0.01, 1);
}
