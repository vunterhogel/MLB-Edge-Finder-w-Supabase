import { clamp } from "./math";

// Projection-vs-line numbers for the buffer indicator.
// delta > 0 means the projection is on the "good" side of the line for the bet direction:
//   over bet: proj > line  (proj clears the line)
//   under bet: line > proj (proj sits below the line)
export function projMeta(proj, lineStr, side) {
  const l = parseFloat(String(lineStr));
  if (proj == null || isNaN(l) || l <= 0) return null;
  const delta = side === "over" ? proj - l : l - proj;
  // strength relative to the line value (e.g. +0.7 on a 0.5 line = 140% buffer = very strong)
  const strength = delta < 0 ? "miss" : delta > 0.3 * l ? "strong" : delta > 0.05 * l ? "clear" : "thin";
  const max = Math.max(l * 2.5, proj * 1.5, l + 2);
  const linePct = clamp((l / max) * 100, 1, 98);
  const projPct = clamp((proj / max) * 100, 0, 100);
  return { delta, strength, linePct, projPct };
}
