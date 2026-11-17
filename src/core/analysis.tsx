/* Shared player page, for every sport. A sport supplies only data, through
   sport.playerView({ profile, spot, detail, projections }):
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
import React, { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { pct } from "./math";
import { projMeta } from "./ui";
import { BoardHead, BoardRow } from "./cards";
import { Chip } from "./slate";
import { Badge, Btn, Empty, Panel, Seg, Stat, cap, cx, fDay, fDelta } from "../ui/kit";
import { FormBars } from "../ui/charts";

const TONE = { sky: "accent-t", good: "pos", bad: "neg", warn: "warn", muted: "dim" };
const title = (t) => { const s = String(t || ""); return s === s.toUpperCase() ? s[0] + s.slice(1).toLowerCase() : s; };

function InfoCard({ c }) {
  return (
    <Panel title={title(c.title)} sub={c.grid && c.grid.length ? c.note : null}>
      {c.empty ? <span className="mid">{c.empty}</span> : (<>
        {c.headline ? <div className={cx("h2", TONE[c.headline.tone])} style={{ marginBottom: 4 }}>{String(c.headline.text).replace(/_/g, " ")}</div> : null}
        {c.note && !(c.grid && c.grid.length) ? <div className="note num">{c.note}</div> : null}
        {c.lines && c.lines.length ? <div className="grid num" style={{ gap: 4, marginTop: 8 }}>{c.lines.map((l, i) => { const o = typeof l === "string" ? { text: l } : l; return <div key={i} className={TONE[o.tone] || "mid"}>{o.text}</div>; })}</div> : null}
        {c.grid && c.grid.length ? <dl className="kv num" style={{ gridTemplateColumns: "auto 1fr auto 1fr" }}>{c.grid.map(([l, v, tone]) => <React.Fragment key={l}><dt>{l}</dt><dd className={TONE[tone]} style={{ fontWeight: 600 }}>{v == null ? "–" : v}</dd></React.Fragment>)}</dl> : null}
      </>)}
    </Panel>
  );
}
function DataTable({ cols, rows, left = 1 }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="tbl inset tight">
        <thead><tr>{cols.map((h, i) => <th key={`${h}-${i}`} className={i < left ? "" : "r"}>{cap(h)}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={j < left ? "mid" : "r num"}>{v == null ? "–" : v}</td>)}</tr>)}</tbody>
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
  const mode = lineMode === "actual" && hasActual ? "actual" : "model";
  const activeLine = mode === "actual" ? actualLine : modelLine;
  const bars = (form.games || []).slice(0, win).reverse().map((x) => ({ v: cat ? (x.v[cat.key] ?? 0) : 0, label: x.opp || "", sub: x.homeAway || "", tip: `${fDay(x.date)} ${x.homeAway || ""} ${x.opp || ""}` }));
  const n = bars.length, hits = bars.filter((b) => b.v >= activeLine).length;
  return (
    <Panel title={title(form.title)} flush>
      {form.table && form.table.rows.length ? <DataTable cols={form.table.cols} rows={form.table.rows} /> : <div className="note" style={{ padding: 14 }}>No recent games.</div>}
      {cat ? (
        <div style={{ padding: 14, borderTop: "1px solid var(--line)" }}>
          <div className="row wrap" style={{ marginBottom: 10 }}>
            <Seg label="Stat" value={cat.key} onChange={setCatKey} options={cats.map((c) => [c.key, c.label])} />
            <span className="grow" />
            {hasActual ? <Seg label="Line" value={mode} onChange={setLineMode} options={[["model", "Projection"], ["actual", "Market line"]]} /> : null}
            <Seg label="Window" value={win} onChange={setWin} options={[[5, "Last 5"], [10, "Last 10"], [20, "Last 20"]]} />
          </div>
          {n === 0 ? <div className="note">No game log data available.</div> : (<>
            <div className="row" style={{ marginBottom: 4 }}><span className="mid">Cleared {mode === "actual" ? "the market line" : "the model projection"} of <b className="num" style={{ color: "var(--ink)" }}>{fmtLineLabel(activeLine)}</b> in</span><b className={cx("num", hits / n >= 0.65 ? "pos" : hits / n >= 0.45 ? "" : "neg")}>{hits} of {n}</b></div>
            <FormBars line={activeLine} lineLabel={`${mode === "actual" ? "Line" : "Proj"} ${fmtLineLabel(activeLine)}`} bars={bars} inclusive fmt={fmt} height={210} />
          </>)}
        </div>
      ) : null}
    </Panel>
  );
}
function SplitsCard({ splits }) {
  return (
    <Panel title={title(splits.title)}>
      {!splits.panels || !splits.panels.length ? <span className="mid">{splits.empty || "No split data returned."}</span> : (
        <div className="grid g2" style={{ gap: 10 }}>
          {splits.panels.map((s) => (
            <div key={s.label} className="ticket">
              <div className="label">{s.label}{s.sub ? <span className="dim"> {s.sub}</span> : null}</div>
              {s.lines ? (<>
                {s.headline ? <div className="h2 num">{s.headline}</div> : null}
                {s.lines.map((row, i) => <div key={i} className="num mid" style={{ fontSize: 12.5 }}>{row.map(([l, v]) => <span key={l} style={{ marginRight: 10 }}>{l} <b style={{ color: "var(--ink)", fontWeight: 600 }}>{v == null ? "–" : v}</b></span>)}</div>)}
              </>) : <span className="dim">{"–"}</span>}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// intro = the sport's text: { file, fileSub, slate(games) -> string, slateSub }
export function PlayerAnalysisIntro({ games, boardCount, intro }) {
  return (
    <div className="grid g3">
      <Panel title="Player file"><div>{intro.file}</div><div className="note" style={{ marginTop: 6 }}>{intro.fileSub}</div></Panel>
      <Panel title="Slate context"><div>{intro.slate(games || [])}</div><div className="note" style={{ marginTop: 6 }}>{intro.slateSub}</div></Panel>
      <Panel title="Market context"><div>{boardCount} priced play{boardCount === 1 ? "" : "s"} on the board.</div><div className="note" style={{ marginTop: 6 }}>Odds, market with the vig removed, edge and EV.</div></Panel>
    </div>
  );
}

export function PlayerAnalysis({ view, profile, spot, detail, projections, boardEntries, boardGameCount, bookLabel, oddsLoading, oddsReady, onFetchOdds, trackedKeys, onTrack, onUntrack, rowCfg, sportId }) {
  const p = profile.player;
  const hasSlate = !!spot;
  const slateReady = hasSlate && detail && detail.ready;
  const canFetchOdds = hasSlate && spot.game && !spot.game.manual && spot.game.status !== "FINAL";
  const [sort, setSort] = useState({ k: "ev", d: -1 });
  const sortedMkts = useMemo(() => {
    const val = (e) => (sort.k === "delta" ? (e.proj ?? 0) - parseFloat(e.line ?? 0) : sort.k === "odds" ? (Number(e.odds) > 0 ? Number(e.odds) / 100 : 100 / -Number(e.odds)) : e[sort.k]);
    return [...boardEntries].sort((a, b) => { const x = val(a), y = val(b); if (x == null) return 1; if (y == null) return -1; return (typeof x === "string" ? x.localeCompare(y) : x - y) * sort.d; });
  }, [boardEntries, sort]);
  const [imgOk, setImgOk] = useState(true);
  const initials = String(p.name || "").split(" ").map((w) => w[0]).slice(0, 2).join("");
  const busy = hasSlate && oddsLoading === spot.game.pk;
  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="row" style={{ gap: 14, alignItems: "flex-start" }}>
        {view.headshot && imgOk ? <img src={view.headshot} alt="" className="avatar lg" onError={() => setImgOk(false)} /> : <span className="avatar lg">{initials}</span>}
        <div className="grow">
          <div className="row wrap"><h2 className="wide" style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>{p.name}</h2>{hasSlate ? <Chip s={spot.game.status} /> : <Badge>Not on the selected slate</Badge>}</div>
          <div className="mid" style={{ marginTop: 2 }}>{view.subtitle}</div>
        </div>
      </div>
      {(view.metrics || []).length ? <div className="stats">{view.metrics.map(([label, value, good]) => <Stat key={label} k={label} v={<span className="num">{value == null ? "–" : value}</span>} cls={good === true ? "pos" : good === false ? "neg" : ""} />)}</div> : null}
      <div className="grid g3">{(view.cards || []).map((c) => <InfoCard key={c.title} c={c} />)}</div>

      <Panel title="Model projections" sub={hasSlate ? (slateReady ? "Using this slate's matchup context" : "Loading this slate's matchup context") : "Available when the player is on the selected slate"} flush
        actions={canFetchOdds ? (oddsReady
          ? <div className="row"><span className="pos" style={{ fontSize: 12.5 }}>Odds loaded</span><Btn sm disabled={busy} onClick={onFetchOdds} title="Pull this game's odds again"><RefreshCw />{busy ? "Pulling" : "Refresh"}</Btn></div>
          : <Btn sm kind="primary" disabled={busy} onClick={onFetchOdds}>{busy ? "Pulling odds" : `Pull ${bookLabel} odds`}</Btn>) : null}>
        {!hasSlate ? <Empty title="No matchup on this date">Change the date to see same-day projections.</Empty>
          : !slateReady ? <div className="note" style={{ padding: 14 }}>Loading matchup detail.</div>
          : (
            <table className="tbl inset">
              <thead><tr><th>Market</th><th className="r">Line</th><th className="r">Projection</th><th className="r hide-s">Against the line</th><th className="r">Over</th><th className="r hide-s">Fair</th><th className="r">Under</th><th className="r hide-s">Fair</th></tr></thead>
              <tbody>{projections.map((r) => { const pm = projMeta(r.proj, r.line, "over"); return (
                <tr key={r.type}><td className="name">{r.type}</td><td className="r num mid">{r.line}</td><td className="r num">{r.proj != null ? r.proj.toFixed(2) : "–"}</td>
                  <td className={cx("r num hide-s", pm ? (pm.delta < 0 ? "neg" : "pos") : "dim")}>{pm ? fDelta(pm.delta) : "–"}</td>
                  <td className="r num">{pct(r.overP)}</td><td className="r num dim hide-s">{r.overFair}</td><td className="r num">{pct(r.underP)}</td><td className="r num dim hide-s">{r.underFair}</td></tr>); })}</tbody>
            </table>
          )}
      </Panel>

      <Panel title="Current board markets" sub={boardEntries.length ? `${boardEntries.length} priced market${boardEntries.length === 1 ? "" : "s"} for this player` : boardGameCount ? "This game's odds are loaded, but no markets matched this player" : "Pull odds from the Slate or from this page to price his markets"} flush>
        {sortedMkts.length ? (
          <table className="tbl inset">
            <BoardHead wide={false} sort={sort} onSort={setSort} />
            <tbody>{sortedMkts.map((e) => <BoardRow key={e.id} wide={false} e={e} sportId={sportId} cfg={rowCfg} bookLabel={bookLabel} tracked={trackedKeys.has(e.id)} onTrack={onTrack} onUntrack={onUntrack} />)}</tbody>
          </table>
        ) : <div className="note" style={{ padding: 14 }}>No odds rows for this player yet.</div>}
      </Panel>

      <div className="grid g2" style={{ alignItems: "start" }}>
        {view.form ? <FormCard form={view.form} projections={projections} boardEntries={boardEntries} /> : null}
        <div className="grid" style={{ gap: 16 }}>
          {view.splits ? <SplitsCard splits={view.splits} /> : null}
          {view.log ? <Panel title={title(view.log.title)} flush>{!view.log.rows.length ? <div className="note" style={{ padding: 14 }}>{view.log.empty || "No game log returned."}</div> : <DataTable cols={view.log.cols} rows={view.log.rows} left={2} />}</Panel> : null}
        </div>
      </div>
    </div>
  );
}
