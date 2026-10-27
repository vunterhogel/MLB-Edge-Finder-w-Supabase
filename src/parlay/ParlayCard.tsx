/* Parlay cards shared by the Parlay Builder and Hub My Bets. */
import { mono } from "../core/ui";
import { fmtOdds, fmtPct } from "./model";
import { parlayDate, parlayProfitUnits, removeParlay, setLegResult, setParlayUnits, unitsOf } from "./store";

const SPORT_ICON = { mlb: "⚾", nfl: "🏈", nba: "🏀", nhl: "🏒" };

export function ResultBadge({ result }) {
  if (!result) return <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">open</span>;
  const map = { won: "bg-emerald-600 text-white", lost: "bg-rose-600 text-white", push: "bg-amber-600 text-slate-950", void: "bg-slate-600 text-slate-200" };
  return <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${map[result] || "bg-slate-700 text-slate-200"}`}>{result}</span>;
}

// one leg, bet-slip style: sport, player / game, market line side, odds, and an optional right slot
export function LegRow({ leg, index, right = null, sub = null }) {
  return (
    <div className={`flex items-center gap-2.5 px-2.5 py-1.5 ${index > 0 ? "border-t border-slate-800" : ""} bg-slate-900/60`}>
      <span className="w-5 text-center shrink-0" title={String(leg.sport).toUpperCase()}>{SPORT_ICON[leg.sport] || String(leg.sport).toUpperCase()}</span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold text-slate-100 truncate">{leg.name || leg.game}</div>
        <div className="text-[11px] text-slate-500 truncate">{leg.game && leg.name ? `${leg.game} · ` : ""}{leg.type} {leg.line} <span className="uppercase text-slate-400">{leg.side}</span>{sub}</div>
      </div>
      <span className="text-sm font-bold shrink-0" style={mono}>{fmtOdds(leg.odds)}</span>
      {right}
    </div>
  );
}

// combined numbers line for a parlay or candidate
export function ParlayNumbers({ legs, american, modelP, edge, ev, sgp }) {
  return (
    <>
      <span className="font-bold">{legs} legs</span>
      <span style={mono}>{fmtOdds(american)}</span>
      <span className="text-slate-400">model {fmtPct(modelP)}</span>
      <span className={edge > 0 ? "text-emerald-400" : "text-rose-400"}>edge {fmtPct(edge)}</span>
      <span className={`font-bold ${ev > 0 ? "text-emerald-400" : "text-rose-400"}`}>EV {fmtPct(ev)}</span>
      {sgp && <span className="text-amber-400 font-bold text-xs" title="Same-game legs are correlated, so the combined EV is optimistic">SGP</span>}
    </>
  );
}

// a tracked parlay: status, combined numbers as built, units, profit, legs with results + manual override
export function TrackedParlay({ p }) {
  const units = unitsOf(p);
  const profit = parlayProfitUnits(p.status, p.legs, units);
  return (
    <div className="p-2.5 rounded-xl bg-slate-900/70 border border-slate-800">
      <div className="flex flex-wrap items-center gap-3 text-sm mb-1.5">
        <span className="text-base" title="Parlay">🧩</span>
        <ResultBadge result={p.status === "open" ? null : p.status} />
        <ParlayNumbers legs={p.legs.length} american={p.builtAmerican} modelP={p.builtModelP} edge={p.builtEdge} ev={p.builtEV} sgp={p.sgp} />
        {p.status !== "open" && <span className={`font-bold ${profit > 0 ? "text-emerald-400" : profit < 0 ? "text-rose-400" : "text-slate-400"}`} style={mono}>{profit >= 0 ? "+" : ""}{profit.toFixed(2)}u</span>}
        <span className="ml-auto flex items-center gap-2">
          <label className="text-[10px] text-slate-500 flex items-center gap-1">units
            <input value={p.units ?? 1} onChange={(e) => setParlayUnits(p.id, e.target.value)} inputMode="decimal" className="w-12 bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-100" style={mono} />
          </label>
          <span className="text-[10px] text-slate-500" title={`built ${new Date(p.builtAt).toLocaleString()}`}>{parlayDate(p)}</span>
          <button onClick={() => { if (window.confirm("Remove this tracked parlay? This cannot be undone.")) removeParlay(p.id); }} className="text-slate-600 hover:text-rose-400 text-lg leading-none" title="Remove">×</button>
        </span>
      </div>
      <div className="rounded-lg border border-slate-800 overflow-hidden">
        {p.legs.map((l, j) => (
          <LegRow key={j} leg={l} index={j}
            sub={l.actualStat != null ? <span className="text-slate-500"> · actual {l.actualStat}</span> : null}
            right={
              <div className="flex items-center gap-1.5 shrink-0">
                <ResultBadge result={l.result} />
                {l.manual && <button onClick={() => setLegResult(p.id, j, null)} className="text-[9px] text-slate-500 hover:text-slate-300" title="Clear the result you set by hand; automatic settlement fills it again">reset</button>}
                {!l.result && (
                  <div className="flex gap-1">
                    {["won", "lost", "push", "void"].map((r) => (
                      <button key={r} onClick={() => setLegResult(p.id, j, r)} className="text-[9px] px-1.5 py-0.5 rounded border border-slate-700 hover:border-slate-400 text-slate-300" title="Set this leg's result by hand">{r}</button>
                    ))}
                  </div>
                )}
              </div>
            } />
        ))}
      </div>
    </div>
  );
}
