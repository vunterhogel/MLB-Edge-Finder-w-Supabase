import { gradeBet, profitUnits } from "../../core/math";
export { gradeBet, profitUnits };
/* settling helpers */
export function actualFor(type, ps) {
  if (!ps) return null;
  switch (type) {
    case "Hits": return ps.h; case "Total Bases": return ps.tb; case "Home Run": return ps.hr;
    case "H+R+RBI": return ps.h + ps.r + ps.rbi; case "Strikeouts": return ps.k; case "Outs": return ps.outs;
  }
  return null;
}
// grade a moneyline / total / run-line bet from the final score
export function gradeLine(type, side, point, homeRuns, awayRuns) {
  if (homeRuns == null || awayRuns == null) return { status: null, actual: null };
  if (type === "Moneyline") {
    const homeWin = homeRuns > awayRuns;
    const win = side === "home" ? homeWin : !homeWin;
    return { status: win ? "won" : "lost", actual: `${awayRuns}-${homeRuns}` };
  }
  if (type === "Total") {
    const tot = homeRuns + awayRuns;
    if (tot === point) return { status: "push", actual: tot };
    const over = tot > point;
    return { status: (side === "over" ? over : !over) ? "won" : "lost", actual: tot };
  }
  if (type === "Run Line") {
    const margin = side === "home" ? (homeRuns - awayRuns) : (awayRuns - homeRuns);
    if (margin + point === 0) return { status: "push", actual: `${awayRuns}-${homeRuns}` };
    return { status: (margin + point) > 0 ? "won" : "lost", actual: `${awayRuns}-${homeRuns}` };
  }
  return { status: null, actual: null };
}
export function findPlayerInSlate(playerId, games) {
  const id = String(playerId);
  for (const g of games || []) {
    const awayHit = (g.awayLineup || []).find((p) => String(p.id) === id);
    if (awayHit) return { game: g, kind: "hitter", side: "away", lineupIndex: (g.awayLineup || []).findIndex((p) => String(p.id) === id), player: awayHit, oppSP: g.homeSP };
    const homeHit = (g.homeLineup || []).find((p) => String(p.id) === id);
    if (homeHit) return { game: g, kind: "hitter", side: "home", lineupIndex: (g.homeLineup || []).findIndex((p) => String(p.id) === id), player: homeHit, oppSP: g.awaySP };
    if (g.awaySP && String(g.awaySP.id) === id) return { game: g, kind: "pitcher", side: "away", player: g.awaySP, oppTeam: g.home };
    if (g.homeSP && String(g.homeSP.id) === id) return { game: g, kind: "pitcher", side: "home", player: g.homeSP, oppTeam: g.away };
  }
  return null;
}
