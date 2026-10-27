/* Pieces shared by the hub pages. */
import { betStats } from "../core/bets";
import { mono } from "../core/ui";
import { HUB_SPORTS } from "./sports";

export function HubHeader({ title, accent, sub }) {
  return (
    <header className="pt-6 pb-3 border-b border-slate-800">
      <h1 className="text-2xl font-black tracking-tight">{title} <span className="text-emerald-400">{accent}</span></h1>
      <p className="text-[11px] text-slate-500 mt-0.5" style={mono}>{sub}</p>
    </header>
  );
}

/* Stats across every sport: the overall line over all bets, plus each sport's own stats and its
   per-market rows labeled "NBA · Points" etc. (NBA and NHL both have a Points market, so markets are
   never merged across sports). typeOrder lists those labels in sport, then market, order. */
export function combinedStats(all, range) {
  const everything = HUB_SPORTS.flatMap((s) => all[s.id]);
  const base = betStats(everything, range, []);
  const bySport = {}, byType = {}, typeOrder = [];
  for (const s of HUB_SPORTS) {
    const st = betStats(all[s.id], range, s.sport.config.STAT_ORDER);
    bySport[s.id] = st;
    for (const t of s.sport.config.STAT_ORDER) if (st.byType[t]) { const k = `${s.label} · ${t}`; byType[k] = st.byType[t]; typeOrder.push(k); }
  }
  return { ...base, byType, typeOrder, bySport };
}
