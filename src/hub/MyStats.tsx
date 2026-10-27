/* Hub · My Stats: tracked-bet performance, filterable by sport. With one sport selected it is that
   sport's old Stats tab (the board log tools stay on the sport page). "All" adds a by-sport breakdown
   and labels each market with its sport; parlays count toward the totals with their own row.
   "Parlays" shows parlay results on their own, by leg count. */
import { useEffect, useMemo, useState } from "react";
import { Sel, StatCard, mono } from "../core/ui";
import { pct } from "../core/math";
import { betStats, betsCsv, downloadText } from "../core/bets";
import { BET_FILTER_LABELS, BET_FILTER_OPTS, HUB_SPORT, HUB_SPORTS } from "./sports";
import { parlayDate, parlayStats, parlaysCsv, syncParlayResults, useParlays } from "../parlay/store";
import { scopedBets, setSportBets, useHubBets } from "./useHubBets";
import { HubHeader, combinedStats, mergeOverall } from "./common";

const signed = (x, d = 2) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;

function RecordRow({ label, s }) {
  return (
    <div className="flex items-center gap-3 bg-slate-900/70 border border-slate-800 rounded-xl px-4 py-2.5 text-[12px]" style={mono}>
      <div className="flex-1 font-semibold">{label}</div>
      <div className="text-slate-400">{s.w}-{s.l}{s.ps ? `-${s.ps}` : ""}</div>
      <div className="text-slate-300 w-16 text-right">{s.winPct != null ? pct(s.winPct) : "—"}</div>
      <div className={`w-20 text-right font-bold ${s.net >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{signed(s.net)}u</div>
    </div>
  );
}

export default function MyStats({ active = true }) {
  const all = useHubBets();
  const parlays = useParlays();
  const [sportFilter, setSportFilter] = useState("all");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const onlyParlays = sportFilter === "parlays";
  const one = sportFilter !== "all" && !onlyParlays ? HUB_SPORT[sportFilter] : null;
  useEffect(() => { if (active) void syncParlayResults(HUB_SPORTS); }, [active]);
  const bets = useMemo(() => (onlyParlays ? [] : scopedBets(all, sportFilter)), [all, sportFilter]);
  const dates = useMemo(() => [...new Set([...bets.map((b) => b.date), ...(one ? [] : parlays.map(parlayDate))].filter(Boolean))].sort(), [bets, parlays, one]);
  const pStats = useMemo(() => parlayStats(parlays, { start, end }), [parlays, start, end]);
  const stats = useMemo(() => {
    if (one) return betStats(all[one.id], { start, end }, one.sport.config.STAT_ORDER);
    if (onlyParlays) return pStats;
    // All: singles by sport and market, plus parlays as their own sport row and "Parlays · N-leg" markets
    const c = combinedStats(all, { start, end });
    const byType = { ...c.byType }, typeOrder = [...c.typeOrder];
    for (const k of pStats.typeOrder) { byType[`Parlays · ${k}`] = pStats.byType[k]; typeOrder.push(`Parlays · ${k}`); }
    return { ...c, overall: mergeOverall(c.overall, pStats.overall), openCount: c.openCount + pStats.openCount, byType, typeOrder };
  }, [all, one, onlyParlays, pStats, start, end]);
  const typeOrder = one ? one.sport.config.STAT_ORDER : stats.typeOrder;
  const o = stats.overall;

  function exportCSV() {
    const stamp = new Date().toISOString().slice(0, 10);
    if (one) { downloadText(betsCsv(all[one.id], stats, typeOrder), `${one.sport.meta.csvPrefix}-${stamp}.csv`, "text/csv;charset=utf-8;"); return; }
    if (onlyParlays) { downloadText(parlaysCsv(parlays), `edge-finder-parlays-${stamp}.csv`, "text/csv;charset=utf-8;"); return; }
    downloadText(betsCsv(bets, stats, typeOrder, (b) => HUB_SPORT[b._sport].label) + (parlays.length ? `\n\nPARLAYS\n${parlaysCsv(parlays)}` : ""), `edge-finder-${stamp}.csv`, "text/csv;charset=utf-8;");
  }
  // clears one sport's bets (pick the sport first); never every sport at once
  function resetStats() {
    if (!one) return;
    if (!window.confirm(`Clear ALL tracked ${one.label} bets (open + settled)? This cannot be undone. Export a CSV first if you want a copy.`)) return;
    setSportBets(one.id, []);
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <div className="max-w-5xl mx-auto px-4 pb-28">
        <HubHeader title="MY" accent="STATS" sub="tracked-bet results · stake-weighted net & ROI · by sport and market" />
        <div className="mt-3">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <div className="flex items-center gap-3 flex-wrap">
              <Sel compact label="sport" v={sportFilter} opts={BET_FILTER_OPTS} labels={BET_FILTER_LABELS} onChange={setSportFilter} />
              <div className="text-[11px] text-slate-500" style={mono}>net & ROI are stake-weighted (units per bet) · flat-1u shown for comparison</div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={exportCSV} disabled={bets.length === 0 && (one || parlays.length === 0)} className="bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white font-bold text-xs rounded-lg px-3 py-1.5">Download CSV</button>
              <button onClick={resetStats} disabled={!one || bets.length === 0} title={one ? undefined : "Pick a sport to reset its stats (parlays are removed one at a time in My Bets)"} className="bg-slate-800 hover:bg-rose-700 disabled:opacity-40 border border-slate-700 text-slate-200 font-bold text-xs rounded-lg px-3 py-1.5">Reset stats</button>
            </div>
          </div>

          {/* Date range filter */}
          <div className="flex items-end gap-3 flex-wrap mb-4 p-2.5 rounded-lg bg-slate-900/40 border border-slate-800">
            <label className="text-xs text-slate-400 flex flex-col gap-1">start date
              <input type="date" value={start} min={dates[0] || ""} max={end || dates[dates.length - 1] || ""} onChange={(e) => setStart(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-100 w-36" />
            </label>
            <label className="text-xs text-slate-400 flex flex-col gap-1">end date
              <input type="date" value={end} min={start || dates[0] || ""} max={dates[dates.length - 1] || ""} onChange={(e) => setEnd(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-100 w-36" />
            </label>
            {(start || end) && (
              <button onClick={() => { setStart(""); setEnd(""); }} className="text-[11px] text-slate-400 hover:text-rose-300 border border-slate-700 rounded px-2.5 py-1.5">clear</button>
            )}
            <div className="text-[11px] text-slate-500 self-end pb-1.5" style={mono}>
              {start || end ? `${start || dates[0] || "…"} → ${end || dates[dates.length - 1] || "…"}` : "all time"}
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
            <StatCard label="Settled" v={o.n} />
            <StatCard label="Win %" v={o.winPct != null ? pct(o.winPct) : "—"} good={o.winPct != null && o.winPct >= 0.524} />
            <StatCard label="Net (units)" v={`${signed(o.net)}u`} good={o.net >= 0} />
            <StatCard label="ROI" v={o.roi != null ? `${signed(o.roi * 100, 1)}%` : "—"} good={o.roi != null && o.roi >= 0} />
          </div>
          <div className="text-[11px] text-slate-500 mb-3" style={mono}>
            record {o.w}-{o.l}{o.ps ? `-${o.ps}` : ""}{o.v ? ` · ${o.v} void` : ""} · {o.staked.toFixed(2)}u staked · {stats.openCount} open · break-even ≈ 52.4% at −110
          </div>
          <div className="text-[11px] mb-3 px-3 py-2 rounded-lg bg-slate-900/70 border border-slate-800" style={mono}>
            <span className="text-slate-500">strategy compare · </span>
            <span className="text-slate-300">staked: <span className={o.net >= 0 ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>{signed(o.net)}u</span> ({o.roi != null ? `${(o.roi * 100).toFixed(1)}%` : "—"} ROI)</span>
            <span className="text-slate-600"> vs </span>
            <span className="text-slate-300">flat 1u: <span className={o.flatNet >= 0 ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>{signed(o.flatNet)}u</span> ({o.flatRoi != null ? `${(o.flatRoi * 100).toFixed(1)}%` : "—"} ROI)</span>
          </div>
          {!one && !onlyParlays && stats.overall.n > 0 && (
            <div className="mb-4">
              <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1.5">BY SPORT</div>
              <div className="space-y-2">
                {HUB_SPORTS.filter((s) => stats.bySport[s.id].overall.n > 0).map((s) => <RecordRow key={s.id} label={`${s.icon} ${s.label}`} s={stats.bySport[s.id].overall} />)}
                {pStats.overall.n > 0 && <RecordRow label="🧩 Parlays" s={pStats.overall} />}
              </div>
            </div>
          )}
          {Object.keys(stats.byType).length === 0 ? (
            <div className="text-sm text-slate-500 py-8 text-center">{onlyParlays ? "No settled parlays yet. Track parlays in the Parlay Builder; their legs settle as each sport's results come in." : "No settled bets yet. Track bets, then hit “Settle finished” on My Bets after games end."}</div>
          ) : (
            <div>
              {!one && <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1.5">{onlyParlays ? "BY LEG COUNT" : "BY MARKET"}</div>}
              <div className="space-y-2">
                {typeOrder.filter((t) => stats.byType[t]).map((t) => <RecordRow key={t} label={t} s={stats.byType[t]} />)}
              </div>
            </div>
          )}
          <div className="mt-5 text-[11px] text-slate-600 leading-relaxed">
            Net/ROI use each bet’s unit stake; the flat-1u line shows what the same bets return at a flat stake, so you can see whether the ¼-Kelly suggestion actually beats flat. Kelly only helps if the model’s edges are real, so trust the comparison over many bets, not a handful. Once there’s a real sample, also compare win% by edge bucket to tune the priors (RECENT_WEIGHT, NB_PHI, shrinkage).
          </div>
        </div>
      </div>
    </div>
  );
}
