/* Shared Player Analysis page: MLB's layout and behavior, for every sport.
   A sport supplies only data, through sport.playerView({ profile, spot, detail, projections }):
   {
     headshot: url | null,
     subtitle: "team · position · ...",
     metrics: [[label, value, good?], x4],                     // headline stat tiles
     cards: [Card, Card, Card],                                  // slate matchup · season baseline · advanced
     form: { title, table: { cols, rows }, cats: [Cat], games: [Game] },   // recent windows + hit chart
     splits: { title, panels: [{ label, sub?, headline?, lines: [[label, value]] }], empty? },
     log: { title, cols, rows: [[...]], empty? },
   }
   Card = { title, headline?: { text, tone }, note?, lines?: [string | { text, tone }], grid?: [[label, value, tone?]], empty? }
   Cat  = { key, label, projType, defaultLine, fmt?(v), fmtLine?(l) }   // chart stat; projType links the model line
   Game = { date, opp, homeAway, v: { [catKey]: number } }                // newest first */
import { useMemo, useState } from "react";
import { pct } from "./math";
import { mono, projMeta } from "./ui";
import { BoardRow } from "./cards";
import { Chip } from "./slate";

const TONE_TEXT = { sky: "text-sky-300", good: "text-emerald-400", bad: "text-rose-400", warn: "text-amber-400", muted: "text-slate-500", default: "text-slate-200" };

export function MiniMetric({ label, value, good }) {
  return <div className="bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2"><div className="text-[9px] text-slate-500 font-bold tracking-wide">{label}</div><div className={`text-lg font-black ${good === true ? "text-emerald-400" : good === false ? "text-rose-400" : "text-slate-100"}`}>{value}</div></div>;
}
function InfoCard({ c }) {
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">{c.title}</div>
      {c.empty ? <div className="text-sm text-slate-500">{c.empty}</div> : (
        <>
          {c.headline && <div className={`text-sm font-bold ${TONE_TEXT[c.headline.tone] || "text-slate-100"}`}>{c.headline.text}</div>}
          {c.note && (c.grid && c.grid.length
            ? <div className="text-[10px] text-slate-600 mb-2" style={mono}>{c.note}</div>
            : <div className="text-[11px] text-slate-500 mt-1" style={mono}>{c.note}</div>)}
          {c.lines && c.lines.length > 0 && (
            <div className="mt-2 space-y-1 text-[11px]" style={mono}>
              {c.lines.map((l, i) => { const o = typeof l === "string" ? { text: l } : l; return <div key={i} className={TONE_TEXT[o.tone] || "text-slate-400"}>{o.text}</div>; })}
            </div>
          )}
          {c.grid && c.grid.length > 0 && (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]" style={mono}>
              {c.grid.map(([l, v, tone]) => <span key={l} className="text-slate-500">{l} <b className={TONE_TEXT[tone] || TONE_TEXT.default}>{v == null ? "—" : v}</b></span>)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
function AnalysisProjectionRow({ r }) {
  const pm = projMeta(r.proj, r.line, "over");
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-bold">{r.type} <span className="text-slate-500 text-xs">line {r.line}</span></div>
          <div className="text-[11px] text-slate-500" style={mono}>proj <span className="text-sky-300">{r.proj != null ? r.proj.toFixed(2) : "—"}</span>{pm && <span className={`ml-1 ${pm.color}`}>vs line {pm.delta >= 0 ? "+" : "−"}{Math.abs(pm.delta).toFixed(2)}</span>}</div>
        </div>
        <div className="text-right text-[11px]" style={mono}>
          <div>Over <b className="text-emerald-300">{pct(r.overP)}</b> <span className="text-slate-600">{r.overFair}</span></div>
          <div>Under <b className="text-sky-300">{pct(r.underP)}</b> <span className="text-slate-600">{r.underFair}</span></div>
        </div>
      </div>
    </div>
  );
}
function Table({ cols, rows, left = 1 }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]" style={mono}>
        <thead className="text-slate-600"><tr>{cols.map((h, i) => <th key={`${h}-${i}`} className={`font-semibold py-1 ${i < left ? "text-left" : "text-right"}`}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-slate-800/80">
              {r.map((v, j) => <td key={j} className={`${j === 0 ? "py-1" : ""} ${j < left ? "text-left text-slate-400" : "text-right text-slate-200"}`}>{v == null ? "—" : v}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function FormCard({ form, projections, boardEntries }) {
  const cats = form.cats || [];
  const [win, setWin] = useState(20);
  const [catKey, setCatKey] = useState(cats.length ? cats[0].key : null);
  const [lineMode, setLineMode] = useState("model");
  const cat = cats.find((c) => c.key === catKey) || cats[0];
  const fmt = (v) => (cat && cat.fmt ? cat.fmt(v) : (Number.isInteger(v) ? String(v) : Number(v).toFixed(1)));
  const fmtLineLabel = (l) => (cat && cat.fmtLine ? cat.fmtLine(l) : (typeof l === "number" && !Number.isInteger(l) ? l.toFixed(2) : String(l)));
  const fmtLineShort = (l) => (cat && cat.fmt ? cat.fmt(Math.round(l)) : String(l));
  // model line = this matchup's projection for the stat; market line = the loaded board line
  const modelLine = (() => {
    if (!cat) return 0;
    const p = cat.projType && projections ? projections.find((x) => x.type === cat.projType) : null;
    return p && p.proj != null ? +p.proj.toFixed(2) : cat.defaultLine;
  })();
  const actualLine = (() => {
    if (!cat || !cat.projType || !boardEntries || !boardEntries.length) return null;
    const e = boardEntries.find((x) => x.type === cat.projType);
    return e ? parseFloat(String(e.line)) : null;
  })();
  const hasActual = actualLine != null;
  const effectiveMode = lineMode === "actual" && hasActual ? "actual" : "model";
  const activeLine = effectiveMode === "actual" ? actualLine : modelLine;
  const barVals = (form.games || []).slice(0, win).reverse().map((x) => ({ raw: cat ? (x.v[cat.key] ?? 0) : 0, date: x.date || "", opp: x.opp || "", homeAway: x.homeAway || "" }));
  const n = barVals.length;
  const hitCount = barVals.filter((b) => b.raw >= activeLine).length;
  const maxVal = Math.max(activeLine * 1.7, ...barVals.map((b) => b.raw), 1);
  const W = 460, H = 120, padL = 28, padR = 6, padT = 14, padB = 22;
  const chartW = W - padL - padR, chartH = H - padT - padB;
  const xOf = (i) => padL + (i + 0.5) * (chartW / Math.max(n, 1));
  const yOf = (v) => padT + chartH - Math.min((v / maxVal) * chartH, chartH);
  const barW = Math.max(4, (chartW / Math.max(n, 1)) * 0.65);
  const lineY = yOf(activeLine);
  const lineStroke = effectiveMode === "actual" ? "#7dd3fc" : "#64748b";
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">{form.title.toUpperCase()}</div>
      {form.table && form.table.rows.length ? <Table cols={form.table.cols} rows={form.table.rows} /> : <div className="text-sm text-slate-500">No recent games.</div>}
      {cat && (
        <div className="mt-3 border-t border-slate-800 pt-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-slate-600 font-bold tracking-wide">WINDOW</span>
              {[5, 10, 20].map((w) => <button key={w} onClick={() => setWin(w)} className={`text-[10px] px-2 py-0.5 rounded border ${win === w ? "border-sky-700 text-sky-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`}>L{w}</button>)}
            </div>
            <div className="flex items-center gap-1.5">
              {n > 0 && <span className={`text-[12px] font-black ${hitCount / n >= 0.65 ? "text-emerald-400" : hitCount / n >= 0.45 ? "text-amber-400" : "text-rose-400"}`} style={mono}>{hitCount}/{n}</span>}
              {hasActual && (
                <div className="flex gap-1 ml-2">
                  <button onClick={() => setLineMode("model")} className={`text-[10px] px-2 py-0.5 rounded border ${effectiveMode === "model" ? "border-slate-500 text-slate-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`}>proj</button>
                  <button onClick={() => setLineMode("actual")} className={`text-[10px] px-2 py-0.5 rounded border ${effectiveMode === "actual" ? "border-sky-600 text-sky-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`}>mkt line</button>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[9px] text-slate-600 font-bold tracking-wide">STAT</span>
              {cats.map((c) => <button key={c.key} onClick={() => setCatKey(c.key)} className={`text-[10px] px-2 py-0.5 rounded border ${cat.key === c.key ? "border-emerald-700 text-emerald-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`}>{c.label}</button>)}
            </div>
            <span className="text-[10px] text-slate-500 shrink-0" style={mono}>{effectiveMode === "actual" ? <span className="text-sky-400">mkt </span> : <span className="text-slate-600">proj </span>}{fmtLineLabel(activeLine)}</span>
          </div>
          {n === 0 ? <div className="text-[11px] text-slate-600 text-center py-3">No game log data available</div> : (
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
              <line x1={padL} y1={padT} x2={padL} y2={padT + chartH} stroke="#1e293b" strokeWidth="1.5" />
              <text x={padL - 3} y={lineY + 3.5} fontSize="8" fill={lineStroke} textAnchor="end" fontFamily="ui-monospace,monospace">{fmtLineShort(activeLine)}</text>
              <line x1={padL} y1={lineY} x2={W - padR} y2={lineY} stroke={lineStroke} strokeWidth="1" strokeDasharray="4,3" />
              {barVals.map((b, i) => {
                const x = xOf(i), hit = b.raw >= activeLine;
                const barH = Math.max(2, (Math.min(b.raw, maxVal) / maxVal) * chartH), y = padT + chartH - barH;
                const dv = fmt(b.raw);
                return (
                  <g key={i}>
                    <rect x={x - barW / 2} y={y} width={barW} height={barH} fill={hit ? "#34d399" : "#f87171"} rx="2" opacity="0.85"><title>{b.date} {b.homeAway} {b.opp}: {dv}</title></rect>
                    <text x={x} y={y - 2} fontSize="7.5" fill={hit ? "#86efac" : "#fca5a5"} textAnchor="middle" fontFamily="ui-monospace,monospace">{dv}</text>
                    {n <= 10 && <text x={x} y={H - 4} fontSize="7" fill="#475569" textAnchor="middle" fontFamily="ui-monospace,monospace">{b.opp}</text>}
                  </g>
                );
              })}
            </svg>
          )}
        </div>
      )}
    </div>
  );
}
function SplitsCard({ splits }) {
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">{splits.title.toUpperCase()}</div>
      {!splits.panels || !splits.panels.length ? <div className="text-sm text-slate-500">{splits.empty || "No split data returned."}</div> : (
        <div className="grid grid-cols-2 gap-2">
          {splits.panels.map((s) => (
            <div key={s.label} className="bg-slate-950/60 border border-slate-800 rounded-lg p-2">
              <div className="text-[10px] text-slate-500 font-bold mb-1">{s.label}{s.sub ? <span className="text-slate-600 font-normal"> · {s.sub}</span> : ""}</div>
              {s.lines ? (
                <div className="space-y-0.5 text-[11px]" style={mono}>
                  {s.headline && <div className="text-sky-300 font-bold">{s.headline}</div>}
                  {s.lines.map((row, i) => (
                    <div key={i}>{row.map(([l, v], j) => <span key={l}>{j > 0 && <span className="text-slate-600"> · </span>}<span className="text-slate-500">{l} </span><span className="text-slate-200">{v == null ? "—" : v}</span></span>)}</div>
                  ))}
                </div>
              ) : <div className="text-slate-600 text-[11px]">—</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function GameLogCard({ log }) {
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">{log.title.toUpperCase()}</div>
      {!log.rows.length ? <div className="text-sm text-slate-500">{log.empty || "No game log returned."}</div> : <Table cols={log.cols} rows={log.rows} left={2} />}
    </div>
  );
}

// intro = the sport's text: { file, fileSub, slate(games) -> string, slateSub } (MLB's three intro cards)
export function PlayerAnalysisIntro({ games, boardCount, intro }) {
  return (
    <div className="grid sm:grid-cols-3 gap-3">
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">PLAYER FILE</div>
        <div className="text-sm text-slate-300">{intro.file}</div>
        <div className="text-[11px] text-slate-600 mt-2" style={mono}>{intro.fileSub}</div>
      </div>
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">SLATE CONTEXT</div>
        <div className="text-sm text-slate-300">{intro.slate(games || [])}</div>
        <div className="text-[11px] text-slate-600 mt-2" style={mono}>{intro.slateSub}</div>
      </div>
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">MARKET CONTEXT</div>
        <div className="text-sm text-slate-300">{boardCount} board candidate(s) loaded.</div>
        <div className="text-[11px] text-slate-600 mt-2" style={mono}>odds · no-vig · edge · EV</div>
      </div>
    </div>
  );
}

export function PlayerAnalysis({ view, profile, spot, detail, projections, boardEntries, boardGameCount, book, oddsLoading, oddsReady, onFetchOdds, myBets, onTrack, showProjBar, rowCfg }) {
  const p = profile.player;
  const hasSlate = !!spot;
  const slateReady = hasSlate && detail && detail.ready;
  const canFetchOdds = hasSlate && spot.game && !spot.game.manual && spot.game.status !== "FINAL";
  const [mktSort, setMktSort] = useState("ev_desc");
  const sortedMkts = useMemo(() => {
    const getDelta = (e) => (e.proj ?? 0) - parseFloat(e.line ?? 0);
    const cmps = {
      ev_desc: (a, b) => (b.ev ?? -9) - (a.ev ?? -9),
      proj_desc: (a, b) => (b.proj ?? -9) - (a.proj ?? -9),
      edge_desc: (a, b) => (b.edge ?? -9) - (a.edge ?? -9),
      delta_desc: (a, b) => getDelta(b) - getDelta(a),
      type: (a, b) => (a.type || "").localeCompare(b.type || ""),
    };
    return cmps[mktSort] ? [...boardEntries].sort(cmps[mktSort]) : boardEntries;
  }, [boardEntries, mktSort]);
  return (
    <div className="space-y-3">
      <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-start gap-3">
            {view.headshot && <img src={view.headshot} alt="" className="w-16 h-16 rounded-xl object-cover border border-slate-700 bg-slate-800 flex-shrink-0" onError={(e) => { e.currentTarget.style.display = "none"; }} />}
            <div>
              <div className="text-2xl font-black tracking-tight">{p.name}</div>
              <div className="text-[11px] text-slate-500 mt-1" style={mono}>{view.subtitle}</div>
            </div>
          </div>
          {hasSlate ? <Chip s={spot.game.status} /> : <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-400">NOT ON SELECTED SLATE</span>}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
          {(view.metrics || []).map(([label, value, good]) => <MiniMetric key={label} label={label} value={value == null ? "—" : value} good={good} />)}
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-3">{(view.cards || []).map((c) => <InfoCard key={c.title} c={c} />)}</div>

      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
        <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
          <div>
            <div className="text-xs font-bold text-slate-300">Model Projections</div>
            <div className="text-[11px] text-slate-500" style={mono}>{hasSlate ? (slateReady ? "using selected-slate matchup context" : "loading selected-slate context") : "available when player is in the selected slate"}</div>
          </div>
          {canFetchOdds && (
            oddsReady ? (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-emerald-500" style={mono}>✓ odds loaded</span>
                <button onClick={onFetchOdds} disabled={oddsLoading === spot.game.pk} className="text-[10px] text-slate-500 hover:text-slate-300 border border-slate-700 rounded px-2 py-1 disabled:opacity-40" title="Re-fetch odds for this game">{oddsLoading === spot.game.pk ? "…" : "↺ refresh"}</button>
              </div>
            ) : (
              <button onClick={onFetchOdds} disabled={oddsLoading === spot.game.pk} className="bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white font-bold text-xs rounded-lg px-3 py-1.5">{oddsLoading === spot.game.pk ? "…" : `Get ${book} odds`}</button>
            )
          )}
        </div>
        {!hasSlate ? <div className="text-sm text-slate-500 py-5 text-center">No matchup on the selected date. Change the date if you want same-day projections.</div>
          : !slateReady ? <div className="text-sm text-slate-500 py-5 text-center" style={mono}>loading matchup detail…</div>
          : <div className="grid sm:grid-cols-2 gap-2">{projections.map((r) => <AnalysisProjectionRow key={r.type} r={r} />)}</div>}
      </div>

      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
        <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
          <div>
            <div className="text-xs font-bold text-slate-300">Current Board Markets</div>
            <div className="text-[11px] text-slate-500" style={mono}>{boardEntries.length ? `${boardEntries.length} priced player market(s) loaded` : boardGameCount ? "game odds loaded, no matched player markets" : "pull odds from Slate or this profile to populate market rows"}</div>
          </div>
          {boardEntries.length > 1 && (
            <div className="flex gap-1">
              {[["ev_desc", "EV"], ["proj_desc", "Proj"], ["edge_desc", "Edge"], ["delta_desc", "Δ"], ["type", "Type"]].map(([k, l]) => (
                <button key={k} onClick={() => setMktSort(k)} className={`text-[10px] px-2 py-1 rounded border ${mktSort === k ? "border-sky-700 text-sky-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`}>{l}</button>
              ))}
            </div>
          )}
        </div>
        {sortedMkts.length ? (
          <div className="space-y-2">{sortedMkts.map((e) => <BoardRow key={e.id} {...rowCfg} e={e} tracked={myBets.some((b) => b.key === e.id)} onTrack={() => onTrack(e)} showProjBar={showProjBar} />)}</div>
        ) : <div className="text-sm text-slate-500 py-5 text-center">No player-specific odds rows loaded yet.</div>}
      </div>

      <div className="grid lg:grid-cols-2 gap-3">
        {view.form && <FormCard form={view.form} projections={projections} boardEntries={boardEntries} />}
        <div className="space-y-3">
          {view.splits && <SplitsCard splits={view.splits} />}
          {view.log && <GameLogCard log={view.log} />}
        </div>
      </div>
    </div>
  );
}
