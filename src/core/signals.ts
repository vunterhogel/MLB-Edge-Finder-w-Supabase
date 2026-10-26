/* Projection-vs-line signal ("delta gate"), shared by every sport.
   A sport's config carries SIGNAL_RULES: per-market thresholds on delta = projection − line, fit from that
   sport's settled board log the way MLB's were (Sep 2-7 data). A market with no rule gets no signal. Sports
   without enough settled data yet ship an empty table: the Board shows the same signal column and filter,
   it simply has nothing to flag until thresholds are calibrated and added here.
     { mode: "abs",  strong, moderate }  |delta| >= threshold (both directions meaningful)
     { mode: "over", strong?, moderate } delta > threshold (direction-only: projection above the line) */
export function makeDeltaSignal(rules = {}) {
  return function getDeltaSignal(type, proj, line) {
    const r = rules[type];
    if (!r || proj == null || line == null) return null;
    const lineNum = parseFloat(line);
    if (isNaN(lineNum)) return null;
    const delta = proj - lineNum;
    if (r.mode === "abs") {
      const abs = Math.abs(delta);
      return r.strong != null && abs >= r.strong ? "strong" : abs >= r.moderate ? "moderate" : null;
    }
    return r.strong != null && delta > r.strong ? "strong" : delta > r.moderate ? "moderate" : null;
  };
}
