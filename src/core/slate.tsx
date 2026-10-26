/* Shared Slate pieces: slate navigation, status chip, score line, game subtitle and the expanded game
   panel. Every sport renders through these, so the Slate looks and behaves the same everywhere; a sport
   only supplies data (its slate keys, status vocabulary, period labels, and a `slateView` descriptor of
   what to show in the expanded game). */
import { useState } from "react";
import { pct, probToAmerican } from "./math";
import { Env, HotBadge, mono } from "./ui";

/* ---------------- slate navigation ---------------- */
// Every sport gets the same header control: ◂ [picker] ▸ [today]. The picker is the only thing a sport
// can swap (a date input by default, an NFL week dropdown), and it always occupies the same box.
export const PICKER_CLASS = "bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-sm text-slate-100 w-44";
const ymdLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export function DatePicker({ value, onChange }) {
  return <input type="date" value={value} onChange={(e) => e.target.value && onChange(e.target.value)} className={PICKER_CLASS} />;
}
export const DATE_SLATE = {
  unit: "date",
  initial: () => ymdLocal(new Date()),
  today: () => ymdLocal(new Date()),
  // shift by calendar day using Date's own rollover so month/year boundaries are handled for free
  shift: (k, n) => { const [y, m, d] = String(k).split("-").map(Number); const nd = new Date(y, (m || 1) - 1, d || 1); nd.setDate(nd.getDate() + n); return ymdLocal(nd); },
  season: (k) => String(k).slice(0, 4),
  order: (k) => k,
  label: (k) => k,
  Picker: DatePicker,
};

/* ---------------- status chip ---------------- */
// One vocabulary for every sport. Sport-specific "ready" states (lineups posted, probable goalies) all
// read the same way: the info the model needs is in.
export const STATUS = {
  POSTED: { t: "LINEUP POSTED", c: "bg-emerald-500 text-slate-950" },
  GOALIES: { t: "GOALIES PROBABLE", c: "bg-emerald-500 text-slate-950" },
  PARTIAL: { t: "PARTIAL", c: "bg-teal-600 text-white" },
  PENDING: { t: "PENDING · PROBABLES", c: "bg-amber-500 text-slate-950" },
  SCHEDULED: { t: "SCHEDULED", c: "bg-slate-700 text-slate-300" },
  LIVE: { t: "LIVE", c: "bg-rose-500 text-white" },
  FINAL: { t: "FINAL", c: "bg-slate-600 text-slate-200" },
  POSTPONED: { t: "POSTPONED", c: "bg-amber-600 text-slate-950" },
  MANUAL: { t: "MANUAL", c: "bg-violet-500 text-white" },
};
export function Chip({ s }) { const m = STATUS[s] || STATUS.SCHEDULED; return <span className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wide ${m.c}`}>{m.t}</span>; }

/* ---------------- score line + subtitle ---------------- */
// game = the sport's { liveLabel(g), finalSuffix(g), subtitle(g) }
export function ScoreLine({ g, game }) {
  const a = g.awayScore, h = g.homeScore;
  if (g.status === "FINAL") {
    return <div className="text-[12px] truncate" style={mono}><span className={a > h ? "text-slate-100 font-bold" : "text-slate-400"}>{g.away} {a}</span><span className="text-slate-600">, </span><span className={h > a ? "text-slate-100 font-bold" : "text-slate-400"}>{g.home} {h}</span><span className="text-slate-500"> · Final{game.finalSuffix(g) || ""}</span></div>;
  }
  return <div className="text-[12px] truncate" style={mono}><span className="text-slate-200">{g.away} {a}</span><span className="text-slate-600">, </span><span className="text-slate-200">{g.home} {h}</span><span className="text-rose-400"> · {game.liveLabel(g)}</span></div>;
}
export function GameSubtitle({ g, game }) {
  const rec = g.awayRec || g.homeRec ? ` · ${g.awayRec || "—"} / ${g.homeRec || "—"}` : "";
  return <div className="text-[11px] text-slate-500 truncate">{game.subtitle(g)}<span className="text-slate-600">{rec}</span></div>;
}

/* ---------------- expanded game panel ----------------
   view = sport.slateView(g, d):
   {
     env: [{ label, v, hot?, cold? }],                       // game-condition chips
     gameLine: { lambdaA, lambdaH, home, away, total, extra?: [[label, value]], note },
     sections: [ [Column, Column], ... ],                     // each section is a two-column row
   }
   Column = { title, legend?, empty?, rows: Row[], moreRows?: Row[] }
   Row = { id, idx?, tag?, tagWarn?, name, nameBadge?, badges?: Badge[], stat?, sub?, detail?: string[], hot?,
           player?: { id, name, ... } (opens Player Analysis), draft?: { kind, id, name } (manual bet "+") }
   Badge = { text, tone: "bad" | "warn" | "caution" | "good" | "info" | "muted", title? } */
const TONE = {
  bad: "bg-rose-600 text-white", warn: "bg-orange-600 text-white", caution: "bg-amber-600 text-white",
  good: "bg-emerald-900/50 text-emerald-300", info: "bg-sky-900/50 text-sky-300", muted: "bg-slate-800 text-slate-400",
};
export function Badge({ b }) {
  return <span className={`px-1 py-0.5 rounded text-[9px] font-bold shrink-0 ${TONE[b.tone] || TONE.muted}`} style={mono} title={b.title}>{b.text}</span>;
}
function Row({ r, onDraft, onAnalysis }) {
  const [exp, setExp] = useState(false);
  const canOpen = !!(r.player && onAnalysis);
  return (
    <div className="text-[12px]">
      <div className="flex items-center gap-2">
        {r.idx != null && <span className="text-slate-600 w-4 shrink-0" style={mono}>{r.idx}</span>}
        {r.detail && r.detail.length ? <button onClick={() => setExp((e) => !e)} className="text-slate-500 hover:text-slate-300 text-[10px] w-3 flex-shrink-0">{exp ? "▾" : "▸"}</button> : null}
        {r.tag != null && (
          <span className="w-9 text-[10px] text-slate-500 shrink-0 inline-flex items-center gap-0.5" style={mono}>
            {r.tag}{r.tagWarn && <span className="text-amber-500" title={r.tagWarn}>?</span>}
          </span>
        )}
        <button onClick={canOpen ? () => onAnalysis(r.player) : undefined} disabled={!canOpen} className={`flex-1 min-w-0 text-left truncate ${canOpen ? "hover:text-sky-300 cursor-pointer" : "cursor-default"}`} title={canOpen ? "Open player analysis" : undefined}>
          {r.name}{r.nameBadge && <span className={`ml-1 text-[9px] font-bold ${r.nameBadge.tone === "warn" ? "text-amber-400" : "text-emerald-400"}`}>{r.nameBadge.text}</span>}
        </button>
        {(r.badges || []).map((b, i) => <Badge key={i} b={b} />)}
        {r.stat != null && <span className="text-slate-400 text-[11px] shrink-0" style={mono}>{r.stat}</span>}
        {r.hot != null && <HotBadge delta={r.hot} />}
        {r.draft && onDraft ? <button onClick={() => onDraft(r.draft)} className="text-emerald-500 hover:text-emerald-300 font-bold w-5 text-center shrink-0" title="manual bet">+</button> : <span className="w-5 shrink-0" />}
      </div>
      {r.sub && <div className="text-[11px] text-slate-400 ml-0.5" style={mono}>{r.sub}</div>}
      {exp && r.detail && <div className="ml-7 mb-1 mt-0.5 text-[11px] text-slate-400 flex flex-wrap gap-x-2" style={mono}>{r.detail.map((x, i) => <span key={i}>{x}</span>)}</div>}
    </div>
  );
}
function Column({ c, onDraft, onAnalysis }) {
  const [more, setMore] = useState(false);
  const rows = more ? [...c.rows, ...(c.moreRows || [])] : c.rows;
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
      <div className="flex items-center justify-between mb-1.5 gap-2">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide">{c.title}</div>
        {c.legend && <div className="text-[9px] text-slate-600" style={mono}>{c.legend}</div>}
      </div>
      {!c.rows.length && <div className="text-[11px] text-slate-600 py-2">{c.empty || "— not available —"}</div>}
      <div className="space-y-0.5">{rows.map((r) => <Row key={r.id} r={r} onDraft={onDraft} onAnalysis={onAnalysis} />)}</div>
      {c.moreRows && c.moreRows.length > 0 && (
        <button onClick={() => setMore((v) => !v)} className="mt-1 text-[10px] text-slate-500 hover:text-slate-300">{more ? "show fewer" : `show all (${c.rows.length + c.moreRows.length})`}</button>
      )}
    </div>
  );
}
export function GameLineCard({ g, gl }) {
  return (
    <div className="mt-3 bg-slate-950/60 border border-slate-800 rounded-lg p-3">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">MODEL GAME LINE</div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[13px]" style={mono}>
        <span className="text-slate-300">proj score <b className="text-sky-300">{g.away} {gl.lambdaA.toFixed(1)} – {gl.lambdaH.toFixed(1)} {g.home}</b></span>
        <span>{g.home} <b className="text-emerald-400">{pct(gl.home)}</b> <span className="text-slate-600">({probToAmerican(gl.home)})</span></span>
        <span>{g.away} <b className="text-emerald-400">{pct(gl.away)}</b> <span className="text-slate-600">({probToAmerican(gl.away)})</span></span>
        <span>total <b className="text-sky-300">{gl.total.toFixed(1)}</b></span>
        {(gl.extra || []).map(([l, v]) => <span key={l} className="text-slate-500">{l} {v}</span>)}
      </div>
      {gl.note && <div className="text-[10px] text-slate-600 mt-1.5">{gl.note}</div>}
    </div>
  );
}
export function GameDetail({ g, view, onDraft, onAnalysis }) {
  return (
    <>
      {view.env && view.env.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-3 text-[11px]" style={mono}>
          {view.env.map((e) => <Env key={e.label} label={e.label} v={e.v} hot={e.hot} cold={e.cold} />)}
        </div>
      )}
      {view.gameLine && <GameLineCard g={g} gl={view.gameLine} />}
      {(view.sections || []).map((cols, i) => (
        <div key={i} className="grid sm:grid-cols-2 gap-3 mt-3">
          {cols.map((c) => <Column key={c.title} c={c} onDraft={onDraft} onAnalysis={onAnalysis} />)}
        </div>
      ))}
    </>
  );
}

/* injury / availability status -> the shared badge (same colors in every sport) */
export function injuryBadge(status) {
  if (!status) return null;
  const s = String(status).toUpperCase();
  const tone = s === "OUT" || s === "IR" || s === "SUSPENDED" ? "bad" : s === "DOUBTFUL" ? "warn" : "caution";
  return { text: s.replace(/_/g, " "), tone };
}
export function InjBadge({ status }) { const b = injuryBadge(status); return b ? <Badge b={b} /> : null; }
