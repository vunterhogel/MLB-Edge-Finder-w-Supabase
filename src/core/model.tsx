/* A sport's Model page: how the model has done on every play it priced, read from the board log.
   This is the calibration view. Tracked-bet results live in the hub (My stats); nothing here reads them.
   It also holds the board log tools: settle, download as CSV, clear. */
import React, { useMemo, useState } from "react";
import { Download, RefreshCw, Trash2 } from "lucide-react";
import { Btn, Edge, Empty, Panel, Stat, Th, cmp, cx, fDay, fPct, fSigned, tone } from "../ui/kit";
import { Calibration } from "../ui/charts";

const EDGE_BANDS = [["Below 0%", -9, 0], ["0 to 2%", 0, 0.02], ["2 to 5%", 0.02, 0.05], ["5 to 10%", 0.05, 0.1], ["10% and up", 0.1, 9]];
const profit = (r) => (r.result === "won" ? (Number(r.odds) > 0 ? Number(r.odds) / 100 : 100 / -Number(r.odds)) : -1);

function measure(rows, statOrder) {
  const graded = rows.filter((r) => r.settled && (r.result === "won" || r.result === "lost") && r.calibratedP != null);
  const agg = (list) => {
    const n = list.length, w = list.filter((r) => r.result === "won").length, pa = list.reduce((a, r) => a + r.calibratedP, 0);
    const ev = list.filter((r) => r.ev > 0), evW = ev.filter((r) => r.result === "won").length;
    return { n, actual: n ? w / n : null, model: n ? pa / n : null, gap: n ? w / n - pa / n : null, evN: ev.length, evHit: ev.length ? evW / ev.length : null, evRoi: ev.length ? ev.reduce((a, r) => a + profit(r), 0) / ev.length : null };
  };
  const buckets = Array.from({ length: 10 }, (_, i) => { const l = graded.filter((r) => Math.min(9, Math.floor(r.calibratedP * 10)) === i); const a = agg(l); return { p: a.model ?? (i + 0.5) / 10, actual: a.actual ?? 0, n: l.length }; });
  const types = [...statOrder, ...[...new Set(graded.map((r) => r.type))].filter((t) => !statOrder.includes(t))];
  const markets = types.map((t) => ({ type: t, ...agg(graded.filter((r) => r.type === t)) })).filter((x) => x.n);
  const edges = EDGE_BANDS.map(([label, lo, hi]) => { const l = graded.filter((r) => r.edge != null && r.edge >= lo && r.edge < hi); return { label, ...agg(l), roi: l.length ? l.reduce((x, r) => x + profit(r), 0) / l.length : null }; });
  const days = {}; rows.forEach((r) => { if (r.date) days[r.date] = (days[r.date] || 0) + 1; });
  const versions = [...new Set(rows.map((r) => r.modelVersion).filter(Boolean))];
  return { all: agg(graded), buckets, markets, edges, days: Object.entries(days).sort(), graded: graded.length, open: rows.filter((r) => !r.settled).length, versions };
}

export function ModelPage({ sport, rows, settling, message, onSettle, onDownload, onClear }) {
  const [msort, setMsort] = useState({ k: "n", d: -1 });
  const [version, setVersion] = useState("all");
  const scoped = useMemo(() => (version === "all" ? rows : rows.filter((r) => r.modelVersion === version)), [rows, version]);
  const m = useMemo(() => measure(scoped, sport.config.STAT_ORDER), [scoped, sport]);
  const versions = useMemo(() => [...new Set(rows.map((r) => r.modelVersion).filter(Boolean))], [rows]);
  const maxDay = Math.max(1, ...m.days.map((d) => d[1]));
  const worst = m.markets.filter((x) => x.n >= 30).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))[0];
  const tools = (
    <div className="row wrap">
      <div className="grow">
        <div className="h2">How the {sport.meta.title} model has performed</div>
        <div className="note">Measured on every priced play in the board log, not only the bets you tracked. Current model version {sport.storage.MODEL_VERSION}.</div>
      </div>
      {versions.length > 1 ? <select className="field" aria-label="Model version" value={version} onChange={(e) => setVersion(e.target.value)}><option value="all">All model versions</option>{versions.map((v) => <option key={v} value={v}>{v}</option>)}</select> : null}
      <Btn disabled={settling || !rows.length} onClick={onSettle} title={`Grade every logged play for finished games. Uses the free ${sport.meta.statsSource}, no odds credits.`}><RefreshCw />{settling ? "Settling" : "Settle board log"}</Btn>
      <Btn disabled={!rows.length} onClick={onDownload} title="Download every logged play with its model probability, edge, projection and result"><Download />Download CSV</Btn>
      <Btn kind="danger" disabled={!rows.length} onClick={onClear} title="Delete every board log entry for this sport"><Trash2 />Clear log</Btn>
    </div>
  );
  if (!rows.length) return (
    <div className="scroll"><div className="page" style={{ display: "grid", gap: 16 }}>
      {tools}
      {message ? <p className="note">{message}</p> : null}
      <Empty title="The board log is empty">Every odds pull saves each priced play here, and settling grades them. That history is what this page measures.</Empty>
    </div></div>
  );
  return (
    <div className="scroll"><div className="page" style={{ display: "grid", gap: 16 }}>
      {tools}
      {message ? <p className="note">{message}</p> : null}
      <div className="stats">
        <Stat k="Plays logged" v={<span className="num">{scoped.length.toLocaleString()}</span>} s={`${m.days.length} slate day${m.days.length === 1 ? "" : "s"}`} />
        <Stat k="Graded" v={<span className="num">{m.graded.toLocaleString()}</span>} s={`${m.open.toLocaleString()} still open`} />
        <Stat k="Model said, on average" v={<span className="num">{fPct(m.all.model)}</span>} s={m.graded ? `Actually hit ${fPct(m.all.actual)}` : "Nothing graded yet"} />
        <Stat k="Plays flagged +EV" v={<span className="num">{m.all.evN.toLocaleString()}</span>} s={m.all.evN ? `Hit ${fPct(m.all.evHit)}` : "None graded yet"} />
        <Stat k="Flat return on +EV plays" v={<span className="num">{fSigned(m.all.evRoi)}</span>} cls={tone(m.all.evRoi)} s="1 unit on each" />
      </div>
      {!m.graded ? <Empty title="Nothing graded yet">Settle the board log after games finish and the calibration fills in.</Empty> : (<>
        <div className="grid g-3-2">
          <Panel title="Calibration" sub="When the model says 60%, does it hit 60% of the time? Dots on the diagonal mean yes.">
            <div className="grid calib">
              <Calibration buckets={m.buckets} />
              <div className="grid" style={{ gap: 10 }}>
                <p className="mid">Dot size is the number of plays in that range. Dots below the line mean the model was too confident there.</p>
                {worst ? <p className="mid">Largest gap by market (30 or more plays): <b style={{ color: "var(--ink)" }}>{worst.type}</b>, where the model averaged {fPct(worst.model)} and plays hit {fPct(worst.actual)}.</p> : null}
              </div>
            </div>
          </Panel>
          <Panel title="Does a bigger edge win more?" sub="Graded plays grouped by the edge the model saw" flush>
            <table className="tbl inset">
              <thead><tr><th>Edge</th><th className="r">Plays</th><th className="r">Model</th><th className="r">Hit rate</th><th className="r">Flat return</th></tr></thead>
              <tbody>{m.edges.map((e) => <tr key={e.label}><td>{e.label}</td><td className="r num">{e.n.toLocaleString()}</td><td className="r num mid">{fPct(e.model)}</td><td className="r num">{fPct(e.actual)}</td><td className={cx("r num", tone(e.roi))}>{fSigned(e.roi)}</td></tr>)}</tbody>
            </table>
            <div style={{ padding: 14, borderTop: "1px solid var(--line)" }}>
              <div className="label" style={{ marginBottom: 8 }}>Plays logged per slate day</div>
              <div className="row" style={{ alignItems: "flex-end", gap: 2, height: 44 }}>{m.days.slice(-60).map(([d, n]) => <div key={d} title={`${fDay(d)}: ${n.toLocaleString()} plays`} style={{ flex: 1, maxWidth: 24, height: `${Math.max(4, (n / maxDay) * 100)}%`, background: "var(--s1)", borderRadius: "3px 3px 0 0" }} />)}</div>
              <div className="row note num" style={{ justifyContent: "space-between", marginTop: 4 }}><span>{fDay(m.days.slice(-60)[0][0])}</span><span>{fDay(m.days[m.days.length - 1][0])}</span></div>
            </div>
          </Panel>
        </div>
        <Panel title="By market" sub="Gap is hit rate minus what the model expected. Negative means the model ran hot on that market." flush>
          <table className="tbl inset">
            <thead><tr>
              <Th k="type" sort={msort} onSort={setMsort}>Market</Th><Th k="n" sort={msort} onSort={setMsort} r>Plays</Th><Th k="model" sort={msort} onSort={setMsort} r>Model</Th><Th k="actual" sort={msort} onSort={setMsort} r>Hit rate</Th>
              <Th k="gap" sort={msort} onSort={setMsort} r>Gap</Th><Th k="evN" sort={msort} onSort={setMsort} r className="hide-s">+EV plays</Th><Th k="evHit" sort={msort} onSort={setMsort} r className="hide-s">+EV hit rate</Th><Th k="evRoi" sort={msort} onSort={setMsort} r>+EV flat return</Th>
            </tr></thead>
            <tbody>{m.markets.slice().sort(cmp(msort.k, msort.d)).map((x) => (
              <tr key={x.type}><td className="name">{x.type}</td><td className="r num">{x.n.toLocaleString()}</td><td className="r num mid">{fPct(x.model)}</td><td className="r num">{fPct(x.actual)}</td><td className="r"><Edge value={x.gap} scale={0.1} /></td><td className="r num hide-s">{x.evN.toLocaleString()}</td><td className="r num hide-s">{fPct(x.evHit)}</td><td className={cx("r num", tone(x.evRoi))}>{fSigned(x.evRoi)}</td></tr>
            ))}</tbody>
          </table>
        </Panel>
      </>)}
    </div></div>
  );
}
