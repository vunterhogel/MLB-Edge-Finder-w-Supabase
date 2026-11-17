/* Shared table rows used by every sport's page: the Board row with its math panel, and the Trends row.
   Sport-specific bits (which markets are game lines or yes/no, the signal thresholds) come in as cfg. */
import React, { useState } from "react";
import { Check, Plus } from "lucide-react";
import { impliedProb, suggestedUnits } from "./math";
import { projMeta } from "./ui";
import { Badge, Btn, Edge, Expander, GameTag, HBar, cap, cx, fDelta, fOdds, fPct, fSigned, pickLabel, tone } from "../ui/kit";

export function TrackBtn({ tracked, onTrack, onUntrack = null, compact = false }) {
  if (tracked) return <Btn sm on icon={compact} disabled={!onUntrack} onClick={onUntrack || undefined} title={onUntrack ? "Tracked. Click to remove it from My bets." : "Tracked"} aria-label="Tracked"><Check />{compact ? null : <span className="hide-s">Tracked</span>}</Btn>;
  return <Btn sm icon={compact} onClick={onTrack} title="Track this play" aria-label="Track this play"><Plus />{compact ? null : <span className="hide-s">Track</span>}</Btn>;
}

/* The full calculation behind one priced play: how the projection was built, then the price check. */
export function MathPanel({ r, bookLabel = null, onPlayer = null }) {
  const p = r.modelP;
  if (p == null) return null;
  const q = 1 - p, calc = r.calc || null, live = calc && calc.live;
  const mults = (calc && calc.mults ? calc.mults : []).filter(([, v]) => Math.abs(Number(v) - 1) > 0.0005);
  const pm = projMeta(r.proj, r.line, r.side);
  const sug = suggestedUnits(p, Number(r.odds));
  return (
    <div className="mathgrid">
      <div>
        <div className="h2" style={{ marginBottom: 8 }}>How the projection was built</div>
        {calc ? (<>
          <p className="mid">{calc.baseStr}</p>
          {live ? <p className="mid" style={{ marginTop: 6 }}>Live: has <b style={{ color: "var(--ink)" }}>{live.current}</b>, {Math.round(live.fr * 100)}% of the game left, needs {(parseFloat(r.line) - live.current).toFixed(1)} more.</p> : null}
          {live ? null : mults.length ? (
            <table className="tbl inset tight" style={{ marginTop: 8 }}><tbody>{mults.map(([name, v]) => (
              <tr key={name}><td style={{ paddingLeft: 0 }}>{cap(name)}</td><td className="r num mid">{"×"}{Number(v).toFixed(3)}</td><td className="r" style={{ paddingRight: 0 }}><Edge value={Number(v) - 1} scale={0.1} /></td></tr>
            ))}</tbody></table>
          ) : <p className="note" style={{ marginTop: 6 }}>Neutral context: no adjustment moved the base rate.</p>}
          <p className="mid num" style={{ marginTop: 10 }}>{live ? "Final" : "Expected"} {r.type}: <b style={{ color: "var(--ink)" }}>{r.proj != null ? Number(r.proj).toFixed(2) : "–"}</b></p>
          <p className="note num">{calc.dist}({calc.params})</p>
        </>) : <p className="note">No projection detail was saved with this play.</p>}
      </div>
      <div>
        <div className="h2" style={{ marginBottom: 8 }}>Price check</div>
        <dl className="kv num">
          <dt>{bookLabel || "Book"} price</dt><dd>{fOdds(r.odds)}{r.b != null ? <span className="dim"> pays ${Number(r.b).toFixed(2)} per $1</span> : null}</dd>
          <dt>Implied by that price</dt><dd>{fPct(impliedProb(Number(r.odds)))}</dd>
          <dt>{r.devigged ? "Market with the vig removed" : "Market (one side only, vig left in)"}</dt><dd>{fPct(r.novig)}</dd>
          <dt>Model: P({r.side} {r.line})</dt><dd style={{ fontWeight: 640 }}>{fPct(p)}</dd>
          <dt>Fair price at the model</dt><dd>{r.fair}</dd>
          <dt>Edge (model minus market)</dt><dd className={tone(r.edge)}>{r.edge != null ? `${fDelta(r.edge * 100, 1)} pts` : "–"}</dd>
          <dt>Expected return per unit</dt><dd className={tone(r.ev)} style={{ fontWeight: 640 }}>{fSigned(r.ev)}</dd>
          <dt>Suggested stake (quarter Kelly)</dt><dd>{sug ? `${sug}u` : "No bet"}</dd>
        </dl>
        {r.b != null && r.ev != null ? <p className="note num" style={{ marginTop: 8 }}>EV = p{"·"}b {"−"} (1{"−"}p) = ({p.toFixed(3)})({Number(r.b).toFixed(2)}) {"−"} ({q.toFixed(3)})</p> : null}
      </div>
      <div>
        <div className="h2" style={{ marginBottom: 8 }}>Projection against the line</div>
        {pm ? (<>
          <div className="projbar" title={`Projection ${Number(r.proj).toFixed(2)} against a line of ${r.line}`}><i style={{ width: `${pm.projPct}%`, background: pm.delta < 0 ? "var(--neg)" : "var(--pos)" }} /><b style={{ left: `${pm.linePct}%` }} /></div>
          <p className="mid num" style={{ marginTop: 8 }}>Projection {Number(r.proj).toFixed(2)}, line {r.line}. {pm.delta >= 0 ? "Clears" : "Misses"} this side by {Math.abs(pm.delta).toFixed(2)}.</p>
        </>) : <p className="note">{r.proj != null ? "This market is priced as a probability, so there is no line to clear." : "No projection for this market."}</p>}
        {(r.outsSanityFailed || r.suppressNote) ? <p className="warn" style={{ marginTop: 8 }}>{r.suppressNote || "Stale innings data"}: the edge on this play is not trusted.</p> : null}
        {onPlayer ? <Btn sm style={{ marginTop: 10 }} onClick={onPlayer}>Open player</Btn> : null}
      </div>
    </div>
  );
}

/* One Board play as a table row. `wide` adds the Player and Game columns (the Board); the player page leaves them out. */
export const BoardRow = React.memo(function BoardRow({ e, sportId, cfg, tracked, onTrack, onUntrack = null, onPlayer = null, bookLabel = null, wide = true }) {
  const [open, setOpen] = useState(false);
  const isLine = cfg.isLineType(e.type), yn = !!(cfg.isYesNoType && cfg.isYesNoType(e.type));
  const pm = !isLine && !yn ? projMeta(e.proj, e.line, e.side) : null;
  const sig = cfg.getDeltaSignal(e.type, e.proj, e.line);
  const suppressed = e.outsSanityFailed || e.suppressNote;
  const pick = pickLabel(e, cfg), n = wide ? 12 : 10;
  return (<>
    <tr className={open ? "open" : ""}>
      <td><Expander open={open} onClick={() => setOpen((o) => !o)} label={open ? "Hide the math" : "Show the math"} /></td>
      {wide ? <td>{isLine ? <span className="dim">Game line</span> : onPlayer ? <button type="button" className="name trunc" style={{ maxWidth: 200 }} onClick={() => onPlayer(e)} title="Open player">{e.name}</button> : <span className="name">{e.name}</span>}{e.calc && e.calc.live ? <> <Badge kind="live">Live</Badge></> : null}<div className="show-s sub"><b>{pick}</b> {e.type}</div></td> : null}
      {wide ? <td className="hide-s"><GameTag sport={sportId} game={e.game} /></td> : null}
      <td className={cx("pick", wide && "hide-s")}><b>{pick}</b> <span className="mid">{e.type}</span></td>
      <td className="r num">{fOdds(e.odds)}</td>
      <td className="r num hide-s">{yn ? fPct(e.proj) : e.proj == null ? "–" : <>{Number(e.proj).toFixed(2)}{pm ? <span className={pm.strength === "miss" ? "neg" : pm.strength === "thin" ? "dim" : "pos"} style={{ display: "inline-block", minWidth: 44 }} title="How far the projection sits on this side of the line"> {fDelta(pm.delta)}</span> : null}</>}</td>
      <td className="r num mid hide-s hide-m">{fPct(e.novig)}</td>
      <td className="r num hide-s">{fPct(e.modelP)} <span className="dim">{e.fair}</span></td>
      <td className="r hide-s">{suppressed ? <span className="dim">{"–"}</span> : <Edge value={e.edge} />}</td>
      <td className={cx("r num", suppressed ? "warn" : tone(e.ev))} style={{ fontWeight: 620 }}>{suppressed ? <Badge kind="warn" title={`${e.suppressNote || "Stale innings data"}: edge suppressed`}>Check</Badge> : fSigned(e.ev)}</td>
      <td className="c hide-s hide-m">{sig ? <span className={cx("sig", sig)} title={`${sig === "strong" ? "Strong" : "Moderate"} projection signal`} /> : null}</td>
      <td className="r"><TrackBtn tracked={tracked} onTrack={() => onTrack(e)} onUntrack={onUntrack ? () => onUntrack(e) : null} /></td>
    </tr>
    {open ? <tr className="detail"><td colSpan={n}><MathPanel r={e} bookLabel={bookLabel} onPlayer={onPlayer && !isLine ? () => onPlayer(e) : null} /></td></tr> : null}
  </>);
});
export function BoardHead({ sort = null, onSort = null, wide = true }) {
  const H = ({ k, children, ...p }) => (sort && onSort ? <ThSort k={k} sort={sort} onSort={onSort} {...p}>{children}</ThSort> : <th className={cx(p.r && "r", p.c && "c", p.className)} title={p.title}>{children}</th>);
  return (
    <thead><tr>
      <th style={{ width: 36 }} />
      {wide ? <H k="name">Player</H> : null}
      {wide ? <H k="game" className="hide-s">Game</H> : null}
      <H k="type" className={wide ? "hide-s" : ""}>Pick</H>
      <H k="odds" r>Odds</H>
      <H k="delta" r className="hide-s" title="Model projection, and how far it sits on this side of the line">Projection</H>
      <H k="novig" r className="hide-s hide-m" title="Market probability with the vig removed">Market</H>
      <H k="modelP" r className="hide-s" title="Model probability and the fair price at that probability">Model</H>
      <H k="edge" r className="hide-s" title="Model minus market">Edge</H>
      <H k="ev" r title="Expected return per unit staked">EV</H>
      <th className="c hide-s hide-m" title="Projection signal">Signal</th>
      <th className="trk" />
    </tr></thead>
  );
}
function ThSort({ k, sort, onSort, r = false, c = false, className = "", title, children }) {
  const on = sort.k === k;
  return <th className={cx(r && "r", c && "c", on && "sorted", className)} title={title} aria-sort={on ? (sort.d > 0 ? "ascending" : "descending") : "none"}><button type="button" onClick={() => onSort({ k, d: on ? -sort.d : -1 })}>{children}{on ? <span aria-hidden="true">{sort.d > 0 ? " ↑" : " ↓"}</span> : null}</button></th>;
}

const Rate = ({ s, tag = null }) => (s && s.n
  ? <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>{tag ? <span className="dim" style={{ fontSize: 12 }}>{tag}</span> : null}<span className="num mid">{s.hits}/{s.n}</span><HBar value={s.pct} width={34} /><span className="num" style={{ minWidth: 34, textAlign: "right" }}>{fPct(s.pct, 0)}</span></span>
  : <span className="dim">{tag ? `${tag}: ` : ""}no games</span>);

/* One trend as a table row: the pick, then its hit rate in three splits. */
export function TrendRow({ c, entry, sportId, cfg, tracked, onTrack, onUntrack = null, onPlayer = null }) {
  const yn = !!(cfg.isYesNoType && cfg.isYesNoType(c.type));
  const pick = yn ? (c.side === "over" ? "Yes" : "No") : `${c.side === "over" ? "Over" : "Under"} ${c.line}`;
  return (
    <tr>
      <td>{onPlayer ? <button type="button" className="name trunc" style={{ maxWidth: 150 }} onClick={() => onPlayer(c)}>{c.name}</button> : <span className="name">{c.name}</span>}<div className="show-s sub"><b>{pick}</b> {c.type}</div></td>
      <td className="hide-s"><GameTag sport={sportId} game={c.game} /></td>
      <td className="pick hide-s"><b>{pick}</b> <span className="mid">{c.type}</span>{c.sourced !== "book" ? <> <Badge title="No book line pulled yet. This line is set from the player's own recent results.">No book line</Badge></> : null}</td>
      <td className="r num hide-s hide-m">{c.odds != null ? fOdds(c.odds) : "–"}</td>
      <td className="r"><Rate s={c.recentForm} /></td>
      <td className="r hide-s"><Rate s={c.vsOpp} tag={c.opp || null} /></td>
      <td className="r hide-s"><Rate s={c.homeAway} tag={c.isHome ? "Home" : "Away"} /></td>
      <td className="r num hide-s hide-m">{entry ? fPct(entry.modelP) : "–"}</td>
      <td className={cx("r num", entry ? tone(entry.ev) : "dim")} style={{ fontWeight: 620 }}>{entry ? fSigned(entry.ev) : "–"}</td>
      <td className="r">{entry ? <TrackBtn compact tracked={tracked} onTrack={() => onTrack(entry)} onUntrack={onUntrack ? () => onUntrack(entry) : null} /> : null}</td>
    </tr>
  );
}
