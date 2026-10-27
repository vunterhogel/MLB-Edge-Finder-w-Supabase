/* The MLB shell's Slate pieces (status chip, score line, game subtitle, expanded game panel), shared by every
   sport. The markup and behavior are MLB's; a sport only supplies data:
     sport.game      = { subtitle(g), liveLabel(g), finalSuffix(g) }   text for the game row
     sport.slateView = (g, d) => view                                    what the expanded game shows
   view = {
     env: [{ label, v, hot?, cold? }],                                   game-condition chips
     gameLine: { lambdaA, lambdaH, home, away, total, note },             MODEL GAME LINE card
     sections: [[Column, Column], ...],                                   two-column rows
   }
   Column = lineup list (MLB LineupCol):  { title, empty?, rows: Row[] }
          | starter card (MLB SPCard):    { starter: true, title, empty?, row: Row | null }
   Row = { id, idx?, name, chip?: { text, tone, title? }, chips?: [...], stat?, sub?, hot?, detail: [{ text, strong? }],
           player (opens Player Analysis), draft: { kind, id, name } (manual bet "+") } */
import { useState } from "react";
import { pct, probToAmerican } from "./math";
import { Env, HotBadge, mono } from "./ui";

/* ---------------- status chip (MLB vocabulary) ---------------- */
export const STATUS = {
  POSTED: { t: "LINEUP POSTED", c: "bg-emerald-500 text-slate-950" },
  PARTIAL: { t: "PARTIAL", c: "bg-teal-600 text-white" },
  PENDING: { t: "PENDING · PROBABLES", c: "bg-amber-500 text-slate-950" },
  SCHEDULED: { t: "NO DATA YET", c: "bg-slate-700 text-slate-300" },
  LIVE: { t: "LIVE", c: "bg-rose-500 text-white" },
  FINAL: { t: "FINAL", c: "bg-slate-600 text-slate-200" },
  MANUAL: { t: "MANUAL", c: "bg-violet-500 text-white" },
};
export function Chip({ s }) { const m = STATUS[s] || STATUS.SCHEDULED; return <span className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wide ${m.c}`}>{m.t}</span>; }

/* ---------------- game row text ---------------- */
export function ScoreLine({ g, game }) {
  const a = g.awayScore, h = g.homeScore;
  if (g.status === "FINAL") {
    return <div className="text-[12px] truncate" style={mono}><span className={a > h ? "text-slate-100 font-bold" : "text-slate-400"}>{g.away} {a}</span><span className="text-slate-600">, </span><span className={h > a ? "text-slate-100 font-bold" : "text-slate-400"}>{g.home} {h}</span><span className="text-slate-500"> · Final{game.finalSuffix(g) || ""}</span></div>;
  }
  return <div className="text-[12px] truncate" style={mono}><span className="text-slate-200">{g.away} {a}</span><span className="text-slate-600">, </span><span className="text-slate-200">{g.home} {h}</span><span className="text-rose-400"> · {game.liveLabel(g)}</span></div>;
}
export function GameSubtitle({ g, game }) {
  return <div className="text-[11px] text-slate-500 truncate">{game.subtitle(g)}</div>;
}

/* ---------------- row chips (MLB platoon-chip style) ---------------- */
const CHIP_TONE = { bad: "bg-rose-900/50 text-rose-300", good: "bg-emerald-900/50 text-emerald-300", warn: "bg-amber-900/50 text-amber-300", muted: "bg-slate-800 text-slate-400" };
function RowChip({ c }) { return <span className={`text-[9px] px-1 rounded ${CHIP_TONE[c.tone] || CHIP_TONE.muted}`} style={mono} title={c.title}>{c.text}</span>; }
// injury / availability designation -> a row chip
export function injuryChip(status) {
  if (!status) return null;
  const s = String(status).toUpperCase();
  return { text: s.replace(/_/g, " "), tone: s === "OUT" || s === "IR" || s === "SUSPENDED" || s === "DOUBTFUL" ? "bad" : "warn" };
}

/* ---------------- expanded game panel (MLB SlateDetail) ---------------- */
function PlayerRow({ r, onDraft, onAnalysis }) {
  const [exp, setExp] = useState(false);
  const onPlayerClick = r.player && onAnalysis ? () => onAnalysis(r.player) : null;
  const chips = [r.chip, ...(r.chips || [])].filter(Boolean);
  return (
    <div className="text-[12px]">
      <div className="flex items-center gap-2">
        <span className="text-slate-600 w-4" style={mono}>{r.idx}</span>
        <button onClick={() => setExp((e) => !e)} className="text-slate-500 hover:text-slate-300 text-[10px] w-3 flex-shrink-0">{exp ? "▾" : "▸"}</button>
        <button
          onClick={onPlayerClick || undefined}
          disabled={!onPlayerClick}
          className={`flex-1 text-left truncate ${onPlayerClick ? "hover:text-sky-300 cursor-pointer" : "cursor-default"}`}
          title={onPlayerClick ? "Open player analysis" : undefined}
        >{r.name || "—"}</button>
        {chips.map((c, i) => <RowChip key={i} c={c} />)}
        <span className="text-slate-400" style={mono}>{r.stat != null ? r.stat : "—"}</span>
        {r.hot != null && <HotBadge delta={r.hot} />}
        <button onClick={() => r.draft && onDraft(r.draft)} className="text-emerald-500 hover:text-emerald-300 font-bold w-5 text-center" title="manual bet">+</button>
      </div>
      {exp && (
        <div className="ml-7 mb-1 mt-0.5 text-[11px] text-slate-400" style={mono}>
          {(r.detail || []).map((d, i) => <span key={i} className={`${i ? "ml-2" : ""} ${d.strong ? "text-slate-300" : ""}`}>{d.text}</span>)}
        </div>
      )}
    </div>
  );
}
function LineupCol({ c, onDraft, onAnalysis }) {
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1.5">{c.title}</div>
      {c.rows.length === 0 && <div className="text-[11px] text-slate-600 py-2">{c.empty || "— not posted —"}</div>}
      <div className="space-y-0.5">{c.rows.map((r) => <PlayerRow key={r.id} r={r} onDraft={onDraft} onAnalysis={onAnalysis} />)}</div>
    </div>
  );
}
function StarterCard({ c, onDraft, onAnalysis }) {
  const r = c.row;
  const onPlayerClick = r && r.player && onAnalysis ? () => onAnalysis(r.player) : null;
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">{c.title}</div>
      {!r ? <div className="text-[11px] text-slate-600">{c.empty || "TBD"}</div> : (
        <div className="flex items-center justify-between">
          <div>
            <button
              onClick={onPlayerClick || undefined}
              disabled={!onPlayerClick}
              className={`text-[12px] font-semibold text-left ${onPlayerClick ? "hover:text-sky-300 cursor-pointer" : "cursor-default"}`}
              title={onPlayerClick ? "Open player analysis" : undefined}
            >
              {r.name}{r.nameBadge ? <span className="ml-1 text-[9px] text-amber-400 font-bold">{r.nameBadge}</span> : null}
            </button>
            <div className="text-[11px] text-slate-400" style={mono}>{r.sub || "—"}</div>
          </div>
          <button onClick={() => r.draft && onDraft(r.draft)} className="text-emerald-500 hover:text-emerald-300 font-bold text-lg" title="manual bet">+</button>
        </div>
      )}
    </div>
  );
}
export function GameDetail({ g, view, onDraft, onAnalysis }) {
  const gl = view.gameLine;
  return (
    <>
      <div className="flex flex-wrap gap-2 mt-3 text-[11px]" style={mono}>
        {(view.env || []).map((e) => <Env key={e.label} label={e.label} v={e.v} hot={e.hot} cold={e.cold} />)}
      </div>
      <div className="mt-3 bg-slate-950/60 border border-slate-800 rounded-lg p-3">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">MODEL GAME LINE</div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[13px]" style={mono}>
          <span className="text-slate-300">proj score <b className="text-sky-300">{g.away} {gl.lambdaA.toFixed(1)} – {gl.lambdaH.toFixed(1)} {g.home}</b></span>
          <span>{g.home} <b className="text-emerald-400">{pct(gl.home)}</b> <span className="text-slate-600">({probToAmerican(gl.home)})</span></span>
          <span>{g.away} <b className="text-emerald-400">{pct(gl.away)}</b> <span className="text-slate-600">({probToAmerican(gl.away)})</span></span>
          <span>total <b className="text-sky-300">{gl.total.toFixed(1)}</b></span>
        </div>
        <div className="text-[10px] text-slate-600 mt-1.5">{gl.note}</div>
      </div>
      {(view.sections || []).map((cols, i) => (
        <div key={i} className="grid sm:grid-cols-2 gap-3 mt-3">
          {cols.map((c) => (c.starter ? <StarterCard key={c.title} c={c} onDraft={onDraft} onAnalysis={onAnalysis} /> : <LineupCol key={c.title} c={c} onDraft={onDraft} onAnalysis={onAnalysis} />))}
        </div>
      ))}
    </>
  );
}
