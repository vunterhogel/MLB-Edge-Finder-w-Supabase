/* Builds the Player Analysis form / splits / game-log sections from a sport's per-game rows, so every
   sport that works from game logs (NBA, NHL, NFL) fills MLB's sections the same way.
   rows: newest first (current season, then the prior-season fallback); curCount = how many are this season.
   types: the prop markets to show (their model projections drive the chart's model line).
   valueFor(row, type): the stat for that market in that game (each sport's trendValueForGame). */
const avg = (rows, fn) => {
  const vals = rows.map(fn).filter((v) => v != null && !isNaN(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
};
const f1 = (x) => (x == null || isNaN(x) ? "—" : Number(x).toFixed(1));
const shortDate = (d) => { if (!d) return ""; const x = new Date(d); return isNaN(x.getTime()) ? String(d).slice(5, 10) : `${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };

export function logSections({ rows, curCount, types, valueFor, abbr = (t) => t, defaultLines = {}, title = "Recent Form" }) {
  const all = rows || [];
  const cur = all.slice(0, curCount == null ? all.length : curCount);
  const label = (t) => abbr(t);
  const windows = [5, 10, 20].map((n) => [n, all.slice(0, n)]);
  const winRow = (name, rs) => [name, rs.length, ...types.map((t) => f1(avg(rs, (r) => valueFor(r, t))))];
  const isHome = (r) => r.atVs !== "@";
  const homeAway = [["Home", all.filter(isHome)], ["Away", all.filter((r) => !isHome(r))]];
  const pairs = (xs) => { const out = []; for (let i = 0; i < xs.length; i += 2) out.push(xs.slice(i, i + 2)); return out; };
  return {
    form: {
      title,
      table: { cols: ["window", "G", ...types.map(label)], rows: all.length ? [...windows.map(([n, rs]) => winRow(`L${n}`, rs)), ...(cur.length ? [winRow("Season", cur)] : [])] : [] },
      cats: types.map((t) => ({ key: t, label: label(t), projType: t, defaultLine: parseFloat(defaultLines[t] ?? "0.5") })),
      games: all.map((r) => ({ date: shortDate(r.date), opp: r.opp || "", homeAway: r.atVs === "@" ? "@" : "vs", v: Object.fromEntries(types.map((t) => [t, valueFor(r, t) ?? 0])) })),
    },
    splits: {
      title: "Home / Away Splits", empty: "No games logged yet.",
      panels: all.length ? homeAway.map(([name, rs]) => ({ label: name, sub: `${rs.length} G`, lines: rs.length ? pairs(types.map((t) => [label(t), f1(avg(rs, (r) => valueFor(r, t)))])) : null })) : [],
    },
    log: {
      title: "Last 10 Game Log", empty: "No game log returned.",
      cols: ["date", "opp", "res", ...types.map(label)],
      rows: all.slice(0, 10).map((r) => [shortDate(r.date) || (r.week != null ? `wk ${r.week}` : "—"), `${r.atVs === "@" ? "@" : "vs"} ${r.opp || "—"}`, `${r.result || ""} ${r.score || ""}`.trim() || "—", ...types.map((t) => { const v = valueFor(r, t); return v == null ? "—" : v; })]),
    },
  };
}
