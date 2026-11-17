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
import { Plus } from "lucide-react";
import { pct, probToAmerican } from "./math";
import { Badge, Btn, Expander, Team, cap, cx, fOdds } from "../ui/kit";

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
// "PHX REST" -> "PHX rest", "PARK RF" -> "Park RF": team codes and short stat codes keep their capitals
function labelCase(t, g) {
  return String(t).split(" ").map((w, i) => {
    if (w !== w.toUpperCase() || w === g.away || w === g.home || (i > 0 && w.length <= 3)) return w;
    return i === 0 ? w[0] + w.slice(1).toLowerCase() : w.toLowerCase();
  }).join(" ");
}
const nice = (t) => { const s = String(t); return s.length > 3 && s === s.toUpperCase() ? s[0] + s.slice(1).toLowerCase() : s; };
const ROLE = { "(away)": "Away lineup", "(home)": "Home lineup", SP: "Starting pitcher", G: "Starting goalie", goalie: "Starting goalie" };
// "PHX (away)" -> team tile + "Away lineup"; anything else falls back to the plain title
function ColTitle({ title, g, sportId, right = null }) {
  const [first, ...rest] = String(title).split(" ");
  const isTeam = first === g.away || first === g.home, tail = rest.join(" ");
  return <h4>{isTeam ? <Team sport={sportId} ab={first} /> : null}<span>{isTeam ? (ROLE[tail] || cap(tail.replace(/[()]/g, ""))) : title}</span>{right ? <small>{right}</small> : null}</h4>;
}

function PlayerRow({ r, heads, split, onDraft, onAnalysis }) {
  const [exp, setExp] = useState(false);
  const chips = [r.chip, ...(r.chips || [])].filter(Boolean);
  const parts = r.stat != null ? String(r.stat).split(/ · |\//) : [];
  const fits = split && parts.length === heads.length;
  const hasDetail = (r.detail || []).length > 0;
  return (<>
    <tr className={exp ? "open" : ""}>
      <td className="dim num">{r.idx}</td>
      <td title={r.name || undefined}>
        {r.player && onAnalysis ? <button type="button" className="name" title="Open this player" onClick={() => onAnalysis(r.player)}>{r.name || "–"}</button> : <span className="name">{r.name || "–"}</span>}
        {chips.map((c, i) => <React.Fragment key={i}> <Badge kind={TONE[c.tone] || ""} title={c.title ? cap(c.title) : undefined}>{nice(c.text)}</Badge></React.Fragment>)}
        {r.hot != null && r.hot > 0.08 ? <> <Badge kind="warn" title="Running hot against his season line">Hot</Badge></> : null}
        {r.hot != null && r.hot < -0.08 ? <> <Badge kind="accent" title="Running cold against his season line">Cold</Badge></> : null}
      </td>
      {fits ? parts.map((v, i) => <td className="r num statc" key={i}>{v}</td>) : <td className="r num mid" colSpan={split ? heads.length : 1}>{r.stat != null ? r.stat : "–"}</td>}
      <td className="r act">
        {r.draft ? <Btn sm aria-label={`Add a manual bet on ${r.name}`} title="Add a manual bet on this player" onClick={() => onDraft(r.draft)}><Plus />Bet</Btn> : null}
        {hasDetail ? <span style={{ marginLeft: 6 }}><Expander open={exp} onClick={() => setExp((x) => !x)} label={exp ? "Hide the detail" : "More on this player"} /></span> : null}
      </td>
    </tr>
    {exp ? <tr className="detail"><td colSpan={(split ? heads.length : 1) + 3} style={{ padding: "4px 14px 12px 48px" }}><div className="rowdetail num">{(r.detail || []).map((d, i) => <span key={i} style={d.strong ? { color: "var(--ink)", fontWeight: 600 } : undefined}>{d.text}</span>)}</div></td></tr> : null}
  </>);
}
function LineupCol({ c, g, sportId, heads, onDraft, onAnalysis }) {
  // the stat line splits into labelled columns only when every row has the same number of parts as there are headings
  const split = heads.length > 1 && c.rows.every((r) => r.stat == null || String(r.stat).split(/ · |\//).length === heads.length);
  return (
    <div className="lineup">
      <ColTitle title={c.title} g={g} sportId={sportId} right={c.rows.length ? `${c.rows.length} players` : null} />
      {c.rows.length === 0 ? <div className="note" style={{ padding: 14 }}>{c.empty ? cap(String(c.empty).replace(/—/g, "").trim()) : "Not posted yet."}</div> : (
        <table className="tbl inset tight roster">
          <thead><tr><th className="idx">#</th><th>Player</th>{split ? heads.map((h) => <th className="r statc" key={h} style={h.length > 4 ? { width: 82 } : undefined}>{h}</th>) : <th className="r recentc">Recent</th>}<th className="act" /></tr></thead>
          <tbody>{c.rows.map((r) => <PlayerRow key={r.id} r={r} heads={heads} split={split} onDraft={onDraft} onAnalysis={onAnalysis} />)}</tbody>
        </table>
      )}
    </div>
  );
}
function StarterCard({ c, g, sportId, onDraft, onAnalysis }) {
  const r = c.row;
  return (
    <div className="lineup">
      <ColTitle title={c.title} g={g} sportId={sportId} />
      <div className="row" style={{ padding: "10px 14px", minHeight: 56 }}>
        {!r ? <span className="dim">{c.empty ? cap(String(c.empty).replace(/—/g, "").trim()) : "To be announced"}</span> : (<>
          <div className="grow">
            {r.player && onAnalysis ? <button type="button" className="name" title="Open this player" onClick={() => onAnalysis(r.player)}>{r.name}</button> : <span className="name">{r.name}</span>}
            {r.nameBadge ? <> <Badge kind="warn">{r.nameBadge}</Badge></> : null}
            <div className="note num">{r.sub || "–"}</div>
          </div>
          {r.draft ? <Btn sm aria-label={`Add a manual bet on ${r.name}`} title="Add a manual bet on this player" onClick={() => onDraft(r.draft)}><Plus />Bet</Btn> : null}
        </>)}
      </div>
    </div>
  );
}
/* The model's game line as a small table: one row per team, so projected score, win chance and fair price line up. */
function ModelLine({ g, gl, sportId }) {
  const rows = [[g.away, gl.lambdaA, gl.away], [g.home, gl.lambdaH, gl.home]];
  return (
    <div className="lineup">
      <h4><span>Model line</span><small className="num">Projected total {gl.total.toFixed(1)}</small></h4>
      <table className="tbl inset tight">
        <thead><tr><th>Team</th><th className="r">Projected score</th><th className="r">Win chance</th><th className="r">Fair price</th></tr></thead>
        <tbody>{rows.map(([ab, lam, p]) => (
          <tr key={ab}><td><Team sport={sportId} ab={ab} /></td><td className="r num" style={{ fontWeight: 640 }}>{lam.toFixed(1)}</td><td className="r num" style={{ fontWeight: p >= 0.5 ? 640 : 480 }}>{pct(p)}</td><td className="r num mid">{fOdds(Number(probToAmerican(p)))}</td></tr>
        ))}</tbody>
      </table>
      {gl.note ? <div className="foot note">{cap(String(gl.note).replace(/ — /g, ", "))}</div> : null}
    </div>
  );
}
function Conditions({ g, env }) {
  return (
    <div className="lineup">
      <h4><span>Game conditions</span></h4>
      <dl className="conds" style={{ margin: 0 }}>{env.map((e) => <div key={e.label}><dt>{labelCase(e.label, g)}</dt><dd className={cx("num", e.hot && "warn", e.cold && "accent-t")}>{e.v}</dd></div>)}</dl>
    </div>
  );
}
export function GameDetail({ g, view, sportId, statLabel = null, onDraft, onAnalysis }) {
  const gl = view.gameLine, env = view.env || [];
  const heads = statLabel ? String(statLabel).split(/ · |\//) : (LINEUP_HEADERS[sportId] || ["Recent"]);
  return (
    <>
      {gl || env.length ? (
        <div className="grid g2" style={{ alignItems: "start" }}>
          {gl ? <ModelLine g={g} gl={gl} sportId={sportId} /> : null}
          {env.length ? <Conditions g={g} env={env} /> : null}
        </div>
      ) : null}
      {(view.sections || []).map((cols, i) => (
        <div key={i} className="grid g2" style={{ alignItems: "start" }}>
          {cols.map((c) => (c.starter ? <StarterCard key={c.title} c={c} g={g} sportId={sportId} onDraft={onDraft} onAnalysis={onAnalysis} /> : <LineupCol key={c.title} c={c} g={g} sportId={sportId} heads={heads} onDraft={onDraft} onAnalysis={onAnalysis} />))}
        </div>
      ))}
    </>
  );
}
