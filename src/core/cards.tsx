/* Shared row/card components used by every sport's page (Board, Trends, My Bets).
   Sport-specific bits (which markets are game lines, the delta-signal thresholds) come in as props. */
import { useState } from "react";
import { fmtOdds, pct, profitUnits } from "./math";
import { TrendPill, mono, projMeta } from "./ui";

export function MathPanel({ r }) {
  const p = r.modelP, q = p != null ? 1 - p : null, isLive = r.calc && r.calc.live;
  const activeMults = (r.calc && r.calc.mults ? r.calc.mults : []).filter(([, v]) => Math.abs(Number(v) - 1) > 0.0005);
  const chain = isLive ? "live remaining-game projection" : (activeMults.length ? activeMults.map(([k, v]) => `${k} ${Number(v).toFixed(3)}`).join("  ×  ") : "neutral context");
  if (!r.calc || p == null) return null;
  return (
    <div className="border-t border-slate-800 px-4 py-2.5 text-[11px] text-slate-400 space-y-1" style={mono}>
      <div><span className="text-slate-500">1 · base</span> &nbsp;{r.calc.baseStr}</div>
      <div><span className="text-slate-500">2 · context</span> &nbsp;{chain}</div>
      {isLive && <div><span className="text-slate-500">live</span> &nbsp;have <span className="text-slate-200">{r.calc.live.current}</span> · {Math.round(r.calc.live.fr * 100)}% left · need {(parseFloat(r.line) - r.calc.live.current).toFixed(1)} more</div>}
      <div><span className="text-slate-500">3 · projection</span> &nbsp;{isLive ? "final" : "E"}[{r.type}] = <span className="text-sky-300">{r.proj != null ? r.proj.toFixed(2) : "—"}</span> &nbsp;→ {r.calc.dist}({r.calc.params})</div>
      <div><span className="text-slate-500">4 · model</span> &nbsp;P({r.side} {r.line}) = <span className="text-emerald-300">{pct(p)}</span> → fair {r.fair}</div>
      <div><span className="text-slate-500">5 · market</span> &nbsp;{fmtOdds(r.odds)} {r.devigged ? "(de-vigged" : "(raw"} {r.novig != null ? pct(r.novig) : "—"}{r.devigged ? ")" : ")"}, pays ${r.b.toFixed(2)}/$1</div>
      <div><span className="text-slate-500">6 · EV</span> &nbsp;= p·b − (1−p) = ({p.toFixed(3)})({r.b.toFixed(2)}) − ({q.toFixed(3)}) = <span className={r.ev >= 0 ? "text-emerald-300" : "text-rose-300"}>{r.ev >= 0 ? "+" : ""}{(r.ev * 100).toFixed(1)}%</span></div>
      <div className="text-slate-600">edge = model − {r.devigged ? "no-vig" : "implied"} = {r.edge >= 0 ? "+" : ""}{(r.edge * 100).toFixed(1)} pts</div>
    </div>
  );
}


export function BoardRow({ e, tracked, onTrack, showProjBar = true, isLineType, getDeltaSignal }) {
  const [show, setShow] = useState(false);
  const evGood = e.ev >= 0;
  const pm = !isLineType(e.type) ? projMeta(e.proj, e.line, e.side) : null;
  return (
    <div className="bg-slate-900/70 border border-slate-800 rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex-1 min-w-0">
          <div className="font-semibold truncate">{e.name} <span className="text-slate-500 text-xs">{e.game}</span></div>
          <div className="text-[11px] text-slate-400" style={mono}>
            {e.side} {e.line} {e.type} @ {fmtOdds(e.odds)} · <span className="text-sky-300">proj {e.proj != null ? e.proj.toFixed(2) : "—"}</span>
            {pm && <span className={`ml-1.5 font-bold ${pm.color}`}>{pm.delta >= 0 ? "+" : "−"}{Math.abs(pm.delta).toFixed(2)}</span>}
            {(() => { const sig = getDeltaSignal(e.type, e.proj, e.line); return sig ? <span className={`ml-1 ${sig === "strong" ? "text-emerald-400" : "text-yellow-400"}`}>●</span> : null; })()}
          </div>
        </div>
        <div className="text-right text-[11px]" style={mono}>
          <div className="text-slate-400">model {pct(e.modelP)} · fair {e.fair}</div>
          {(e.outsSanityFailed || e.suppressNote)
            ? <div className="text-amber-400 font-bold">⚠ {e.suppressNote || "stale IP data"} · edge suppressed</div>
            : <div className={evGood ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>EV {evGood ? "+" : ""}{(e.ev * 100).toFixed(1)}% · edge {e.edge >= 0 ? "+" : ""}{(e.edge * 100).toFixed(1)}%</div>
          }
        </div>
        <button onClick={() => setShow((s) => !s)} className="text-[11px] text-slate-500 hover:text-emerald-300 border border-slate-700 rounded px-2 py-1">{show ? "hide" : "math"}</button>
        <button onClick={onTrack} disabled={tracked} className={`text-[11px] font-bold rounded px-2 py-1 ${tracked ? "bg-slate-700 text-slate-400" : "bg-emerald-600 hover:bg-emerald-500 text-white"}`}>{tracked ? "tracked" : "track"}</button>
      </div>
      {pm && showProjBar && (
        <div className="relative h-1 mx-4 mb-2.5 bg-slate-800 rounded-full overflow-hidden" title={`proj ${e.proj != null ? e.proj.toFixed(2) : "—"} vs line ${e.line} · ${pm.delta >= 0 ? "clears" : "misses"} by ${Math.abs(pm.delta).toFixed(2)}`}>
          <div className="absolute inset-y-0 left-0" style={{ width: `${pm.projPct}%`, backgroundColor: pm.barColor }} />
          <div className="absolute inset-y-0 w-px bg-white/70" style={{ left: `${pm.linePct}%` }} />
        </div>
      )}
      {show && <MathPanel r={e} />}
    </div>
  );
}
export function TrendCard({ c, entry, tracked, onTrack }) {
  return (
    <div className="bg-slate-900/70 border border-slate-800 rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 flex-wrap">
        <div className="flex-1 min-w-[160px]">
          <div className="font-semibold truncate">{c.name} <span className="text-slate-500 text-xs">{c.game}</span></div>
          <div className="text-[11px] text-slate-400" style={mono}>
            {c.side} {c.line} {c.type}{c.odds != null ? ` @ ${fmtOdds(c.odds)}` : ""}
            <span className={`ml-1.5 ${c.sourced === "book" ? "text-sky-400" : "text-slate-500"}`}>{c.sourced === "book" ? "· book line" : "· model-free line"}</span>
          </div>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <TrendPill label="Recent Form" s={c.recentForm} />
          <TrendPill label={`vs ${c.opp || "OPP"}`} s={c.vsOpp} />
          <TrendPill label={c.isHome ? "Home" : "Away"} s={c.homeAway} />
        </div>
        {entry && (
          <button onClick={() => onTrack(entry)} disabled={tracked} className={`text-[11px] font-bold rounded px-2 py-1 ${tracked ? "bg-slate-700 text-slate-400" : "bg-emerald-600 hover:bg-emerald-500 text-white"}`}>{tracked ? "tracked" : "track"}</button>
        )}
      </div>
    </div>
  );
}
export function MyBetRow({ b, onOdds, onUnits, onRemove, isLineType }) {
  const stColor = { open: "bg-slate-700 text-slate-300", won: "bg-emerald-600 text-white", lost: "bg-rose-600 text-white", push: "bg-amber-600 text-slate-950", void: "bg-slate-600 text-slate-200" }[b.status];
  const profit = (b.status === "won" || b.status === "lost") ? profitUnits(b.status, Number(b.odds), b.units) : null;
  return (
    <div className="flex items-center gap-3 bg-slate-900/70 border border-slate-800 rounded-xl px-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="font-semibold truncate">{b.name} <span className="text-slate-500 text-xs">{b.game} · {b.book}</span></div>
        <div className="text-[11px] text-slate-400" style={mono}>
          {b.side} {b.line} {b.type}
          {b.proj != null ? <> · <span className="text-sky-300">proj {Number(b.proj).toFixed(2)}</span></> : ""}
          {(() => { const pm = !isLineType(b.type) && b.proj != null ? projMeta(b.proj, b.line, b.side) : null; if (!pm) return null; return <span className={`ml-1.5 font-bold ${pm.color}`}>{pm.delta >= 0 ? "+" : "−"}{Math.abs(pm.delta).toFixed(2)}</span>; })()}
          {b.actual != null ? <> · <span className="text-slate-300">actual {b.actual}</span></> : ""}
        </div>
        {b.currentOdds != null && (
          <div className="text-[11px]" style={mono} title={b.oddsCheckedAt ? `checked ${new Date(b.oddsCheckedAt).toLocaleTimeString()}` : ""}>
            <span className="text-slate-500">took {fmtOdds(Number(b.odds))} → {b.closing ? "close " : "now "}</span>
            <span className={b.clv != null && b.clv >= 0 ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>{fmtOdds(b.currentOdds)}</span>
            {b.clv != null && <span className={b.clv >= 0 ? "text-emerald-500" : "text-rose-500"}> ({b.clv >= 0 ? "+" : ""}{(b.clv * 100).toFixed(1)} {b.live ? "mov" : "CLV"})</span>}
          </div>
        )}
        {b.currentOdds == null && b.lineMissing && (
          <div className="text-[11px] text-amber-500/80" style={mono} title={b.oddsCheckedAt ? `checked ${new Date(b.oddsCheckedAt).toLocaleTimeString()}` : ""}>line not found (scratched, settled, or moved off your number)</div>
        )}
      </div>
      <label className="text-[10px] text-slate-500 flex flex-col items-end gap-0.5">odds
        <input value={b.odds} onChange={(e) => onOdds(e.target.value)} inputMode="numeric" className="w-16 bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-sm text-slate-100 text-right" />
      </label>
      <label className="text-[10px] text-slate-500 flex flex-col items-end gap-0.5">units
        <input value={b.units} onChange={(e) => onUnits(e.target.value)} inputMode="decimal" className="w-14 bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-sm text-slate-100 text-right" />
        {b.suggested > 0 && <span className="text-[9px] text-slate-600">sug {b.suggested}u</span>}
      </label>
      <div className="text-right text-[11px] w-28" style={mono}>
        {b.modelP != null ? <>
          <div className="text-slate-400">model {pct(b.modelP)}</div>
          <div className={b.ev >= 0 ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>EV {b.ev != null ? `${b.ev >= 0 ? "+" : ""}${(b.ev * 100).toFixed(1)}%` : "—"} · edge {b.edge != null ? `${b.edge >= 0 ? "+" : ""}${(b.edge * 100).toFixed(1)}%` : "—"}</div>
        </> : <div className="text-slate-600">manual</div>}
        {profit != null && <div className={profit >= 0 ? "text-emerald-400" : "text-rose-400"}>{profit >= 0 ? "+" : ""}{profit.toFixed(2)}u</div>}
      </div>
      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${stColor}`}>{b.status}</span>
      <button onClick={onRemove} className="text-slate-600 hover:text-rose-400 text-lg leading-none">×</button>
    </div>
  );
}
