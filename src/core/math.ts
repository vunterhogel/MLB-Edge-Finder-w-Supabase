 // per-session safety rail against runaway loops (20k/mo key — generous)

/* ---------- stake sizing ---------- */
// Suggested stake = fractional Kelly. Kelly fraction f* = EV / b (b = profit per $1).
// 1 unit = 1% of bankroll, so full-Kelly units = f* * 100. We use QUARTER Kelly and
// cap it, because Kelly assumes the model probability is exactly right — and ours is
// not proven (and has shown overconfidence). Flat 1u stays available for comparison.
export const KELLY_FRACTION = 0.25;          // quarter Kelly
export const KELLY_BANKROLL_UNITS = 100;     // 1u = 1% of bankroll
export const SUGGEST_MAX_UNITS = 3;          // hard cap on a single suggested stake
export function suggestedUnits(modelP, odds) {
  if (modelP == null || isNaN(odds)) return 0;
  const b = odds > 0 ? odds / 100 : 100 / -odds;
  const ev = modelP * b - (1 - modelP);
  if (ev <= 0) return 0;              // no edge -> suggest no bet
  const f = ev / b;                   // Kelly fraction of bankroll
  const u = f * KELLY_BANKROLL_UNITS * KELLY_FRACTION;
  return clamp(Math.round(u * 4) / 4, 0, SUGGEST_MAX_UNITS); // round to 0.25u
}

/* ---------------------- core math ---------------------- */
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const fact = (n) => { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; };
export const poiPmf = (k, l) => (l <= 0 ? (k === 0 ? 1 : 0) : Math.exp(-l) * Math.pow(l, k) / fact(k));
export const poiCdf = (k, l) => { let s = 0; for (let i = 0; i <= k; i++) s += poiPmf(i, l); return s; };
export const binPmf = (k, n, p) => {
  if (p <= 0) return k === 0 ? 1 : 0; if (p >= 1) return k === n ? 1 : 0;
  const c = fact(n) / (fact(k) * fact(n - k));
  return c * Math.pow(p, k) * Math.pow(1 - p, n - k);
};
export const binCdf = (k, n, p) => { let s = 0; for (let i = 0; i <= k; i++) s += binPmf(i, n, p); return s; };

export function lgamma(x) {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1; let a = c[0]; const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
export function nbParams(mean, phi) {
  const m = Math.max(mean, 1e-9);
  const v = Math.max(m * Math.max(phi, 1.0001), m + 1e-6);
  const r = (m * m) / (v - m);
  const p = r / (r + m);
  return { r, p, mean: m };
}
export function negativeBinomialPMF(k, mean, phi) {
  if (k < 0) return 0;
  const { r, p } = nbParams(mean, phi);
  return Math.exp(lgamma(k + r) - lgamma(r) - lgamma(k + 1) + r * Math.log(p) + k * Math.log(1 - p));
}
export function negativeBinomialCDF(k, mean, phi) { let s = 0; for (let i = 0; i <= k; i++) s += negativeBinomialPMF(i, mean, phi); return s; }
export function negativeBinomialProbabilityOver(line, mean, phi) { return 1 - negativeBinomialCDF(Math.floor(line), mean, phi); }

export let RNG = Math.random;
export function mulberry32(a) {
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function hashSeed(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export let _spareGaussian = null;
export function gaussian() {
  if (_spareGaussian != null) { const s = _spareGaussian; _spareGaussian = null; return s; }
  let u, v, s; do { u = RNG() * 2 - 1; v = RNG() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
  const m = Math.sqrt(-2 * Math.log(s) / s); _spareGaussian = v * m; return u * m;
}
export function sampleGamma(shape, scale) {
  if (shape < 1) { const u = RNG(); return sampleGamma(1 + shape, scale) * Math.pow(u, 1 / shape); }
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v; do { x = gaussian(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = RNG();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}
export function samplePoisson(lam) {
  if (lam <= 0) return 0;
  if (lam < 30) { const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= RNG(); } while (p > L); return k - 1; }
  return Math.max(0, Math.round(lam + Math.sqrt(lam) * gaussian()));
}
export function sampleNegBin(mean, phi) { const { r, p } = nbParams(mean, phi); const lam = sampleGamma(r, (1 - p) / p); return samplePoisson(lam); }
// A count with mean ~mean and variance phi x mean but less right-skew than the negative binomial: a gamma
// shifted by `shift` (mean + shift, same variance), less the shift, rounded, floored at 0. shift 0 is
// NB-like; bigger shifts are more symmetric. (NBA points: lumpy 2s and 3s give a wide but not very skewed spread.)
export function sampleShiftedGammaCount(mean, phi, shift) {
  const mu = Math.max(mean, 0.01), m = mu + shift, v = phi * mu;
  return Math.max(0, Math.round(sampleGamma((m * m) / v, v / m) - shift));
}
export function runMonteCarlo(drawFn, line, side, seed, N = 50000) {
  const prev = RNG; RNG = mulberry32(seed >>> 0 || 12345); _spareGaussian = null;
  let over = 0; for (let i = 0; i < N; i++) { if (drawFn() > line) over++; }
  RNG = prev; _spareGaussian = null;
  const pOver = over / N; return side === "over" ? pOver : 1 - pOver;
}
// Run fn with the shared RNG temporarily seeded (deterministic per seed), restoring the previous
// RNG afterwards. Same semantics runMonteCarlo uses inline; exported so engines in other modules
// can seed without reassigning this module's bindings.
export function withSeededRng(seed, fn) {
  const prev = RNG; RNG = mulberry32(seed >>> 0 || 12345); _spareGaussian = null;
  try { return fn(); } finally { RNG = prev; _spareGaussian = null; }
}

/* ---------------------- odds + format ---------------------- */
export const impliedProb = (o) => (o < 0 ? -o / (-o + 100) : 100 / (o + 100));
export const probToAmerican = (p) => { if (p <= 0 || p >= 1) return "—"; return p > 0.5 ? `-${Math.round((p / (1 - p)) * 100)}` : `+${Math.round(((1 - p) / p) * 100)}`; };
export const evPerUnit = (p, o) => { const b = o > 0 ? o / 100 : 100 / -o; return p * b - (1 - p); };
export const pct = (x) => (x == null || isNaN(x) ? "—" : `${(x * 100).toFixed(1)}%`);
export const fmtOdds = (o) => (o == null ? "—" : (o > 0 ? `+${o}` : `${o}`));
// no-vig probability for a side given both prices; falls back to raw if one side missing
export function noVigProb(overOdds, underOdds, side) {
  if (overOdds == null && underOdds == null) return null;
  if (overOdds == null || underOdds == null) return impliedProb(side === "over" ? overOdds : underOdds);
  const io = impliedProb(overOdds), iu = impliedProb(underOdds), s = io + iu;
  const novigOver = s > 0 ? io / s : 0.5;
  return side === "over" ? novigOver : 1 - novigOver;
}

/* ---- shared settlement helpers ---- */
export function gradeBet(side, point, actual) {
  if (actual == null) return null;
  if (actual === point) return "push";
  const over = actual > point;
  if (side === "over") return over ? "won" : "lost";
  return over ? "lost" : "won";
}
export function profitUnits(status, odds, units = 1) {
  const u = units == null || isNaN(units) ? 1 : units;
  if (status === "won") return u * (odds > 0 ? odds / 100 : 100 / -odds);
  if (status === "lost") return -u;
  return 0;
}
