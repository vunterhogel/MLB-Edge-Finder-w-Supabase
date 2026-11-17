/* The Slate's expanded game panel, shared by every sport. A sport only supplies data:
     sport.game      = { subtitle(g), liveLabel(g), finalSuffix(g) }   text for the game row
     sport.slateView = (g, d) => view                                    what the expanded game shows
   view = {
     env: [{ label, v, hot?, cold? }],                                   game conditions
     gameLine: { lambdaA, lambdaH, home, away, total, note },             model game line
     sections: [[Column, Column], ...],                                   two-column rows
   }
   Column = lineup list:   { title, empty?, rows: Row[] }
          | starter card:  { starter: true, title, empty?, row: Row | null }
   Row = { id, idx?, name, chip?: { text, tone, title? }, chips?: [...], stat?, sub?, hot?, detail: [{ text, strong? }],
           player (opens the player page), draft: { kind, id, name } (manual bet "+") } */
import React, { useState } from "react";
import { LineChart as ChartIcon, Plus } from "lucide-react";
import { pct, probToAmerican } from "./math";
import { Badge, Btn, Expander, Stat, cap, cx } from "../ui/kit";

/* ---------------- game status, in plain words ---------------- */
export const STATUS = {
  POSTED: { t: "Lineups posted", k: "accent" },
  PARTIAL: { t: "Lineup partial", k: "warn" },
  PENDING: { t: "Lineups pending", k: "" },
  SCHEDULED: { t: "Scheduled", k: "" },
  LIVE: { t: "Live", k: "live" },
  FINAL: { t: "Final", k: "" },
  MANUAL: { t: "Manual", k: "line" },
};
export function Chip({ s }) { const m = STATUS[s] || STATUS.SCHEDULED; return <Badge kind={m.k}>{s === "LIVE" ? <span className="dot" /> : null}{m.t}</Badge>; }

// column headings for each sport's lineup stat line (the adapter's row.stat string, split on its separators)
const LINEUP_HEADERS = { mlb: ["AVG", "OPS"], nba: ["MIN", "PTS", "REB", "AST", "3PM"], nhl: ["GP", "G-A-P", "SOG", "TOI"] };
const TONE = { bad: "lost", good: "won", warn: "warn", muted: "" };
// injury / availability designation -> a row chip (used by the sport adapters)
export function injuryChip(status) {
  if (!status) return null;
  const s = String(status).toUpperCase();
  return { text: s.replace(/_/g, " "), tone: s === "OUT" || s === "IR" || s === "SUSPENDED" || s === "DOUBTFUL" ? "bad" : "warn" };
}
const nice = (t) => { const s = String(t); return s.length > 3 && s === s.toUpperCase() ? s[0] + s.slice(1).toLowerCase() : s; };

function PlayerRow({ r, heads, onDraft, onAnalysis }) {
  const [exp, setExp] = useState(false);
  const chips = [r.chip, ...(r.chips || [])].filter(Boolean);
  const parts = r.stat != null ? String(r.stat).split(/ · |\//) : [];
  const split = heads.length > 1 && parts.length === heads.length;
  return (<>
    <tr className={exp ? "open" : ""}>
      <td className="dim num" style={{ width: 28 }}>{r.idx}</td>
      <td>
        {r.player && onAnalysis ? <button type="button" className="name" title="Open player" onClick={() => onAnalysis(r.player)}>{r.name || "–"}</button> : <span className="name">{r.name || "–"}</span>}
        {chips.map((c, i) => <React.Fragment key={i}> <Badge kind={TONE[c.tone] || ""} title={c.title}>{nice(c.text)}</Badge></React.Fragment>)}
        {r.hot != null && r.hot > 0.08 ? <> <Badge kind="warn" title="Running hot against his season line">Hot</Badge></> : null}
        {r.hot != null && r.hot < -0.08 ? <> <Badge kind="accent" title="Running cold against his season line">Cold</Badge></> : null}
      </td>
      {split ? parts.map((v, i) => <td className="r num" key={i}>{v}</td>) : <td className="r num mid" colSpan={heads.length}>{r.stat != null ? r.stat : "–"}</td>}
      <td className="r" style={{ whiteSpace: "nowrap" }}>
        {(r.detail || []).length ? <Expander open={exp} onClick={() => setExp((x) => !x)} label="More on this player" /> : null}
        {r.player && onAnalysis ? <Btn sm icon kind="ghost" aria-label={`Open ${r.name}`} title="Open player" onClick={() => onAnalysis(r.player)}><ChartIcon /></Btn> : null}
        {r.draft ? <Btn sm icon kind="ghost" aria-label={`Add a manual bet on ${r.name}`} title="Add a manual bet" onClick={() => onDraft(r.draft)}><Plus /></Btn> : null}
      </td>
    </tr>
    {exp ? <tr className="detail"><td colSpan={heads.length + 3} style={{ padding: "2px 14px 10px 42px" }}><span className="note num">{(r.detail || []).map((d, i) => <span key={i} style={{ marginRight: 12, color: d.strong ? "var(--ink)" : undefined }}>{d.text}</span>)}</span></td></tr> : null}
  </>);
}
function LineupCol({ c, heads, onDraft, onAnalysis }) {
  return (
    <div className="lineup">
      <h4>{c.title}</h4>
      {c.rows.length === 0 ? <div className="note" style={{ padding: 14 }}>{c.empty || "Not posted yet."}</div> : (
        <table className="tbl inset tight">
          <thead><tr><th>#</th><th>Player</th>{heads.map((h) => <th className="r" key={h}>{h}</th>)}<th /></tr></thead>
          <tbody>{c.rows.map((r) => <PlayerRow key={r.id} r={r} heads={heads} onDraft={onDraft} onAnalysis={onAnalysis} />)}</tbody>
        </table>
      )}
    </div>
  );
}
function StarterCard({ c, onDraft, onAnalysis }) {
  const r = c.row;
  return (
    <div className="lineup">
      <h4>{c.title}</h4>
      <div className="row" style={{ padding: "10px 14px" }}>
        {!r ? <span className="dim">{c.empty || "To be announced"}</span> : (<>
          <div className="grow">
            {r.player && onAnalysis ? <button type="button" className="name" title="Open player" onClick={() => onAnalysis(r.player)}>{r.name}</button> : <span className="name">{r.name}</span>}
            {r.nameBadge ? <> <Badge kind="warn">{r.nameBadge}</Badge></> : null}
            <div className="note num">{r.sub || "–"}</div>
          </div>
          {r.draft ? <Btn sm icon kind="ghost" aria-label={`Add a manual bet on ${r.name}`} title="Add a manual bet" onClick={() => onDraft(r.draft)}><Plus /></Btn> : null}
        </>)}
      </div>
    </div>
  );
}
export function GameDetail({ g, view, sportId, statLabel = null, onDraft, onAnalysis }) {
  const gl = view.gameLine;
  const heads = statLabel ? String(statLabel).split(/ · |\//) : (LINEUP_HEADERS[sportId] || ["Recent"]);
  return (
    <>
      {(view.env || []).length ? <div className="envs">{view.env.map((e) => <span key={e.label}>{nice(e.label)}<b className={cx("num", e.hot && "warn", e.cold && "accent-t")}>{e.v}</b></span>)}</div> : null}
      {gl ? (<>
        <div className="stats" style={{ maxWidth: 820 }}>
          <Stat k="Projected score" v={<span className="num" style={{ fontSize: 19, whiteSpace: "nowrap" }}>{g.away} {gl.lambdaA.toFixed(1)}, {g.home} {gl.lambdaH.toFixed(1)}</span>} />
          <Stat k={`${g.home} win`} v={<span className="num">{pct(gl.home)}</span>} s={<span className="num">fair {probToAmerican(gl.home)}</span>} />
          <Stat k={`${g.away} win`} v={<span className="num">{pct(gl.away)}</span>} s={<span className="num">fair {probToAmerican(gl.away)}</span>} />
          <Stat k="Projected total" v={<span className="num">{gl.total.toFixed(1)}</span>} />
        </div>
        {gl.note ? <p className="note" style={{ maxWidth: 820 }}>{cap(String(gl.note).replace(/ — /g, ", "))}</p> : null}
      </>) : null}
      {(view.sections || []).map((cols, i) => (
        <div key={i} className="grid g2">
          {cols.map((c) => (c.starter ? <StarterCard key={c.title} c={c} onDraft={onDraft} onAnalysis={onAnalysis} /> : <LineupCol key={c.title} c={c} heads={heads} onDraft={onDraft} onAnalysis={onAnalysis} />))}
        </div>
      ))}
    </>
  );
}
