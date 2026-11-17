/* Hub · My stats: tracked-bet performance, filterable by sport and date. With one sport selected it is
   that sport's results by market. "All sports" adds a by-sport breakdown and labels each market with its
   sport; parlays count toward the totals with their own rows. "Parlays" shows parlay results on their
   own, by leg count. Only tracked bets are measured here: the board log is each sport's Model tab. */
import React, { useEffect, useMemo, useState } from "react";
import { Download, Trash2 } from "lucide-react";
import { betStats, betsCsv, deriveBet, downloadText } from "../core/bets";
import { HUB_SPORT, HUB_SPORTS } from "./sports";
import { parlayDate, parlayStats, parlaysCsv, syncParlayResults, useParlays } from "../parlay/store";
import { scopedBets, setSportBets, useHubBets } from "./useHubBets";
import { BET_SEG, HubTop, betNet, betUnits, combinedStats, dailySeries, isSettled, mergeOverall } from "./common";
import { Btn, Empty, HBar, Panel, Seg, SportTag, Stat, Th, cmp, confirmDialog, cx, fNum, fPct, fSigned, fUnits, toast, tone } from "../ui/kit";
import { LineChart } from "../ui/charts";

const EDGE_BANDS = [["Below 3%", -9, 0.03], ["3 to 5%", 0.03, 0.05], ["5 to 7%", 0.05, 0.07], ["7% and up", 0.07, 9]];
const record = (s) => `${s.w}-${s.l}${s.ps ? `-${s.ps}` : ""}`;
function summarize(list) {
  const w = list.filter((b) => b.status === "won").length, l = list.filter((b) => b.status === "lost").length;
  const net = list.reduce((a, b) => a + betNet(b), 0), staked = list.filter((b) => b.status === "won" || b.status === "lost").reduce((a, b) => a + betUnits(b), 0);
  return { n: list.length, w, l, ps: list.filter((b) => b.status === "push").length, winPct: w + l ? w / (w + l) : null, net, roi: staked ? net / staked : null };
}

export default function MyStats({ active = true }) {
  const all = useHubBets();
  const parlays = useParlays();
  const [sportFilter, setSportFilter] = useState("all");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [msort, setMsort] = useState({ k: "i", d: 1 });
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
  const inRange = (d) => (!start || (d && d >= start)) && (!end || (d && d <= end));
  const settled = useMemo(() => bets.filter((b) => isSettled(b) && inRange(b.date)), [bets, start, end]);
  const settledParlays = useMemo(() => (one ? [] : parlays.filter((p) => p.status !== "open" && inRange(parlayDate(p)))), [parlays, one, start, end]);
  const series = useMemo(() => dailySeries(settled, settledParlays), [settled, settledParlays]);
  const derived = useMemo(() => settled.map(deriveBet), [settled]);
  const byEdge = EDGE_BANDS.map(([label, lo, hi]) => ({ label, ...summarize(derived.filter((b) => b.edge != null && b.edge >= lo && b.edge < hi)) }));
  const withMove = derived.filter((b) => b.clv != null), avgMove = withMove.length ? withMove.reduce((a, b) => a + b.clv, 0) / withMove.length : null;
  const marketRows = typeOrder.filter((t) => stats.byType[t]).map((t, i) => {
    const parts = one ? [null, t] : t.split(" · ");
    return { i, key: t, group: parts[0], type: parts.length > 1 ? parts.slice(1).join(" · ") : t, ...stats.byType[t] };
  });

  function exportCSV() {
    const stamp = new Date().toISOString().slice(0, 10);
    if (one) { downloadText(betsCsv(all[one.id], stats, typeOrder), `${one.sport.meta.csvPrefix}-${stamp}.csv`, "text/csv;charset=utf-8;"); return; }
    if (onlyParlays) { downloadText(parlaysCsv(parlays), `edge-finder-parlays-${stamp}.csv`, "text/csv;charset=utf-8;"); return; }
    downloadText(betsCsv(bets, stats, typeOrder, (b) => HUB_SPORT[b._sport].label) + (parlays.length ? `\n\nPARLAYS\n${parlaysCsv(parlays)}` : ""), `edge-finder-${stamp}.csv`, "text/csv;charset=utf-8;");
  }
  // clears one sport's bets (pick the sport first); never every sport at once
  function resetStats() {
    if (!one) return;
    const prev = all[one.id];
    confirmDialog({
      title: `Clear all tracked ${one.label} bets?`, danger: true, confirm: "Clear bets",
      body: `${prev.length.toLocaleString()} ${one.label} bets, open and settled, are removed. Download a CSV or a backup first if you want a copy.`,
      onConfirm: () => { setSportBets(one.id, []); toast(`Cleared ${prev.length.toLocaleString()} ${one.label} bets.`, () => setSportBets(one.id, prev)); },
    });
  }
  const groupName = (g) => { const s = HUB_SPORTS.find((x) => x.label === g); return s ? <SportTag sport={s.id} label={s.label} /> : <span className="mid">{g}</span>; };

  return (
    <>
      <HubTop title="My stats">
        <Btn disabled={bets.length === 0 && (!!one || parlays.length === 0)} onClick={exportCSV}><Download /><span className="hide-s">Download CSV</span></Btn>
        <Btn kind="danger" disabled={!one || bets.length === 0} onClick={resetStats} title={one ? `Clear every tracked ${one.label} bet` : "Pick one sport to clear its bets. Parlays are removed one at a time in My bets."}><Trash2 /><span className="hide-s">Reset stats</span></Btn>
      </HubTop>
      <div className="screen">
        <div className="bar">
          <Seg label="Sport" value={sportFilter} onChange={(v) => { setSportFilter(v); setMsort({ k: "i", d: 1 }); }} options={BET_SEG} />
          <span className="sep" />
          <span className="label">From</span><input type="date" className="field datefield num" aria-label="Start date" value={start} min={dates[0] || ""} max={end || dates[dates.length - 1] || ""} onChange={(e) => setStart(e.target.value)} />
          <span className="label">to</span><input type="date" className="field datefield num" aria-label="End date" value={end} min={start || dates[0] || ""} max={dates[dates.length - 1] || ""} onChange={(e) => setEnd(e.target.value)} />
          {start || end ? <Btn sm kind="ghost" onClick={() => { setStart(""); setEnd(""); }}>All time</Btn> : null}
          <span className="grow" /><span className="note hide-s">Tracked bets only. The board log is measured on each sport's Model tab.</span>
        </div>
        <div className="scroll"><div className="page" style={{ display: "grid", gap: 16 }}>
          {!o.n ? <Empty title={onlyParlays ? "No settled parlays in this range" : "No settled bets in this range"}>{onlyParlays ? "Track parlays in the Parlay builder. Their legs settle as each sport's results come in." : "Track bets, then press Settle finished on My bets after the games end."}{stats.openCount ? ` ${stats.openCount} still open.` : ""}</Empty> : (<>
            <div className="stats">
              <Stat k="Record" v={<span className="num">{record(o)}</span>} s={`${o.n} settled${o.v ? `, ${o.v} void` : ""}, ${stats.openCount} open`} />
              <Stat k="Win rate" v={<span className="num">{fPct(o.winPct)}</span>} s="Break-even is about 52.4% at −110" />
              <Stat k="Net units" v={<span className="num">{fUnits(o.net)}</span>} cls={tone(o.net)} s={`${fNum(o.staked, 2)}u staked`} />
              <Stat k="Return on stake" v={<span className="num">{fSigned(o.roi)}</span>} cls={tone(o.roi)} s={<span className="num">Flat 1u: {fUnits(o.flatNet)}, {fSigned(o.flatRoi)}</span>} />
              {avgMove != null ? <Stat k="Average line move" v={<span className="num">{fSigned(avgMove, 2)}</span>} cls={tone(avgMove)} s={`Positive means you beat the close. ${withMove.length} bets.`} /> : null}
            </div>
            <div className="grid g-3-2">
              <Panel title="Units over time" sub="Running total by slate date. Your stakes against a flat 1 unit on every bet.">
                {series.labels.length > 1
                  ? <LineChart height={320} labels={series.labels} fmt={(v) => `${v > 0 ? "+" : ""}${Number(v).toFixed(Math.abs(v) < 10 && v % 1 ? 1 : 0)}u`} series={[{ name: "Your stakes", color: "var(--s1)", values: series.staked }, { name: "Flat 1 unit", color: "var(--s2)", values: series.flat }]} />
                  : <p className="note">The chart appears once bets have settled on two or more dates.</p>}
              </Panel>
              <div className="grid" style={{ alignContent: "start" }}>
                {!one && !onlyParlays ? (
                  <Panel title="By sport" flush>
                    <table className="tbl inset"><thead><tr><th>Sport</th><th className="r">Record</th><th className="r">Win rate</th><th className="r">Net</th><th className="r">Return</th></tr></thead>
                      <tbody>
                        {HUB_SPORTS.filter((s) => stats.bySport[s.id].overall.n > 0).map((s) => { const x = stats.bySport[s.id].overall; return <tr key={s.id}><td><SportTag sport={s.id} label={s.label} /></td><td className="r num">{record(x)}</td><td className="r num">{fPct(x.winPct)}</td><td className={cx("r num", tone(x.net))}>{fUnits(x.net)}</td><td className={cx("r num", tone(x.roi))}>{fSigned(x.roi)}</td></tr>; })}
                        {pStats.overall.n > 0 ? <tr><td className="mid">Parlays</td><td className="r num">{record(pStats.overall)}</td><td className="r num">{fPct(pStats.overall.winPct)}</td><td className={cx("r num", tone(pStats.overall.net))}>{fUnits(pStats.overall.net)}</td><td className={cx("r num", tone(pStats.overall.roi))}>{fSigned(pStats.overall.roi)}</td></tr> : null}
                      </tbody></table>
                  </Panel>
                ) : null}
                {!onlyParlays ? (
                  <Panel title="By edge when you bet" sub="Are the bigger edges paying more?" flush>
                    <table className="tbl inset"><thead><tr><th>Model edge</th><th className="r">Bets</th><th className="r">Win rate</th><th className="r">Net</th><th className="r">Return</th></tr></thead>
                      <tbody>{byEdge.map((x) => <tr key={x.label}><td>{x.label}</td><td className="r num">{x.n}</td><td className="r num">{fPct(x.winPct)}</td><td className={cx("r num", tone(x.net))}>{x.n ? fUnits(x.net) : "–"}</td><td className={cx("r num", tone(x.roi))}>{fSigned(x.roi)}</td></tr>)}</tbody></table>
                  </Panel>
                ) : null}
              </div>
            </div>
            <Panel title={onlyParlays ? "By leg count" : "By market"} sub="Click a column to sort" flush>
              <table className="tbl inset">
                <thead><tr>
                  {!one && !onlyParlays ? <Th k="i" sort={msort} onSort={setMsort}>Sport</Th> : null}
                  <Th k={one || onlyParlays ? "i" : "type"} sort={msort} onSort={setMsort}>{onlyParlays ? "Parlay" : "Market"}</Th><Th k="n" sort={msort} onSort={setMsort} r>Bets</Th><th className="r">Record</th>
                  <Th k="winPct" sort={msort} onSort={setMsort} r>Win rate</Th><Th k="net" sort={msort} onSort={setMsort} r>Net</Th><Th k="roi" sort={msort} onSort={setMsort} r>Return</Th><Th k="flatNet" sort={msort} onSort={setMsort} r className="hide-s" title="The same bets at a flat 1 unit each">Flat 1u</Th>
                </tr></thead>
                <tbody>{marketRows.slice().sort(cmp(msort.k, msort.d)).map((x) => (
                  <tr key={x.key}>
                    {!one && !onlyParlays ? <td>{groupName(x.group)}</td> : null}
                    <td className="name">{x.type}</td><td className="r num">{x.n}</td><td className="r num mid">{record(x)}</td>
                    <td className="r"><span className="row" style={{ justifyContent: "flex-end" }}><HBar value={x.winPct ?? 0} width={64} /><span className="num" style={{ minWidth: 44, textAlign: "right" }}>{fPct(x.winPct)}</span></span></td>
                    <td className={cx("r num", tone(x.net))}>{fUnits(x.net)}</td><td className={cx("r num", tone(x.roi))}>{fSigned(x.roi)}</td><td className={cx("r num hide-s", tone(x.flatNet))}>{fUnits(x.flatNet)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </Panel>
            <p className="note" style={{ maxWidth: 860 }}>Net and return use each bet's unit stake. The flat 1 unit figures show what the same bets return at a flat stake, so you can see whether sizing your bets is helping. Trust the comparison over many bets, not a handful.</p>
          </>)}
        </div></div>
      </div>
    </>
  );
}
