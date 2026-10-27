/* NHL projection engine (nhl-v1).
   Skaters: per-game rates from this season's games plus last season's (weighted half), shrunk to a
   positional prior, then scaled by ice time trend, opponent shot suppression and the game's goal
   environment. Goalies: expected shots against x shrunk save %. Game lines: two Poisson team scores
   for regulation, with ties going to OT/shootout (one extra goal, home wins 52%).
   Every probability is then blended toward the no-vig market price (CALIB_KEEP), the same
   protection the MLB model uses, since this model has no settled track record yet. */
import { clamp, evPerUnit, impliedProb, negativeBinomialProbabilityOver, noVigProb, poiCdf, poiPmf, probToAmerican } from "../../core/math";
import { LG, PRIOR, PRIOR_SEASON_MAX, PRIOR_SEASON_WEIGHT, SHRINK_G } from "./config";

export const MODEL_VERSION = "nhl-v2-2026-10-27";
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
export const NB_PHI = { sog: 1.25, pts: 1.15, saves: 1.6 };
export const HOME_ICE = 1.025;          // goal-rate multiplier for the home team (inverse-ish for away)
export const OT_HOME_WIN = 0.52;        // P(home wins | tied after regulation)
export const REG_SHARE = 0.97;          // share of a team's goals scored in regulation
export const CALIB_KEEP = { "Shots on Goal": 0.40, "Points": 0.30, "Goals": 0.30, "Assists": 0.30, "Power Play Points": 0.30, "Saves": 0.35, "Moneyline": 0.50, "Puck Line": 0.50, "Total": 0.50 };
export const keepFor = (t) => (CALIB_KEEP[t] != null ? CALIB_KEEP[t] : 0.4);
export const calibrateToMarket = (p, market, type) => (p == null || market == null ? p : clamp(market + keepFor(type) * (p - market), 0.001, 0.999));

/* ---------- skater rates ---------- */
// rows: newest-first game rows from core/espn fetchGamelog. Returns weighted per-game rates.
export function skaterRates(cur, prior, pos) {
  const P = PRIOR[pos === "D" ? "D" : "F"];
  const use = (rows, w) => rows.filter((r) => !r.postseason).map((r) => ({ r, w }));
  const rows = [...use(cur || [], 1), ...use((prior || []).slice(0, PRIOR_SEASON_MAX), PRIOR_SEASON_WEIGHT)];
  let wsum = 0;
  const tot = { sog: 0, g: 0, a: 0, ppp: 0, toi: 0 };
  for (const { r, w } of rows) {
    const s = r.s || {};
    wsum += w;
    tot.sog += w * (s.shotsTotal || 0); tot.g += w * (s.goals || 0); tot.a += w * (s.assists || 0);
    tot.ppp += w * ((s.powerPlayGoals || 0) + (s.powerPlayAssists || 0)); tot.toi += w * (s.timeOnIcePerGame || 0);
  }
  const shr = (k) => (tot[k] + SHRINK_G[k] * P[k]) / (wsum + SHRINK_G[k]);
  const curRows = (cur || []).filter((r) => !r.postseason);
  const last5 = curRows.slice(0, 5);
  const recentToi = last5.length >= 3 ? last5.reduce((a, r) => a + (r.s.timeOnIcePerGame || 0), 0) / last5.length : null;
  return { sog: shr("sog"), g: shr("g"), a: shr("a"), ppp: shr("ppp"), toi: shr("toi"), recentToi, games: curRows.length, priorGames: Math.min((prior || []).filter((r) => !r.postseason).length, PRIOR_SEASON_MAX), effGames: wsum };
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
  "Points": { key: "pts", fam: "nb", phi: NB_PHI.pts, cur: (t) => (t.goals || 0) + (t.assists || 0) },
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
  const toiRatio = r.recentToi && r.toi ? r.recentToi / r.toi : 1;
  const toiMult = clamp(1 + 0.6 * (toiRatio - 1), 0.88, 1.12);
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
  const baseStr = `${base.toFixed(3)} ${type}/gm (${r.games} gm this season + ${r.priorGames} last season, shrunk) · ${r.toi.toFixed(1)} TOI`;
  return { pOver, proj, calc: { dist: spec.fam === "poisson" ? "Poisson" : "Neg.Binom", params: `μ=${rem.toFixed(2)}${live ? " rem" : ""}${spec.phi ? `, φ=${spec.phi}` : ""}`, proj, baseStr, mults: live ? [] : [["ice time trend", toiMult], [envLabel, ctxMult]], live: live ? { current: cur, fr } : null } };
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
