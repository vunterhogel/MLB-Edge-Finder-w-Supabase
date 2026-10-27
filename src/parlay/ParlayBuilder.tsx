/* Parlay Builder (hub). Builds parlays from legs every sport already saved, with no CSVs:
     - Board log: every unsettled board-log row from MLB, NFL, NBA and NHL (each priced by its sport's model)
     - My Bets:   every open tracked bet
   1. Leg pool: filter legs on every factor; add a leg to the slip, pin it into every auto-built parlay,
      or exclude it.
   2. Slip: build a parlay by hand with live combined odds / win % / edge / EV.
   3. Auto-build: search leg combinations under parlay-level constraints (legs, total odds, average leg
      odds, win %, edge, EV, per-game / per-sport / per-market limits, sports mix) and rank them.
   Tracked parlays live in Hub My Bets and My Stats and settle automatically from each sport's results. */
import { useEffect, useMemo, useState } from "react";
import { MultiSel, Sel, mono } from "../core/ui";
import { HUB_SPORT, HUB_SPORTS } from "../hub/sports";
import { useHubBets } from "../hub/useHubBets";
import { HubHeader } from "../hub/common";
import { DEFAULT_BUILD, EMPTY_POOL_FILTERS, RANK_BY, boardLogLegs, buildParlays, combineLegs, dedupeLegs, filterPool, fmtOdds, fmtPct, myBetLegs, started } from "./model";
import { legSetKey, syncParlayResults, trackParlay, useParlays } from "./store";
import { LegRow, ParlayNumbers } from "./ParlayCard";

const SPORT_LABELS = Object.fromEntries(HUB_SPORTS.map((s) => [s.id, `${s.icon} ${s.label}`]));
const kickLabel = (l) => {
  const s = started(l);
  if (s == null) return "—";
  if (s) return "started";
  const d = new Date(l.gameTimeIso);
  return d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
};

function Num({ label, v, onChange, placeholder = "any", w = "w-20", title }) {
  return (
    <label className="text-xs text-slate-400 flex flex-col gap-1" title={title}>{label}
      <input value={v} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} inputMode="decimal" className={`bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm ${w} text-slate-100`} />
    </label>
  );
}
function Toggle({ label, on, onChange, title }) {
  return (
    <label className="text-xs text-slate-400 flex flex-col gap-1" title={title}>{label}
      <button onClick={() => onChange(!on)} className={`text-xs rounded px-3 py-1.5 border font-medium ${on ? "border-sky-600 bg-sky-950 text-sky-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`}>{on ? "on" : "off"}</button>
    </label>
  );
}
function Panel({ n, title, right = null, children }) {
  return (
    <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-3">
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <div className="text-sm font-bold"><span className="text-slate-500 mr-1.5">{n}</span>{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}

export default function ParlayBuilder({ active = true, navigate = null }) {
  const allBets = useHubBets();
  const parlays = useParlays();
  const [source, setSource] = useState("board");
  const [boardRows, setBoardRows] = useState({}); // sport id -> board log legs
  const [loadedAt, setLoadedAt] = useState(null);
  const [f, setF] = useState(EMPTY_POOL_FILTERS);
  const [showMore, setShowMore] = useState(false);
  const [pinned, setPinned] = useState(new Map());   // poolId -> leg
  const [excluded, setExcluded] = useState(new Set());
  const [slip, setSlip] = useState(new Map());       // poolId -> leg
  const [slipUnits, setSlipUnits] = useState("1");
  const [opts, setOpts] = useState(DEFAULT_BUILD);
  const [built, setBuilt] = useState({ results: [], msg: "" });
  const [trackUnits, setTrackUnits] = useState("1");
  const setFilter = (patch) => setF((p) => ({ ...p, ...patch }));
  const setOpt = (patch) => setOpts((p) => ({ ...p, ...patch }));

  // read every sport's board log whenever the page is opened (sport pages keep adding to it)
  async function loadBoardLogs() {
    const out = {};
    for (const s of HUB_SPORTS) {
      try { await s.sport.storage.boardLogReady; out[s.id] = boardLogLegs(s.sport, s.sport.storage.loadBoardLog()); } catch { out[s.id] = []; }
    }
    setBoardRows(out); setLoadedAt(new Date());
  }
  useEffect(() => { if (active) { void loadBoardLogs(); void syncParlayResults(HUB_SPORTS); } }, [active]);

  const rawLegs = useMemo(() => {
    const per = source === "board" ? boardRows : Object.fromEntries(HUB_SPORTS.map((s) => [s.id, myBetLegs(s.sport, allBets[s.id])]));
    return dedupeLegs(HUB_SPORTS.flatMap((s) => per[s.id] || []));
  }, [source, boardRows, allBets]);
  const counts = useMemo(() => Object.fromEntries(HUB_SPORTS.map((s) => [s.id, rawLegs.filter((l) => l.sport === s.id).length])), [rawLegs]);
  const facetBase = useMemo(() => (f.sports.length ? rawLegs.filter((l) => f.sports.includes(l.sport)) : rawLegs), [rawLegs, f.sports]);
  const markets = useMemo(() => [...new Set(facetBase.map((l) => l.market))].sort(), [facetBase]);
  const marketLabels = useMemo(() => Object.fromEntries(markets.map((m) => { const [sp, t] = m.split("|"); return [m, `${HUB_SPORT[sp] ? HUB_SPORT[sp].label : sp} · ${t}`]; })), [markets]);
  const sides = useMemo(() => [...new Set(facetBase.map((l) => l.side).filter(Boolean))].sort(), [facetBase]);
  const dates = useMemo(() => [...new Set(rawLegs.map((l) => l.date).filter(Boolean))].sort().reverse(), [rawLegs]);
  const pool = useMemo(() => filterPool(rawLegs, f, excluded), [rawLegs, f, excluded]);
  const moreCount = ["minOdds", "maxOdds", "minModel", "minEdge", "minEV"].filter((k) => f[k] !== "").length + (f.bestSide ? 0 : 1) + (f.live !== "include" ? 1 : 0);
  const filtersActive = JSON.stringify({ ...f, sort: "edge" }) !== JSON.stringify({ ...EMPTY_POOL_FILTERS, sort: "edge" });

  const toggleMap = (setFn, leg) => setFn((m) => { const n = new Map(m); if (n.has(leg.poolId)) n.delete(leg.poolId); else n.set(leg.poolId, leg); return n; });
  const exclude = (leg) => { setExcluded((s) => new Set([...s, leg.poolId])); setPinned((m) => { const n = new Map(m); n.delete(leg.poolId); return n; }); };

  const slipLegs = [...slip.values()];
  const slipC = slipLegs.length >= 2 ? combineLegs(slipLegs) : null;
  const trackedKeys = useMemo(() => new Set(parlays.map((p) => legSetKey(p.legs))), [parlays]);
  const openParlays = parlays.filter((p) => p.status === "open").length;

  function generate() {
    const { results, report } = buildParlays(pool, [...pinned.values()], opts);
    if (report.error) { setBuilt({ results: [], msg: report.error }); return; }
    const space = report.exact ? "" : " (sampled: too many combinations to check them all, so this is a random sample across the whole pool)";
    const cut = Object.entries(report.failed).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n.toLocaleString()} by ${k}`).join(", ");
    const asked = Number(opts.results) || 10;
    const msg = report.explored === 0
      ? `No combination fits the per-game / per-sport / per-market limits with ${report.pool} pooled legs. Loosen those limits or allow same-game legs.`
      : `Checked ${report.explored.toLocaleString()} combination(s) from ${report.pool} pooled legs${pinned.size ? ` + ${pinned.size} pinned` : ""}${space}. ${report.passed.toLocaleString()} met every constraint${cut ? ` (removed: ${cut})` : ""}. Showing ${results.length}, ranked by ${opts.rankBy === "ev" ? "EV" : RANK_BY[opts.rankBy].toLowerCase()}${opts.allowDup ? "" : ", no shared legs between results"}.${!opts.allowDup && results.length < asked && report.passed > results.length ? ` Only ${results.length} leg-disjoint parlay(s) exist here; turn on "allow shared legs" to see more.` : ""}`;
    setBuilt({ results, msg });
  }

  const head = "p-1.5 font-normal";
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <div className="max-w-6xl mx-auto px-4 pb-28">
        <HubHeader title="PARLAY" accent="BUILDER" sub="every sport's board log or your open bets · combined EV / edge · auto-build under your constraints" />
        <div className="text-[11px] text-slate-500 mt-3 mb-3 leading-relaxed">
          Legs carry their own sport model's win %, de-vigged fair %, edge and EV. Combined win % assumes legs are independent; same-game legs (<span className="text-amber-400 font-bold">SGP</span>) are correlated, so treat their combined EV as optimistic. Board-log legs are priced at the odds first logged that day.
          {openParlays > 0 && <> · <button onClick={() => navigate && navigate("bets")} className="text-emerald-400 hover:underline">{openParlays} open parlay{openParlays === 1 ? "" : "s"} in My Bets</button></>}
        </div>

        <div className="space-y-4">
          {/* ---------------- 1. leg pool ---------------- */}
          <Panel n="1" title={`Leg pool (${pool.length} of ${rawLegs.length})`}
            right={<div className="text-[11px] text-slate-500" style={mono}>
              {HUB_SPORTS.map((s) => `${s.label} ${counts[s.id]}`).join(" · ")}
              {source === "board" && <> · {loadedAt ? `read ${loadedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "reading…"} <button onClick={loadBoardLogs} className="text-sky-400 hover:underline">reload</button></>}
            </div>}>
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <Sel compact label="source" v={source} opts={["board", "mybets"]} labels={{ board: "Board log (unsettled)", mybets: "My Bets (open)" }} onChange={setSource} />
              <MultiSel compact label="sport" selected={f.sports} opts={HUB_SPORTS.map((s) => s.id)} labels={SPORT_LABELS} onChange={(v) => setFilter({ sports: v, markets: [] })} />
              <Sel compact label="market" v={f.cls} opts={["all", "props", "lines"]} labels={{ all: "All markets", props: "Player props", lines: "Game lines" }} onChange={(v) => setFilter({ cls: v })} />
              <MultiSel compact label="category" selected={f.markets} opts={markets} labels={marketLabels} onChange={(v) => setFilter({ markets: v })} />
              <MultiSel compact label="side" selected={f.sides} opts={sides} onChange={(v) => setFilter({ sides: v })} />
              <Sel compact label="date" v={f.date} opts={["all", ...dates]} labels={{ all: "All dates" }} onChange={(v) => setFilter({ date: v })} />
              <Sel compact label="kickoff" v={f.kickoff} opts={["upcoming", "any", "started"]} labels={{ upcoming: "Not started", any: "Any", started: "Started" }} onChange={(v) => setFilter({ kickoff: v })} />
              <Sel compact label="sort" v={f.sort} opts={["edge", "ev", "model", "odds_long", "odds_short", "kickoff"]} labels={{ edge: "Edge ↓", ev: "EV ↓", model: "Model % ↓", odds_long: "Longest odds", odds_short: "Shortest odds", kickoff: "Kickoff" }} onChange={(v) => setFilter({ sort: v })} />
              <input value={f.search} onChange={(e) => setFilter({ search: e.target.value })} placeholder="search player, game, market" className="bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-sm w-48 text-slate-100" />
              <button onClick={() => setShowMore((s) => !s)} className={`text-xs rounded px-2.5 py-1.5 border ${showMore || moreCount ? "border-emerald-700 text-emerald-300" : "border-slate-700 text-slate-400 hover:text-slate-200"}`}>more{moreCount ? ` (${moreCount})` : ""} {showMore ? "▴" : "▾"}</button>
              {filtersActive && <button onClick={() => setF((p) => ({ ...EMPTY_POOL_FILTERS, sort: p.sort }))} className="text-[11px] text-slate-400 hover:text-rose-300 border border-slate-700 rounded px-2.5 py-1.5">clear</button>}
            </div>
            {showMore && (
              <div className="flex items-end gap-3 flex-wrap mb-2 p-2.5 rounded-lg bg-slate-900/40 border border-slate-800">
                <Num label="leg odds min" v={f.minOdds} onChange={(v) => setFilter({ minOdds: v })} placeholder="-300" />
                <Num label="leg odds max" v={f.maxOdds} onChange={(v) => setFilter({ maxOdds: v })} placeholder="+300" />
                <Num label="min model %" v={f.minModel} onChange={(v) => setFilter({ minModel: v })} />
                <Num label="min edge %" v={f.minEdge} onChange={(v) => setFilter({ minEdge: v })} />
                <Num label="min EV %" v={f.minEV} onChange={(v) => setFilter({ minEV: v })} />
                <Toggle label="best side only" on={f.bestSide} onChange={(v) => setFilter({ bestSide: v })} title="Both sides of a market are logged; keep only the side the model likes most (by EV)" />
                <label className="text-xs text-slate-400 flex flex-col gap-1">in-game snapshots
                  <select value={f.live} onChange={(e) => setFilter({ live: e.target.value })} className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm">
                    <option value="include">include</option><option value="exclude">exclude</option><option value="only">only</option>
                  </select>
                </label>
              </div>
            )}
            {(pinned.size > 0 || excluded.size > 0) && (
              <div className="text-[11px] text-slate-400 mb-2 flex gap-3 flex-wrap">
                {pinned.size > 0 && <span>📌 {pinned.size} pinned into every auto-built parlay <button onClick={() => setPinned(new Map())} className="text-slate-500 hover:text-rose-300 ml-1">clear</button></span>}
                {excluded.size > 0 && <span>⛔ {excluded.size} excluded <button onClick={() => setExcluded(new Set())} className="text-slate-500 hover:text-rose-300 ml-1">restore</button></span>}
              </div>
            )}
            <div className="overflow-x-auto max-h-96 overflow-y-auto border border-slate-800 rounded-lg">
              <table className="w-full text-xs" style={mono}>
                <thead className="sticky top-0 bg-slate-950 z-10">
                  <tr className="text-slate-500 text-left">
                    <th className={head} title="slip · pin · exclude">slip 📌 ⛔</th><th className={head}></th><th className={head}>date</th><th className={head}>game</th><th className={head}>leg</th><th className={head}>market</th><th className={head}>line</th>
                    <th className={head}>odds</th><th className={head}>model</th><th className={head}>edge</th><th className={head}>EV</th><th className={head}>kickoff</th>
                  </tr>
                </thead>
                <tbody>
                  {pool.slice(0, 300).map((l) => (
                    <tr key={l.poolId} className={`border-t border-slate-900 hover:bg-slate-900/60 ${slip.has(l.poolId) ? "bg-emerald-950/40" : ""}`}>
                      <td className="p-1.5 whitespace-nowrap">
                        <input type="checkbox" checked={slip.has(l.poolId)} onChange={() => toggleMap(setSlip, l)} title="Add to slip" />
                        <button onClick={() => toggleMap(setPinned, l)} className={`ml-2 ${pinned.has(l.poolId) ? "" : "opacity-30 hover:opacity-80"}`} title="Pin into every auto-built parlay">📌</button>
                        <button onClick={() => exclude(l)} className="ml-1.5 opacity-30 hover:opacity-80" title="Exclude from the pool">⛔</button>
                      </td>
                      <td className="p-1.5">{HUB_SPORT[l.sport] ? HUB_SPORT[l.sport].icon : l.sport}</td>
                      <td className="p-1.5 text-slate-400">{l.date ? l.date.slice(5) : ""}</td>
                      <td className="p-1.5 max-w-[8rem] truncate" title={l.game}>{l.game}</td>
                      <td className="p-1.5 max-w-[10rem] truncate" title={l.name}>{l.name || l.game} <span className="text-slate-500 uppercase">{l.side}</span>{l.live ? <span className="text-rose-400 ml-1" title="logged while the game was in progress">live</span> : null}</td>
                      <td className="p-1.5">{l.type}</td>
                      <td className="p-1.5">{l.line}</td>
                      <td className="p-1.5">{fmtOdds(l.odds)}</td>
                      <td className="p-1.5">{fmtPct(l.modelP)}</td>
                      <td className={`p-1.5 ${l.edge != null && l.edge > 0 ? "text-emerald-400" : ""}`}>{fmtPct(l.edge)}</td>
                      <td className={`p-1.5 ${l.ev != null && l.ev > 0 ? "text-emerald-400" : ""}`}>{fmtPct(l.ev)}</td>
                      <td className="p-1.5 text-slate-400 whitespace-nowrap" title={l.loggedAt ? `logged ${new Date(l.loggedAt).toLocaleString()}` : undefined}>{kickLabel(l)}</td>
                    </tr>
                  ))}
                  {pool.length === 0 && (
                    <tr><td colSpan={12} className="p-4 text-center text-slate-500">
                      {rawLegs.length === 0
                        ? (source === "board" ? "No unsettled board-log legs yet. Load games and pull odds on a sport's Slate; every priced prop is logged automatically." : "No open tracked bets. Track bets from a sport's Board.")
                        : "No legs match these filters."}
                    </td></tr>
                  )}
                </tbody>
              </table>
              {pool.length > 300 && <div className="text-[10px] text-slate-500 p-1.5">showing the first 300 of {pool.length}; narrow the filters to see the rest (auto-build uses the whole pool)</div>}
            </div>
          </Panel>

          {/* ---------------- 2. slip ---------------- */}
          <Panel n="2" title={`Slip${slipLegs.length ? ` (${slipLegs.length} leg${slipLegs.length === 1 ? "" : "s"})` : ""}`}
            right={slipLegs.length > 0 && <button onClick={() => setSlip(new Map())} className="text-[11px] text-slate-400 hover:text-rose-300">clear slip</button>}>
            {slipLegs.length === 0 ? (
              <div className="text-[11px] text-slate-500">Tick legs in the pool to build a parlay by hand, or send an auto-built parlay here to tweak it.</div>
            ) : (
              <>
                <div className="rounded-lg border border-slate-800 overflow-hidden mb-2">
                  {slipLegs.map((l, j) => <LegRow key={l.poolId} leg={l} index={j} right={<button onClick={() => toggleMap(setSlip, l)} className="text-slate-600 hover:text-rose-400 text-lg leading-none" title="Remove from slip">×</button>} />)}
                </div>
                {slipC ? (
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <ParlayNumbers legs={slipLegs.length} american={slipC.american} modelP={slipC.modelP} edge={slipC.edge} ev={slipC.ev} sgp={slipC.sgp} />
                    <span className="text-slate-500 text-xs" style={mono}>avg leg {fmtOdds(slipC.avgAmerican)}</span>
                    <span className="ml-auto flex items-center gap-2">
                      <label className="text-[10px] text-slate-500 flex items-center gap-1">units<input value={slipUnits} onChange={(e) => setSlipUnits(e.target.value)} inputMode="decimal" className="w-12 bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-xs text-slate-100" style={mono} /></label>
                      {trackedKeys.has(legSetKey(slipLegs))
                        ? <span className="text-xs text-slate-500">Tracked ✓</span>
                        : <button onClick={() => { trackParlay({ legs: slipLegs, ...slipC }, Math.max(0, Number(slipUnits) || 1)); setSlip(new Map()); }} className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-lg px-3 py-1.5">Track parlay</button>}
                    </span>
                  </div>
                ) : <div className="text-[11px] text-slate-500">Add at least one more leg.</div>}
              </>
            )}
          </Panel>

          {/* ---------------- 3. auto-build ---------------- */}
          <Panel n="3" title="Auto-build">
            <div className="grid gap-3 md:grid-cols-2 mb-3">
              <div className="p-2.5 rounded-lg bg-slate-900/40 border border-slate-800">
                <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">LEGS & ODDS</div>
                <div className="flex items-end gap-3 flex-wrap">
                  <Num label="legs min" v={opts.minLegs} onChange={(v) => setOpt({ minLegs: v })} placeholder="2" w="w-16" />
                  <Num label="legs max" v={opts.maxLegs} onChange={(v) => setOpt({ maxLegs: v })} placeholder="4" w="w-16" />
                  <Num label="total odds min" v={opts.minTotalOdds} onChange={(v) => setOpt({ minTotalOdds: v })} placeholder="+200" />
                  <Num label="total odds max" v={opts.maxTotalOdds} onChange={(v) => setOpt({ maxTotalOdds: v })} placeholder="+1500" />
                  <Num label="avg leg odds min" v={opts.minAvgOdds} onChange={(v) => setOpt({ minAvgOdds: v })} placeholder="-200" title="Average of the legs' odds (averaged as payouts, shown as American)" />
                  <Num label="avg leg odds max" v={opts.maxAvgOdds} onChange={(v) => setOpt({ maxAvgOdds: v })} placeholder="+150" title="Average of the legs' odds (averaged as payouts, shown as American)" />
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-slate-900/40 border border-slate-800">
                <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">PARLAY QUALITY</div>
                <div className="flex items-end gap-3 flex-wrap">
                  <Num label="min win %" v={opts.minModel} onChange={(v) => setOpt({ minModel: v })} title="Combined model win probability" />
                  <Num label="min edge %" v={opts.minEdge} onChange={(v) => setOpt({ minEdge: v })} title="Combined model % minus combined fair %" />
                  <Num label="min EV %" v={opts.minEV} onChange={(v) => setOpt({ minEV: v })} title="0 = only +EV parlays (never a negative-EV result). Set a higher number to demand more, or leave blank for no floor." />
                  <label className="text-xs text-slate-400 flex flex-col gap-1">rank by
                    <select value={opts.rankBy} onChange={(e) => setOpt({ rankBy: e.target.value })} className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm">
                      {Object.entries(RANK_BY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </label>
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-slate-900/40 border border-slate-800">
                <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">MIX</div>
                <div className="flex items-end gap-3 flex-wrap">
                  <Toggle label="same-game legs" on={opts.sgp} onChange={(v) => setOpt({ sgp: v })} title="Allow more than one leg from the same game (correlated)" />
                  {opts.sgp && <Num label="max / game" v={opts.maxPerGame} onChange={(v) => setOpt({ maxPerGame: v })} placeholder="2" w="w-16" />}
                  <Num label="max / sport" v={opts.maxPerSport} onChange={(v) => setOpt({ maxPerSport: v })} w="w-16" />
                  <Num label="max / market" v={opts.maxPerMarket} onChange={(v) => setOpt({ maxPerMarket: v })} w="w-16" title="Most legs from one sport's market (e.g. NBA Points)" />
                  <Num label="min sports" v={opts.minSports} onChange={(v) => setOpt({ minSports: v })} placeholder="1" w="w-16" title="Parlay must span at least this many sports" />
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-slate-900/40 border border-slate-800">
                <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">SEARCH</div>
                <div className="flex items-end gap-3 flex-wrap">
                  <Num label="pool size" v={opts.poolCap} onChange={(v) => setOpt({ poolCap: v })} placeholder="25" w="w-16" title="How many of the pool's top legs (in the pool's sort order) the search combines. Bigger = more options, coarser search." />
                  <Num label="results" v={opts.results} onChange={(v) => setOpt({ results: v })} placeholder="10" w="w-16" />
                  <Toggle label="allow shared legs" on={opts.allowDup} onChange={(v) => setOpt({ allowDup: v })} title="Off: no two results share a leg, so they're independent picks. On: pure top-N." />
                  <button onClick={() => setOpts(DEFAULT_BUILD)} className="text-[11px] text-slate-400 hover:text-rose-300 border border-slate-700 rounded px-2.5 py-1.5">reset</button>
                  <button onClick={generate} disabled={pool.length + pinned.size === 0} className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-bold text-sm rounded-lg px-3 py-1.5">Build parlays</button>
                </div>
              </div>
            </div>
            {built.msg && <div className="text-[11px] text-slate-400 mb-2">{built.msg}</div>}
            {built.results.length > 0 && (
              <div className="flex items-center gap-2 mb-2 text-[11px] text-slate-500">
                track at <input value={trackUnits} onChange={(e) => setTrackUnits(e.target.value)} inputMode="decimal" className="w-12 bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-100" style={mono} /> units
              </div>
            )}
            <div className="space-y-2">
              {built.results.map((c, i) => {
                const already = trackedKeys.has(legSetKey(c.legs));
                return (
                  <div key={i} className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                    <div className="flex flex-wrap items-center gap-3 text-sm mb-1.5">
                      <span className="font-bold text-slate-500">#{i + 1}</span>
                      <ParlayNumbers legs={c.legs.length} american={c.american} modelP={c.modelP} edge={c.edge} ev={c.ev} sgp={c.sgp} />
                      <span className="text-slate-500 text-xs" style={mono}>avg leg {fmtOdds(c.avgAmerican)} · {c.sports.map((s) => (HUB_SPORT[s] ? HUB_SPORT[s].icon : s)).join("")}</span>
                      <span className="ml-auto flex gap-2">
                        <button onClick={() => setSlip(new Map(c.legs.map((l) => [l.poolId, l])))} className="text-xs border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-300 hover:border-slate-500">Edit in slip</button>
                        <button onClick={() => !already && trackParlay(c, Math.max(0, Number(trackUnits) || 1))} disabled={already}
                          className={`font-bold text-xs rounded-lg px-3 py-1.5 ${already ? "bg-slate-800 text-slate-500 cursor-not-allowed" : "bg-emerald-600 hover:bg-emerald-500 text-white"}`}>{already ? "Tracked ✓" : "Track"}</button>
                      </span>
                    </div>
                    <div className="rounded-lg border border-slate-800 overflow-hidden">
                      {c.legs.map((l, j) => <LegRow key={j} leg={l} index={j} right={pinned.has(l.poolId) ? <span title="pinned">📌</span> : null} />)}
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
