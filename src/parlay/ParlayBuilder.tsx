/* Parlay builder (hub). Builds parlays from legs every sport already saved, with no CSVs:
     - Board log: every unsettled board-log row from MLB, NFL, NBA and NHL (each priced by its sport's model)
     - My bets:   every open tracked bet
   1. Leg pool (left): filter legs on every factor; add a leg to the slip, pin it into every auto-built
      parlay, or exclude it.
   2. Slip (right): build a parlay by hand with live combined odds / win % / edge / EV.
   3. Auto-build (right): search leg combinations under parlay-level constraints (legs, total odds, average
      leg odds, win %, edge, EV, per-game / per-sport / per-market limits, sports mix) and rank them.
   Tracked parlays live in My bets and My stats and settle automatically from each sport's results. */
import React, { useEffect, useMemo, useState } from "react";
import { Ban, Check, ListFilter, Pin, Plus, RefreshCw, RotateCcw, X } from "lucide-react";
import { HUB_SPORT, HUB_SPORTS } from "../hub/sports";
import { useHubBets } from "../hub/useHubBets";
import { HubTop } from "../hub/common";
import { DEFAULT_BUILD, EMPTY_POOL_FILTERS, RANK_BY, boardLogLegs, buildParlays, combineLegs, dedupeLegs, filterPool, myBetLegs, started } from "./model";
import { legSetKey, syncParlayResults, trackParlay, useParlays } from "./store";
import { LegRow, ParlayNumbers, legPick } from "./ParlayCard";
import { Badge, Btn, Empty, Field, MultiPick, Pop, SearchField, Seg, Select, SportIcon, Stat, Switch, TextIn, cx, fDay, fNum, fOdds, fPct, fSigned, toast, tone } from "../ui/kit";

const SPORT_LABELS = Object.fromEntries(HUB_SPORTS.map((s) => [s.id, s.label]));
const kickLabel = (l) => {
  const s = started(l);
  if (s == null) return l.date ? fDay(l.date) : "";
  if (s) return "Started";
  return new Date(l.gameTimeIso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
};
const Opt = ({ label, title, children }) => <label className="stack" title={title}><span className="label">{label}</span>{children}</label>;
const Num = ({ label, v, onChange, placeholder = "any", title }) => <Opt label={label} title={title}><TextIn className="field sm num" value={v} onChange={onChange} placeholder={placeholder} /></Opt>;

export default function ParlayBuilder({ active = true, navigate = null }) {
  const allBets = useHubBets();
  const parlays = useParlays();
  const [source, setSource] = useState("board");
  const [boardRows, setBoardRows] = useState({}); // sport id -> board log legs
  const [loadedAt, setLoadedAt] = useState(null);
  const [f, setF] = useState(EMPTY_POOL_FILTERS);
  const [pinned, setPinned] = useState(new Map());   // poolId -> leg
  const [excluded, setExcluded] = useState(new Set());
  const [slip, setSlip] = useState(new Map());       // poolId -> leg
  const [slipUnits, setSlipUnits] = useState("1");
  const [opts, setOpts] = useState(DEFAULT_BUILD);
  const [built, setBuilt] = useState({ results: [], msg: "" });
  const [trackUnits, setTrackUnits] = useState("1");
  const setFilter = (patch) => setF((p) => ({ ...p, ...patch }));
  const setOpt = (patch) => setOpts((p) => ({ ...p, ...patch }));
  // Start fresh: the whole workspace back to defaults (filters, slip, pins, exclusions, auto-build
  // settings and results) and the board logs re-read. Tracked parlays are not touched.
  function startFresh() {
    setSource("board"); setF(EMPTY_POOL_FILTERS);
    setPinned(new Map()); setExcluded(new Set()); setSlip(new Map()); setSlipUnits("1");
    setOpts(DEFAULT_BUILD); setBuilt({ results: [], msg: "" }); setTrackUnits("1");
    void loadBoardLogs();
    toast("Parlay builder reset. Tracked parlays are kept.");
  }

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
  const marketLabels = useMemo(() => Object.fromEntries(markets.map((m) => { const [sp, t] = m.split("|"); return [m, `${HUB_SPORT[sp] ? HUB_SPORT[sp].label : sp}: ${t}`]; })), [markets]);
  const sides = useMemo(() => [...new Set(facetBase.map((l) => l.side).filter(Boolean))].sort(), [facetBase]);
  const dates = useMemo(() => [...new Set(rawLegs.map((l) => l.date).filter(Boolean))].sort().reverse(), [rawLegs]);
  const pool = useMemo(() => filterPool(rawLegs, f, excluded), [rawLegs, f, excluded]);
  const moreCount = ["minOdds", "maxOdds", "minModel", "minEdge", "minEV"].filter((k) => f[k] !== "").length + (f.live !== "include" ? 1 : 0) + (f.cls !== "all" ? 1 : 0) + (f.sides.length ? 1 : 0) + (f.date !== "all" ? 1 : 0) + (f.kickoff !== "upcoming" ? 1 : 0);
  const filtersActive = JSON.stringify({ ...f, sort: "edge" }) !== JSON.stringify({ ...EMPTY_POOL_FILTERS, sort: "edge" });

  const toggleMap = (setFn, leg) => setFn((m) => { const n = new Map(m); if (n.has(leg.poolId)) n.delete(leg.poolId); else n.set(leg.poolId, leg); return n; });
  const exclude = (leg) => { setExcluded((s) => new Set([...s, leg.poolId])); setPinned((m) => { const n = new Map(m); n.delete(leg.poolId); return n; }); };

  const slipLegs = [...slip.values()];
  const slipC = slipLegs.length >= 2 ? combineLegs(slipLegs) : null;
  const trackedKeys = useMemo(() => new Set(parlays.map((p) => legSetKey(p.legs))), [parlays]);
  const openParlays = parlays.filter((p) => p.status === "open").length;
  const slipStake = Math.max(0, Number(slipUnits) || 0);

  function generate() {
    const { results, report } = buildParlays(pool, [...pinned.values()], opts);
    if (report.error) { setBuilt({ results: [], msg: report.error }); return; }
    const space = report.exact ? "" : " This is a random sample across the whole pool, because there are too many combinations to check them all.";
    const cut = Object.entries(report.failed).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n.toLocaleString()} by ${k}`).join(", ");
    const asked = Number(opts.results) || 10;
    const msg = report.explored === 0
      ? `No combination fits the per-game, per-sport and per-market limits with ${report.pool} pooled legs. Loosen those limits or allow same-game legs.`
      : `Checked ${report.explored.toLocaleString()} combination${report.explored === 1 ? "" : "s"} from ${report.pool} pooled legs${pinned.size ? ` plus ${pinned.size} pinned` : ""}.${space} ${report.passed.toLocaleString()} met every constraint${cut ? ` (removed: ${cut})` : ""}. Showing ${results.length}, ranked by ${opts.rankBy === "ev" ? "EV" : RANK_BY[opts.rankBy].toLowerCase()}${opts.allowDup ? "" : ", with no leg shared between results"}.${!opts.allowDup && results.length < asked && report.passed > results.length ? ` Only ${results.length} parlay${results.length === 1 ? "" : "s"} with no shared legs exist here. Turn on "Allow shared legs" to see more.` : ""}`;
    setBuilt({ results, msg });
  }
  function track(c, units) { trackParlay(c, Math.max(0, Number(units) || 1)); toast("Parlay tracked. It has its own record in My bets."); }

  return (
    <>
      <HubTop title="Parlay builder">
        {openParlays > 0 ? <Btn kind="ghost" onClick={() => navigate && navigate("bets")}>{openParlays} open parlay{openParlays === 1 ? "" : "s"} in My bets</Btn> : null}
        <Btn onClick={startFresh} title="Reset filters, slip, pins, exclusions, auto-build settings and results. Tracked parlays are kept."><RotateCcw /><span className="hide-s">Start fresh</span></Btn>
      </HubTop>
      <div className="screen"><div className="scroll"><div className="split">
        <div style={{ minWidth: 0 }}>
          <div className="bar">
            <Seg label="Source" value={source} onChange={setSource} options={[["board", "Board log"], ["mybets", "My open bets"]]} />
            <MultiPick label="Sports" selected={f.sports} options={HUB_SPORTS.map((s) => s.id)} labels={SPORT_LABELS} onChange={(v) => setFilter({ sports: v, markets: [] })} />
            <MultiPick label="Markets" selected={f.markets} options={markets} labels={marketLabels} onChange={(v) => setFilter({ markets: v })} />
            <SearchField value={f.search} onChange={(search) => setFilter({ search })} placeholder="Search player, game, market" width={210} />
            <Pop width={330} button={(o, t) => <Btn on={o || moreCount > 0} onClick={t}><ListFilter />Filters{moreCount ? ` (${moreCount})` : ""}</Btn>}>
              <label className="frow" style={{ gridTemplateColumns: "1fr 160px" }}><span>Type</span><Select sm label="Type" value={f.cls} onChange={(cls) => setFilter({ cls })} options={[["all", "All markets"], ["props", "Player props"], ["lines", "Game lines"]]} /></label>
              <label className="frow" style={{ gridTemplateColumns: "1fr 160px" }}><span>Date</span><Select sm label="Date" value={f.date} onChange={(date) => setFilter({ date })} options={[["all", "All dates"], ...dates.map((d) => [d, fDay(d)])]} /></label>
              <label className="frow" style={{ gridTemplateColumns: "1fr 160px" }}><span>Start</span><Select sm label="Start" value={f.kickoff} onChange={(kickoff) => setFilter({ kickoff })} options={[["upcoming", "Not started"], ["any", "Any"], ["started", "Started"]]} /></label>
              <label className="frow" style={{ gridTemplateColumns: "1fr 160px" }}><span>In-game snapshots</span><Select sm label="In-game snapshots" value={f.live} onChange={(live) => setFilter({ live })} options={[["include", "Include"], ["exclude", "Exclude"], ["only", "Only"]]} /></label>
              <div className="row wrap"><span className="mid grow">Sides</span><MultiPick label="Any side" selected={f.sides} options={sides} onChange={(v) => setFilter({ sides: v })} /></div>
              <Field label="Leg odds no shorter than"><TextIn value={f.minOdds} onChange={(minOdds) => setFilter({ minOdds })} placeholder="-300" /></Field>
              <Field label="Leg odds no longer than"><TextIn value={f.maxOdds} onChange={(maxOdds) => setFilter({ maxOdds })} placeholder="+300" /></Field>
              <Field label="Minimum model %"><TextIn value={f.minModel} onChange={(minModel) => setFilter({ minModel })} /></Field>
              <Field label="Minimum edge %"><TextIn value={f.minEdge} onChange={(minEdge) => setFilter({ minEdge })} /></Field>
              <Field label="Minimum EV %"><TextIn value={f.minEV} onChange={(minEV) => setFilter({ minEV })} /></Field>
            </Pop>
            <Switch on={f.bestSide} onChange={(bestSide) => setFilter({ bestSide })} title="Both sides of a market are logged. Keep only the side the model likes most, by EV.">Best side only</Switch>
            <Select label="Sort" value={f.sort} onChange={(sort) => setFilter({ sort })} options={[["edge", "Edge, high to low"], ["ev", "EV, high to low"], ["model", "Model, high to low"], ["odds_long", "Longest odds"], ["odds_short", "Shortest odds"], ["kickoff", "Start time"]]} />
            {filtersActive ? <Btn sm kind="ghost" onClick={() => setF((p) => ({ ...EMPTY_POOL_FILTERS, sort: p.sort }))}>Clear</Btn> : null}
          </div>
          <div className="bar tight">
            <span className="note num">{pool.length.toLocaleString()} of {rawLegs.length.toLocaleString()} legs. {HUB_SPORTS.map((s) => `${s.label} ${counts[s.id].toLocaleString()}`).join(", ")}.</span>
            {pinned.size > 0 ? <span className="chip">{pinned.size} pinned<button type="button" aria-label="Clear pins" title="Clear pins" onClick={() => setPinned(new Map())}><X /></button></span> : null}
            {excluded.size > 0 ? <span className="chip">{excluded.size} excluded<button type="button" aria-label="Restore excluded legs" title="Restore excluded legs" onClick={() => setExcluded(new Set())}><X /></button></span> : null}
            <span className="grow" />
            {source === "board" ? <><span className="note num hide-s">{loadedAt ? `Board logs read ${loadedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Reading the board logs"}</span><Btn sm kind="ghost" onClick={loadBoardLogs}><RefreshCw />Reload</Btn></> : null}
          </div>
          {pool.length === 0 ? (
            <Empty title={rawLegs.length === 0 ? "No legs to build from" : "No legs match these filters"} action={rawLegs.length ? <Btn onClick={() => setF((p) => ({ ...EMPTY_POOL_FILTERS, sort: p.sort }))}>Clear filters</Btn> : null}>
              {rawLegs.length === 0 ? (source === "board" ? "Legs come from unsettled plays in each sport's board log. Pull odds on a sport's Slate and every priced play is logged automatically." : "No open tracked bets. Track plays from a sport's Board.") : null}
            </Empty>
          ) : (
            <table className="tbl dense">
              <thead><tr><th style={{ width: 96 }} title="Add to the slip, pin into every auto-built parlay, or exclude from the pool">Slip, pin, skip</th><th>Leg</th><th>Pick</th><th className="hide-s hide-m">Game</th><th className="hide-s">Starts</th><th className="r">Odds</th><th className="r">Model</th><th className="r" title="Expected return per unit. Hover a value for the edge.">EV</th></tr></thead>
              <tbody>{pool.slice(0, 300).map((l) => { const on = slip.has(l.poolId), pin = pinned.has(l.poolId); return (
                <tr key={l.poolId} className={on ? "open" : ""}>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <Btn sm icon on={on} kind={on ? "" : "ghost"} aria-label={on ? "Remove from the slip" : "Add to the slip"} title={on ? "Remove from the slip" : "Add to the slip"} onClick={() => toggleMap(setSlip, l)}>{on ? <Check /> : <Plus />}</Btn>
                    <Btn sm icon on={pin} kind={pin ? "" : "ghost"} aria-label={pin ? "Unpin" : "Pin into every auto-built parlay"} title={pin ? "Pinned into every auto-built parlay. Click to unpin." : "Pin into every auto-built parlay"} onClick={() => toggleMap(setPinned, l)}><Pin /></Btn>
                    <Btn sm icon kind="ghost" aria-label="Exclude from the pool" title="Exclude from the pool" onClick={() => exclude(l)}><Ban /></Btn>
                  </td>
                  <td><span className="mid" style={{ display: "inline-block", verticalAlign: "-3px", marginRight: 8 }} title={SPORT_LABELS[l.sport] || l.sport}><SportIcon sport={l.sport} size={15} /></span>{l.isLine || !l.name ? <span className="dim">Game line</span> : <span className="name trunc" style={{ maxWidth: 118, display: "inline-block", verticalAlign: "bottom" }}>{l.name}</span>}{l.live ? <> <Badge kind="live" title="Logged while the game was in progress">Live</Badge></> : null}</td>
                  <td className="pick"><span className="trunc" style={{ maxWidth: 156, display: "inline-block", verticalAlign: "bottom" }}><b>{legPick(l)}</b> <span className="mid">{l.type}</span></span></td>
                  <td className="mid hide-s hide-m">{String(l.game).replace("@", " at ")}</td><td className="num mid hide-s" title={l.loggedAt ? `Logged ${new Date(l.loggedAt).toLocaleString()}` : undefined}>{kickLabel(l)}</td>
                  <td className="r num">{fOdds(l.odds)}</td><td className="r num">{fPct(l.modelP)}</td><td className={cx("r num", tone(l.ev))} style={{ fontWeight: 620 }} title={`Edge ${fSigned(l.edge)}`}>{fSigned(l.ev)}</td>
                </tr>); })}</tbody>
            </table>
          )}
          {pool.length > 300 ? <div className="note" style={{ padding: 14, textAlign: "center" }}>Showing the first 300 of {pool.length.toLocaleString()}. Narrow the filters to see the rest. Auto-build uses the whole pool.</div> : null}
        </div>

        <aside><div className="slip">
          <div>
            <div className="row"><div className="h2 grow">Slip{slipLegs.length ? `, ${slipLegs.length} leg${slipLegs.length === 1 ? "" : "s"}` : ""}</div>{slipLegs.length ? <Btn sm kind="ghost" onClick={() => setSlip(new Map())}>Clear</Btn> : null}</div>
            {!slipLegs.length ? <p className="note" style={{ marginTop: 8 }}>Add legs from the pool to build a parlay by hand, or send an auto-built parlay here to adjust it.</p> : (<>
              <div className="lineup" style={{ marginTop: 10 }}>{slipLegs.map((l) => <LegRow key={l.poolId} leg={l} right={<Btn sm icon kind="ghost" aria-label="Remove from the slip" title="Remove from the slip" onClick={() => toggleMap(setSlip, l)}><X /></Btn>} />)}</div>
              {slipC ? (<>
                <div className="stats" style={{ marginTop: 12, gridAutoFlow: "row", gridTemplateColumns: "1fr 1fr" }}>
                  <Stat k="Parlay odds" v={<span className="num">{fOdds(slipC.american)}</span>} />
                  <Stat k="Expected return" v={<span className="num">{fSigned(slipC.ev)}</span>} cls={tone(slipC.ev)} />
                </div>
                <dl className="kv num" style={{ marginTop: 12 }}>
                  <dt>Model win probability</dt><dd>{fPct(slipC.modelP)}</dd>
                  <dt>Market with the vig removed</dt><dd>{fPct(slipC.fairP)}</dd>
                  <dt>Edge</dt><dd className={tone(slipC.edge)}>{fSigned(slipC.edge)}</dd>
                  <dt>Average leg odds</dt><dd>{fOdds(slipC.avgAmerican)}</dd>
                  <dt>Stake</dt><dd><input className="cell num" aria-label="Units" inputMode="decimal" value={slipUnits} onChange={(e) => setSlipUnits(e.target.value)} /> u</dd>
                  <dt>To win</dt><dd>{fNum(slipStake * (slipC.decimal - 1), 2)}u</dd>
                </dl>
                {slipC.sgp ? <p className="note" style={{ marginTop: 10 }}><Badge kind="warn">Same game</Badge> Legs from one game move together, so the real edge is smaller than shown.</p> : null}
                {trackedKeys.has(legSetKey(slipLegs))
                  ? <Btn style={{ width: "100%", marginTop: 12 }} disabled><Check />Tracked</Btn>
                  : <Btn kind="primary" style={{ width: "100%", marginTop: 12 }} onClick={() => { track({ legs: slipLegs, ...slipC }, slipUnits); setSlip(new Map()); }}>Track parlay</Btn>}
              </>) : <p className="note" style={{ marginTop: 10 }}>Add at least one more leg.</p>}
            </>)}
          </div>

          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 16 }}>
            <div className="row"><div className="h2 grow">Auto-build</div><Btn sm kind="ghost" onClick={() => setOpts(DEFAULT_BUILD)}>Reset</Btn></div>
            <p className="note" style={{ margin: "4px 0 10px" }}>Searches the legs in the pool{pinned.size ? ` and keeps your ${pinned.size} pinned leg${pinned.size === 1 ? "" : "s"} in every result` : ""}. Combined win probability assumes the legs are independent.</p>
            <div className="label" style={{ marginBottom: 6 }}>Legs and odds</div>
            <div className="opts">
              <Num label="Fewest legs" v={opts.minLegs} onChange={(v) => setOpt({ minLegs: v })} placeholder="2" />
              <Num label="Most legs" v={opts.maxLegs} onChange={(v) => setOpt({ maxLegs: v })} placeholder="4" />
              <Num label="Total odds, at least" v={opts.minTotalOdds} onChange={(v) => setOpt({ minTotalOdds: v })} placeholder="+200" />
              <Num label="Total odds, at most" v={opts.maxTotalOdds} onChange={(v) => setOpt({ maxTotalOdds: v })} placeholder="+1500" />
              <Num label="Average leg odds, at least" v={opts.minAvgOdds} onChange={(v) => setOpt({ minAvgOdds: v })} placeholder="-200" title="Average of the legs' odds (averaged as payouts, shown as American)" />
              <Num label="Average leg odds, at most" v={opts.maxAvgOdds} onChange={(v) => setOpt({ maxAvgOdds: v })} placeholder="+150" title="Average of the legs' odds (averaged as payouts, shown as American)" />
            </div>
            <div className="label" style={{ margin: "12px 0 6px" }}>Parlay quality</div>
            <div className="opts">
              <Num label="Minimum win %" v={opts.minModel} onChange={(v) => setOpt({ minModel: v })} title="Combined model win probability" />
              <Num label="Minimum edge %" v={opts.minEdge} onChange={(v) => setOpt({ minEdge: v })} title="Combined model % minus combined market %" />
              <Num label="Minimum EV %" v={opts.minEV} onChange={(v) => setOpt({ minEV: v })} title="0 keeps only +EV parlays. Set a higher number to demand more, or leave it blank for no floor." />
              <Opt label="Rank by"><Select sm label="Rank by" value={opts.rankBy} onChange={(v) => setOpt({ rankBy: v })} options={Object.entries(RANK_BY)} /></Opt>
            </div>
            <div className="label" style={{ margin: "12px 0 6px" }}>Mix</div>
            <div className="opts">
              {opts.sgp ? <Num label="Most legs per game" v={opts.maxPerGame} onChange={(v) => setOpt({ maxPerGame: v })} placeholder="2" /> : null}
              <Num label="Most legs per sport" v={opts.maxPerSport} onChange={(v) => setOpt({ maxPerSport: v })} />
              <Num label="Most legs per market" v={opts.maxPerMarket} onChange={(v) => setOpt({ maxPerMarket: v })} title="Most legs from one sport's market, for example NBA Points" />
              <Num label="Fewest sports" v={opts.minSports} onChange={(v) => setOpt({ minSports: v })} placeholder="1" title="The parlay must span at least this many sports" />
              <Num label="Pool size" v={opts.poolCap} onChange={(v) => setOpt({ poolCap: v })} placeholder="25" title="How many of the pool's top legs, in the pool's sort order, the search combines. Bigger means more options and a coarser search." />
              <Num label="Results" v={opts.results} onChange={(v) => setOpt({ results: v })} placeholder="10" />
            </div>
            <div className="grid" style={{ gap: 8, margin: "12px 0" }}>
              <Switch on={opts.sgp} onChange={(sgp) => setOpt({ sgp })} title="Allow more than one leg from the same game. Those legs are correlated.">Allow same-game legs</Switch>
              <Switch on={opts.allowDup} onChange={(allowDup) => setOpt({ allowDup })} title="Off: no two results share a leg, so they are independent picks. On: the plain top results.">Allow shared legs between results</Switch>
            </div>
            <Btn kind="primary" style={{ width: "100%" }} disabled={pool.length + pinned.size === 0} onClick={generate}>Build parlays</Btn>
            {built.msg ? <p className="note" style={{ marginTop: 8 }}>{built.msg} <button type="button" className="link" onClick={() => setBuilt({ results: [], msg: "" })}>Clear results</button></p> : null}
            {built.results.length > 0 ? <label className="row note" style={{ marginTop: 10 }}>Track at <input className="cell num" style={{ width: 52 }} aria-label="Units for tracked results" inputMode="decimal" value={trackUnits} onChange={(e) => setTrackUnits(e.target.value)} /> units</label> : null}
            <div className="grid" style={{ gap: 10, marginTop: 10 }}>
              {built.results.map((c, i) => { const already = trackedKeys.has(legSetKey(c.legs)); return (
                <div className="lineup" key={i}>
                  <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)", display: "grid", gap: 8 }}>
                    <div className="row"><span className="dim num">{i + 1}</span><ParlayNumbers american={c.american} modelP={c.modelP} edge={c.edge} ev={c.ev} sgp={c.sgp} /></div>
                    <div className="row"><span className="note num grow">{c.legs.length} legs, average leg {fOdds(c.avgAmerican)}, {c.sports.map((s) => SPORT_LABELS[s] || s).join(" and ")}</span>
                      <Btn sm onClick={() => setSlip(new Map(c.legs.map((l) => [l.poolId, l])))}>Edit in slip</Btn>
                      {already ? <Btn sm disabled><Check />Tracked</Btn> : <Btn sm kind="primary" onClick={() => track(c, trackUnits)}>Track</Btn>}
                    </div>
                  </div>
                  {c.legs.map((l, j) => <LegRow key={j} leg={l} right={pinned.has(l.poolId) ? <span className="accent-t" title="Pinned"><Pin size={14} /></span> : null} />)}
                </div>); })}
            </div>
          </div>
        </div></aside>
      </div></div></div>
    </>
  );
}
