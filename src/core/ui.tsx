import { useState } from "react";
import { clamp } from "./math";

export const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };
export function Env({ label, v, hot, cold }) {
  return <span className={`px-2 py-1 rounded border ${hot ? "border-rose-700 bg-rose-950/40 text-rose-300" : cold ? "border-sky-800 bg-sky-950/40 text-sky-300" : "border-slate-700 bg-slate-900 text-slate-300"}`}><span className="text-slate-500">{label} </span>{v}</span>;
}
export function HotBadge({ delta }) {
  if (delta == null) return null;
  if (delta > 0.08) return <span className="text-[9px] font-bold text-rose-400 ml-1">HOT</span>;
  if (delta < -0.08) return <span className="text-[9px] font-bold text-sky-400 ml-1">COLD</span>;
  return null;
}
// Returns projection-vs-line metadata for the visual buffer indicator.
// delta > 0 means the projection is on the "good" side of the line for the bet direction:
//   over bet: proj > line  (proj clears the line)
//   under bet: line > proj (proj sits below the line)
export function projMeta(proj, lineStr, side) {
  const l = parseFloat(String(lineStr));
  if (proj == null || isNaN(l) || l <= 0) return null;
  const delta = side === "over" ? proj - l : l - proj;
  // Color thresholds relative to the line value (e.g. +0.7 on a 0.5 line = 140% buffer = very strong)
  const color = delta < 0
    ? "text-rose-400"
    : delta > 0.3 * l
    ? "text-emerald-400"
    : delta > 0.05 * l
    ? "text-emerald-600"
    : "text-slate-500";
  const barColor = delta < 0 ? "#f87171" : delta > 0.3 * l ? "#34d399" : "#86efac";
  const max = Math.max(l * 2.5, proj * 1.5, l + 2);
  const linePct = clamp((l / max) * 100, 1, 98);
  const projPct = clamp((proj / max) * 100, 0, 100);
  return { delta, color, barColor, linePct, projPct };
}
export function TrendPill({ label, s }) {
  if (!s || !s.n) {
    return (
      <div className="flex-1 min-w-[88px] text-center bg-slate-950/60 border border-slate-800 rounded-lg px-2 py-1.5">
        <div className="text-[10px] text-slate-500 uppercase tracking-wide truncate">{label}</div>
        <div className="text-slate-600 text-sm">no data</div>
      </div>
    );
  }
  const pct = Math.round(s.pct * 100);
  const color = pct >= 70 ? "text-emerald-400" : pct <= 30 ? "text-rose-400" : "text-slate-200";
  return (
    <div className="flex-1 min-w-[88px] text-center bg-slate-950/60 border border-slate-800 rounded-lg px-2 py-1.5">
      <div className="text-[10px] text-slate-500 uppercase tracking-wide truncate">{label}</div>
      <div className={`text-sm font-bold ${color}`}>{s.hits}/{s.n} <span className="text-[11px]">({pct}%)</span></div>
    </div>
  );
}
export function StatCard({ label, v, good }) {
  return <div className="bg-slate-900/70 border border-slate-800 rounded-xl px-3 py-3"><div className="text-[10px] text-slate-500 font-bold tracking-wide">{label}</div><div className={`text-xl font-black mt-0.5 ${good === true ? "text-emerald-400" : good === false ? "text-rose-400" : "text-slate-100"}`}>{v}</div></div>;
}
export function Sel({ label, v, opts, labels, onChange, compact }) {
  const sel = (
    <select value={v} onChange={(e) => onChange(e.target.value)} className={`bg-slate-950 border border-slate-700 rounded px-2 ${compact ? "py-1" : "py-1.5"} text-sm text-slate-100`}>
      {opts.map((o) => <option key={o} value={o}>{labels && labels[o] != null ? labels[o] : o}</option>)}
    </select>
  );
  if (compact) return <label className="text-xs text-slate-400 flex items-center gap-1.5 whitespace-nowrap">{label}{sel}</label>;
  return <label className="text-xs text-slate-400 flex flex-col gap-1">{label}{sel}</label>;
}
export function MultiSel({ label, selected, opts, labels, onChange, compact }) {
  const [open, setOpen] = useState(false);
  const toggle = (o) => onChange(selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o]);
  const lab = (o) => (labels && labels[o] != null ? labels[o] : o);
  const summary = selected.length === 0 ? "All" : selected.length === 1 ? lab(selected[0]) : `${selected.length} selected`;
  return (
    <div className="relative inline-block">
      <button onClick={() => setOpen((o) => !o)} className={`bg-slate-950 border rounded px-2 ${compact ? "py-1" : "py-1.5"} text-sm whitespace-nowrap ${selected.length ? "border-emerald-700 text-emerald-300" : "border-slate-700 text-slate-100"}`}>
        <span className="text-slate-400">{label}</span> {summary} ▾
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute z-40 mt-1 left-0 bg-slate-900 border border-slate-700 rounded-lg p-2 max-h-64 overflow-auto min-w-[170px] shadow-xl">
            {opts.length === 0 && <div className="text-[11px] text-slate-500 px-1 py-1">none yet</div>}
            {opts.map((o) => (
              <label key={o} className="flex items-center gap-2 px-1.5 py-1 text-sm cursor-pointer hover:bg-slate-800 rounded text-slate-200">
                <input type="checkbox" checked={selected.includes(o)} onChange={() => toggle(o)} className="accent-emerald-500" />
                <span className="truncate">{lab(o)}</span>
              </label>
            ))}
            {selected.length > 0 && <button onClick={() => onChange([])} className="mt-1 w-full text-[11px] text-slate-400 hover:text-rose-300 border-t border-slate-800 pt-1">clear</button>}
          </div>
        </>
      )}
    </div>
  );
}
export function NumIn({ label, v, onChange, placeholder }) {
  return (
    <label className="text-xs text-slate-400 flex flex-col gap-1">{label}
      <input value={v} placeholder={placeholder} inputMode="decimal" onChange={(e) => onChange(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-24 text-slate-100" />
    </label>
  );
}
