/* Hub · My bets: every sport's tracked bets in one place, filterable by sport. With one sport selected
   it is that sport's list (same filters, sorts, edits, CSV, backup, settle, line refresh). "All sports"
   merges the sports, with a sport mark on each row, followed by tracked parlays. "Parlays" shows only
   parlays (status / date / search / sort; the single-bet filters don't apply).
   Each sport's bets stay stored separately; parlays have their own store (src/parlay/store.ts). */
import React, { useEffect, useMemo, useState } from "react";
import { Download, HardDriveDownload, HardDriveUpload, ListFilter, RefreshCw, Trash2, X } from "lucide-react";
import { projMeta } from "../core/ui";
import { EMPTY_BET_FILTERS, betFacets, betFiltersActive, betsBackupJson, betsCsv, betStats, downloadText, fetchOpenBetResults, filterSortBets, gradeOpenBets, mergeRestored, newFromBackup, refreshBetLines } from "../core/bets";
import { HUB_SPORT, HUB_SPORTS } from "./sports";
import { getParlays, parlayDate, parlaysCsv, setParlays, syncParlayResults, useParlays } from "../parlay/store";
import { TrackedParlay } from "../parlay/ParlayCard";
import { scopedBets, setSportBets, useHubBets } from "./useHubBets";
import { BET_SEG, HubTop, betNet, combinedStats, isSettled } from "./common";
import { setLiveCredits } from "../core/live";
import { Badge, Banner, Btn, Empty, Expander, Field, GameTag, MultiPick, Pop, SearchField, Seg, Select, SportIcon, StatusBadge, Switch, TextIn, confirmDialog, cx, fDay, fDelta, fOdds, fPct, fSigned, fUnits, pickLabel, toast, todayYmd, tone } from "../ui/kit";

const BOOK_LABELS = Object.assign({}, ...HUB_SPORTS.map((s) => s.sport.config.BOOK_LABELS), { manual: "Manual" });
const matchesQuery = (b, q) => HUB_SPORT[b._sport].sport.config.matchesQuery(b, q);
const idOf = (b) => `${b._sport}:${b.key}`;
const SORTS = [["recent", "Most recent"], ["game", "Game"], ["model_desc", "Model, high to low"], ["model_asc", "Model, low to high"], ["ev_desc", "EV, high to low"], ["ev_asc", "EV, low to high"], ["edge_desc", "Edge, high to low"], ["edge_asc", "Edge, low to high"], ["clv_desc", "Line move, best first"], ["clv_asc", "Line move, worst first"], ["delta_desc", "Projection gap, high to low"], ["delta_asc", "Projection gap, low to high"]];
const PARLAY_SORTS = SORTS.filter(([k]) => ["recent", "model_desc", "model_asc", "ev_desc", "ev_asc", "edge_desc", "edge_asc"].includes(k));

// parlays under the My bets controls that apply to them: status, date, search, sort
function filterParlays(list, f) {
  const q = f.search.trim().toLowerCase();
  let arr = list.filter((p) => {
    if (f.status === "settled" ? p.status === "open" : f.status !== "all" && p.status !== f.status) return false;
    if (f.date !== "all" && parlayDate(p) !== f.date) return false;
    if (q && !p.legs.some((l) => `${l.name} ${l.game}`.toLowerCase().includes(q))) return false;
    return true;
  });
  const by = { model_desc: (p) => -p.builtModelP, model_asc: (p) => p.builtModelP, ev_desc: (p) => -p.builtEV, ev_asc: (p) => p.builtEV, edge_desc: (p) => -p.builtEdge, edge_asc: (p) => p.builtEdge }[f.sort];
  if (by) arr = [...arr].sort((a, b) => by(a) - by(b)); // otherwise newest built first (the stored order)
  return arr;
}
function summarize(list) {
  const st = list.filter(isSettled);
  const w = st.filter((b) => b.status === "won").length, l = st.filter((b) => b.status === "lost").length, p = st.filter((b) => b.status === "push").length;
  return { n: st.length, w, l, p, net: st.reduce((s, b) => s + betNet(b), 0), open: list.length - st.length };
}

const BetRow = React.memo(function BetRow({ b, showSport, checked, onCheck, onOdds, onUnits, onRemove }) {
  const cfg = HUB_SPORT[b._sport].rowCfg;
  const isLine = cfg.isLineType(b.type), yn = !!(cfg.isYesNoType && cfg.isYesNoType(b.type));
  const pick = pickLabel(b, cfg);
  const pm = !isLine && !yn && b.proj != null ? projMeta(b.proj, b.line, b.side) : null;
  const net = b.status === "won" || b.status === "lost" ? betNet(b) : null;
  const checkedAt = b.oddsCheckedAt ? `Checked ${new Date(b.oddsCheckedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : undefined;
  return (
    <tr>
      <td><input type="checkbox" className="check" aria-label={`Select ${b.name}`} checked={checked} onChange={(e) => onCheck(b, e.target.checked)} /></td>
      <td>{showSport ? <span className="mid hide-s" style={{ display: "inline-block", verticalAlign: "-3px", marginRight: 8 }} title={HUB_SPORT[b._sport].label}><SportIcon sport={b._sport} size={15} /></span> : null}{isLine ? <span className="dim">Game line</span> : <span className="name trunc" style={{ maxWidth: 138, display: "inline-block", verticalAlign: "bottom" }}>{b.name}</span>}{b.live ? <> <Badge kind="live" title="Placed while the game was in progress">Live</Badge></> : null}<div className="show-s sub"><b>{pick}</b> {b.type}</div></td>
      <td className="pick hide-s"><span className="trunc" style={{ maxWidth: 172, display: "inline-block", verticalAlign: "bottom" }}><b>{pick}</b> <span className="mid">{b.type}</span></span></td>
      <td className="hide-s" title={BOOK_LABELS[b.book] || b.book}><GameTag sport={b._sport} game={b.game} /></td>
      <td className="r num hide-s hide-m">{b.proj != null ? <>{yn ? fPct(b.proj) : Number(b.proj).toFixed(2)}{pm ? <span className={pm.strength === "miss" ? "neg" : pm.strength === "thin" ? "dim" : "pos"} title="How far the projection sits on your side of the line"> {fDelta(pm.delta)}</span> : null}</> : <span className="dim">{"–"}</span>}</td>
      <td className="r"><input className="cell num" aria-label="Odds" inputMode="numeric" value={b.odds} onChange={(e) => onOdds(b, e.target.value)} /></td>
      <td className="r hide-s"><input className="cell num" style={{ width: 52 }} aria-label="Units" inputMode="decimal" title={b.suggested > 0 ? `Quarter Kelly suggests ${b.suggested}u` : undefined} value={b.units} onChange={(e) => onUnits(b, e.target.value)} /></td>
      <td className="r num hide-s">{b.modelP != null ? fPct(b.modelP) : <span className="dim">Manual</span>}</td>
      <td className={cx("r num hide-s hide-m", tone(b.edge))}>{b.modelP != null ? fSigned(b.edge) : ""}</td>
      <td className={cx("r num hide-s", tone(b.ev))}>{b.modelP != null ? fSigned(b.ev) : ""}</td>
      <td className="r num hide-s" title={checkedAt}>{b.currentOdds != null
        ? <><span className="dim">{b.closing ? "close" : "now"}</span> {fOdds(b.currentOdds)} <span className={tone(b.clv)} title={b.live ? "Price movement since you bet" : "Closing line value"}>{b.clv != null ? fDelta(b.clv * 100, 1) : ""}</span></>
        : b.lineMissing ? <Badge kind="warn" title="Line not found: scratched, settled, or moved off your number">No line</Badge> : <span className="dim">{"–"}</span>}</td>
      <td><StatusBadge status={b.status} />{b.actual != null ? <span className="dim num" title="Actual result"> &nbsp;{b.actual}</span> : null}</td>
      <td className={cx("r num", tone(net))}>{net == null ? <span className="dim">{"–"}</span> : fUnits(net)}</td>
      <td className="r hide-s"><Btn sm icon kind="ghost" aria-label={`Remove ${b.name}`} title="Remove this bet" onClick={() => onRemove(b)}><X /></Btn></td>
    </tr>
  );
});

export default function MyBets({ active = true }) {
  const all = useHubBets();
  const parlays = useParlays();
  const [sportFilter, setSportFilterRaw] = useState("all");
  const [f, setF] = useState(EMPTY_BET_FILTERS);
  const [settleMsg, setSettleMsg] = useState("");
  const [lineMsg, setLineMsg] = useState("");
  const [settling, setSettling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sel, setSel] = useState(() => new Set());
  const [closed, setClosed] = useState({});       // date -> collapsed?
  const [shown, setShown] = useState(300);
  const set = (patch) => { setShown(300); setF((p) => ({ ...p, ...patch })); };
  // a game / category / book picked for one sport doesn't exist in another
  const setSportFilter = (v) => { setSportFilterRaw(v); setSel(new Set()); set({ games: [], types: [], books: [] }); };
  const setDate = (v) => set({ date: v, games: [] }); // games are scoped to the date (as on the sport pages)

  const onlyParlays = sportFilter === "parlays";
  const withParlays = sportFilter === "all" || onlyParlays;
  const scope = sportFilter === "all" ? HUB_SPORTS : onlyParlays ? [] : [HUB_SPORT[sportFilter]];
  const bets = useMemo(() => (onlyParlays ? [] : scopedBets(all, sportFilter)), [all, sportFilter]);
  const parlayView = useMemo(() => (withParlays ? filterParlays(parlays, f) : []), [parlays, f, withParlays]);
  const parlayDates = useMemo(() => [...new Set(parlays.map(parlayDate).filter(Boolean))].sort().reverse(), [parlays]);
  const nothing = bets.length === 0 && (!withParlays || parlays.length === 0);
  // finished legs pick up their results whenever this page is opened
  useEffect(() => { if (active) void syncParlayResults(HUB_SPORTS); }, [active]);
  const view = useMemo(() => filterSortBets(bets, f, matchesQuery), [bets, f]);
  const facets = useMemo(() => betFacets(bets, f.date), [bets, f.date]);
  const moreCount = ["minModel", "minEdge", "maxEdge", "minOdds", "maxOdds", "minDelta", "maxDelta"].filter((k) => f[k] !== "").length + (f.dirAligned ? 1 : 0);
  const selected = view.filter((b) => sel.has(idOf(b)));
  const sum = summarize(view);

  const edit = (b, fn) => setSportBets(b._sport, (p) => p.map((x) => (x.key === b.key ? fn(x) : x)));
  const updateOdds = (b, odds) => edit(b, (x) => ({ ...x, odds: odds === "" || odds === "-" || odds === "+" ? odds : (isNaN(Number(odds)) ? x.odds : Number(odds)) }));
  const updateUnits = (b, units) => edit(b, (x) => ({ ...x, units: units === "" ? "" : (isNaN(Number(units)) ? x.units : (/\.$|\.0*$/.test(units) ? units : Math.max(0, Number(units)))) }));
  const onCheck = (b, on) => setSel((s) => { const n = new Set(s); if (on) n.add(idOf(b)); else n.delete(idOf(b)); return n; });
  // removing keeps a copy of each sport's list, so Undo puts everything back exactly as it was
  function removeBets(list) {
    const bySport = {}; for (const b of list) (bySport[b._sport] = bySport[b._sport] || new Set()).add(b.key);
    const before = Object.fromEntries(Object.keys(bySport).map((id) => [id, all[id]]));
    for (const id of Object.keys(bySport)) setSportBets(id, (p) => p.filter((x) => !bySport[id].has(x.key)));
    setSel(new Set());
    toast(list.length === 1 ? "Bet removed." : `${list.length} bets removed.`, () => { for (const id of Object.keys(before)) setSportBets(id, before[id]); });
  }
  const removeOne = (b) => removeBets([b]);

  // Settle: every sport in view (all four, or the selected one) in one click
  async function settleAll() {
    const withOpen = scope.filter((s) => all[s.id].some((b) => b.status === "open"));
    const openParlays = withParlays && parlays.some((p) => p.status === "open");
    if (!withOpen.length && !openParlays) { setSettleMsg("No open bets to settle."); return; }
    setSettling(true); setSettleMsg("Settling.");
    const parts = [];
    let total = 0;
    for (const s of withOpen) {
      try {
        const { results } = await fetchOpenBetResults(s.sport, all[s.id]);
        let graded = 0;
        setSportBets(s.id, (prev) => { const r = gradeOpenBets(s.sport, prev, results); graded = r.graded; return r.next; });
        total += graded; parts.push(`${s.label} ${graded}`);
      } catch (e) { parts.push(`${s.label} failed (${String((e && e.message) || e)})`); }
    }
    // parlay legs settle from each sport's graded results (tracked bets just settled above + board logs)
    let legs = 0;
    if (openParlays) legs = await syncParlayResults(HUB_SPORTS);
    const stillOpen = openParlays && getParlays().some((p) => p.status === "open");
    const singles = withOpen.length ? `Settled ${total} bet${total === 1 ? "" : "s"}${withOpen.length > 1 || sportFilter === "all" ? ` (${parts.join(", ")})` : ""}. Unsettled games are still in progress.` : "";
    const parl = openParlays ? ` ${legs} parlay leg${legs === 1 ? "" : "s"} graded.${stillOpen ? " Open legs settle once their game is graded: settle that sport's board log on its Model tab, or settle the matching tracked bet." : ""}` : "";
    setSettleMsg((singles + parl).trim());
    setSettling(false);
  }

  // Refresh lines: each open bet is matched to its OWN game (looked up by the bet's date), so bets
  // from any date get a current price, not just the date a sport page has loaded
  const refreshJobs = () => scope.map((s) => ({ s, open: all[s.id].filter((b) => b.status === "open" && b.book && b.book !== "manual") })).filter((j) => j.open.length);
  async function refreshLines() {
    const jobs = refreshJobs();
    if (!jobs.length) { setLineMsg("No open tracked bets with a book to refresh. Manual bets have no book to pull."); return; }
    setRefreshing(true); setLineMsg("Refreshing lines.");
    let matched = 0, missed = 0, games = 0, frozen = 0, credits = null;
    const errors = [];
    for (const { s, open } of jobs) {
      try {
        const api = s.sport.api;
        const byPk = {};
        for (const date of new Set(open.map((b) => b.date).filter(Boolean))) {
          const list = await api.fetchSchedule(date).catch(() => []);
          for (const g of list || []) byPk[String(g.pk)] = g;
        }
        const getEvents = async () => { const ev = await api.fetchOddsEvents(); if (ev.remaining != null) credits = ev.remaining; return ev.events || []; };
        const r = await refreshBetLines(s.sport, open, { getEvents, findGame: (pk) => byPk[String(pk)] || null, onCredits: (n) => { credits = n; } });
        setSportBets(s.id, (prev) => prev.map((b) => (r.updates[b.key] ? { ...b, ...r.updates[b.key] } : b)));
        matched += r.matched; missed += r.missed; games += r.games; frozen += r.frozen;
      } catch (e) { errors.push(`${s.label}: ${String((e && e.message) || e)}`); }
    }
    if (credits != null) setLiveCredits(credits);
    setLineMsg(`Updated ${matched} line${matched === 1 ? "" : "s"} across ${games} game${games === 1 ? "" : "s"}${frozen ? `, ${frozen} frozen at the close (game started)` : ""}${missed ? `, ${missed} not found (scratched, settled, or the line moved off your number)` : ""}.${credits != null ? ` ${credits.toLocaleString()} odds credits left.` : ""}${errors.length ? ` Line refresh failed for ${errors.join("; ")}` : ""}`);
    setRefreshing(false);
  }
  function askRefreshLines() {
    const jobs = refreshJobs();
    if (!jobs.length) { void refreshLines(); return; }
    const games = jobs.reduce((n, j) => n + new Set(j.open.map((b) => b.gamePk)).size, 0);
    confirmDialog({ title: "Refresh lines for open bets?", body: `Pulls the current price for open bets in up to ${games} game${games === 1 ? "" : "s"}, around 9 odds credits each. Games that have started are skipped once their closing line is saved.`, confirm: "Refresh lines", onConfirm: refreshLines });
  }

  function exportCSV() {
    const stamp = new Date().toISOString().slice(0, 10);
    if (onlyParlays) { downloadText(parlaysCsv(parlays), `edge-finder-parlays-${stamp}.csv`, "text/csv;charset=utf-8;"); return; }
    if (sportFilter !== "all") {
      const s = HUB_SPORT[sportFilter], order = s.sport.config.STAT_ORDER;
      downloadText(betsCsv(all[s.id], betStats(all[s.id], {}, order), order), `${s.sport.meta.csvPrefix}-${stamp}.csv`, "text/csv;charset=utf-8;");
      return;
    }
    const st = combinedStats(all, {});
    const csv = betsCsv(bets, st, st.typeOrder, (b) => HUB_SPORT[b._sport].label) + (parlays.length ? `\n\nPARLAYS\n${parlaysCsv(parlays)}` : "");
    downloadText(csv, `edge-finder-${stamp}.csv`, "text/csv;charset=utf-8;");
  }
  function backup() {
    const stamp = new Date().toISOString().slice(0, 10);
    if (onlyParlays) { downloadText(JSON.stringify({ app: "edge-finder", v: 2, exported: new Date().toISOString(), parlays }, null, 2), `edge-finder-parlays-${stamp}.json`, "application/json"); return; }
    if (sportFilter !== "all") {
      const s = HUB_SPORT[sportFilter];
      downloadText(betsBackupJson(all[s.id], s.sport.meta.backupApp), `${s.sport.meta.csvPrefix}-bets-${stamp}.json`, "application/json");
      return;
    }
    const data = { app: "edge-finder", v: 2, exported: new Date().toISOString(), sports: Object.fromEntries(HUB_SPORTS.map((s) => [s.id, all[s.id]])), parlays };
    downloadText(JSON.stringify(data, null, 2), `edge-finder-bets-${stamp}.json`, "application/json");
  }
  // accepts an all-sports backup, or a one-sport backup (from a sport page or this page)
  function restore(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const plan = {}; // sport id -> incoming bets
        let parlayNote = "";
        if (parsed && Array.isArray(parsed.parlays)) {
          const have = new Set(getParlays().map((p) => p.id));
          const add = parsed.parlays.filter((p) => p && p.id && Array.isArray(p.legs) && !have.has(p.id));
          if (add.length) setParlays((cur) => [...cur, ...add]);
          parlayNote = `Parlays: ${add.length} of ${parsed.parlays.length}`;
        }
        if (parsed && Array.isArray(parsed.parlays) && !parsed.sports) { setSettleMsg(`Restored from the backup (${parlayNote}; duplicates skipped).`); return; }
        if (parsed && parsed.sports && typeof parsed.sports === "object") {
          for (const s of HUB_SPORTS) if (Array.isArray(parsed.sports[s.id])) plan[s.id] = parsed.sports[s.id];
        } else {
          const incoming = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.bets) ? parsed.bets : null);
          if (!incoming) { setSettleMsg("Restore failed: that file is not a bet backup."); return; }
          const byApp = parsed && parsed.app ? HUB_SPORTS.find((s) => s.sport.meta.backupApp === parsed.app) : null;
          const target = byApp ? byApp.id : sportFilter !== "all" && !onlyParlays ? sportFilter : null;
          if (!target) { setSettleMsg("This backup does not say which sport it is from. Pick the sport above, then restore again."); return; }
          plan[target] = incoming;
        }
        const parts = [];
        for (const [id, incoming] of Object.entries(plan)) {
          const toAdd = newFromBackup(all[id], incoming);
          setSportBets(id, (cur) => mergeRestored(cur, toAdd));
          parts.push(`${HUB_SPORT[id].label}: ${toAdd.length} of ${incoming.length}`);
        }
        if (parlayNote) parts.push(parlayNote);
        setSettleMsg(`Restored from the backup (${parts.join(", ")}; duplicates skipped).`);
      } catch { setSettleMsg("Restore failed: the file could not be read as JSON."); }
    };
    reader.readAsText(file);
  }

  // most-recent order groups by slate date (collapsible); any other sort is one flat list
  const byDate = f.sort === "recent";
  const groups = useMemo(() => {
    if (!byDate) return [[null, view]];
    const m = new Map(); for (const b of view) { const d = b.date || ""; if (!m.has(d)) m.set(d, []); m.get(d).push(b); }
    return [...m.entries()];
  }, [view, byDate]);
  const isOpen = (d, i) => (closed[d] != null ? !closed[d] : i < 2);
  const showSport = sportFilter === "all";
  const cols = 14;
  const today = todayYmd();
  let budget = shown;

  return (
    <>
      <HubTop title="My bets">
        <Btn disabled={nothing} onClick={exportCSV} title="Download every tracked bet as a CSV"><Download /><span className="hide-s">Download CSV</span></Btn>
        <Btn disabled={nothing} onClick={backup} title="Save a .json backup you can restore later or on another device"><HardDriveDownload /><span className="hide-s">Back up</span></Btn>
        <label className="btn filebtn" title="Restore bets from a .json backup" tabIndex={0}><HardDriveUpload /><span className="hide-s">Restore</span>
          <input type="file" accept="application/json,.json" onChange={(e) => { restore(e.target.files && e.target.files[0]); e.target.value = ""; }} />
        </label>
        <Btn disabled={refreshing || onlyParlays} onClick={askRefreshLines} title="Pull the current price for each open tracked bet, to see line movement and closing line value">{refreshing ? "Refreshing" : "Refresh lines"}</Btn>
        <Btn kind="primary" disabled={settling} onClick={settleAll}><RefreshCw /><span className="hide-s">{settling ? "Settling" : "Settle finished"}</span></Btn>
      </HubTop>
      <div className="screen">
        <div className="bar">
          <Seg label="Sport" value={sportFilter} onChange={setSportFilter} options={BET_SEG} />
          <SearchField value={f.search} onChange={(search) => set({ search })} placeholder="Search player or team" width={200} />
          <Select label="Status" value={f.status} onChange={(status) => set({ status })} options={[["all", "All statuses"], ["open", "Open"], ["settled", "Settled"], ["won", "Won"], ["lost", "Lost"], ["push", "Push"], ["void", "Void"]]} />
          <Select label="Date" value={f.date} onChange={setDate} options={[["all", "All dates"], ...(onlyParlays ? parlayDates : facets.dates).map((d) => [d, fDay(d)])]} />
          {!onlyParlays ? (<>
            <MultiPick label="Games" selected={f.games} options={facets.games} labels={Object.fromEntries(facets.games.map((g) => [g, String(g).replace("@", " at ")]))} onChange={(games) => set({ games })} />
            <MultiPick label="Markets" selected={f.types} options={facets.types} onChange={(types) => set({ types })} />
            <MultiPick label="Books" selected={f.books} options={facets.books} labels={BOOK_LABELS} onChange={(books) => set({ books })} />
            <Pop width={320} button={(o, t) => <Btn on={o || moreCount > 0 || f.side !== "all"} onClick={t}><ListFilter />Filters{moreCount + (f.side !== "all" ? 1 : 0) ? ` (${moreCount + (f.side !== "all" ? 1 : 0)})` : ""}</Btn>}>
              <label className="frow" style={{ gridTemplateColumns: "1fr 150px" }}><span>Side</span><Select sm label="Side" value={f.side} onChange={(side) => set({ side })} options={[["all", "All sides"], ...facets.sides.map((s) => [s, s[0].toUpperCase() + s.slice(1)])]} /></label>
              <Field label="Minimum model %"><TextIn value={f.minModel} onChange={(minModel) => set({ minModel })} /></Field>
              <Field label="Minimum edge %"><TextIn value={f.minEdge} onChange={(minEdge) => set({ minEdge })} /></Field>
              <Field label="Maximum edge %"><TextIn value={f.maxEdge} onChange={(maxEdge) => set({ maxEdge })} /></Field>
              <Field label="Projection gap, at least"><TextIn value={f.minDelta} onChange={(minDelta) => set({ minDelta })} placeholder="0.5" /></Field>
              <Field label="Projection gap, at most"><TextIn value={f.maxDelta} onChange={(maxDelta) => set({ maxDelta })} placeholder="2.0" /></Field>
              <Field label="Odds no shorter than"><TextIn value={f.minOdds} onChange={(minOdds) => set({ minOdds })} placeholder="-300" /></Field>
              <Field label="Odds no longer than"><TextIn value={f.maxOdds} onChange={(maxOdds) => set({ maxOdds })} placeholder="+300" /></Field>
              <Switch on={f.dirAligned} onChange={(dirAligned) => set({ dirAligned })} title="Only bets where the projection sat on the bet's side of the line">Projection agreed with the side</Switch>
            </Pop>
          </>) : null}
          <Select label="Sort" value={(onlyParlays ? PARLAY_SORTS : SORTS).some(([k]) => k === f.sort) ? f.sort : "recent"} onChange={(sort) => set({ sort })} options={onlyParlays ? PARLAY_SORTS : SORTS} />
          {betFiltersActive(f) ? <Btn sm kind="ghost" onClick={() => { setShown(300); setF((p) => ({ ...EMPTY_BET_FILTERS, sort: p.sort })); }}>Clear</Btn> : null}
        </div>
        {!onlyParlays && bets.length > 0 ? (
          <div className="bar tight">
            {selected.length ? (<>
              <b>{selected.length} selected</b>
              <Btn sm kind="danger" onClick={() => removeBets(selected)}><Trash2 />Remove</Btn>
              <Btn sm kind="ghost" onClick={() => setSel(new Set())}>Clear selection</Btn>
            </>) : (
              <span className="mid num">Showing {view.length.toLocaleString()} of {bets.length.toLocaleString()} bets.{sum.n ? <> Settled in view {sum.w}-{sum.l}{sum.p ? `-${sum.p}` : ""}{sum.w + sum.l ? ` (${((sum.w / (sum.w + sum.l)) * 100).toFixed(1)}%)` : ""}, net <b className={tone(sum.net)}>{fUnits(sum.net)}</b>.</> : null}{sum.open ? ` ${sum.open} open.` : ""}</span>
            )}
          </div>
        ) : null}
        {settleMsg ? <Banner kind="info" onClose={() => setSettleMsg("")}>{settleMsg}</Banner> : null}
        {lineMsg ? <Banner kind="info" onClose={() => setLineMsg("")}>{lineMsg}</Banner> : null}
        <div className="scroll">
          {onlyParlays ? null : bets.length === 0 ? (
            <Empty title="No bets tracked yet">Track plays from a sport's Board, or add one by hand from a player on its Slate.</Empty>
          ) : view.length === 0 ? (
            <Empty title="No bets match these filters" action={<Btn onClick={() => setF((p) => ({ ...EMPTY_BET_FILTERS, sort: p.sort }))}>Clear filters</Btn>} />
          ) : (
            <table className="tbl dense">
              <thead><tr>
                <th style={{ width: 36 }}><input type="checkbox" className="check" aria-label="Select every bet in view" checked={selected.length > 0 && selected.length === view.length} onChange={(e) => setSel(e.target.checked ? new Set(view.map(idOf)) : new Set())} /></th>
                <th>Player</th><th className="hide-s">Pick</th><th className="hide-s">Game</th><th className="r hide-s hide-m" title="Model projection, and how far it sat on your side of the line">Projection</th><th className="r">Odds</th><th className="r hide-s">Units</th>
                <th className="r hide-s">Model</th><th className="r hide-s hide-m">Edge</th><th className="r hide-s">EV</th><th className="r hide-s" title="The current or closing price, and how far the market moved toward your side (in points of probability)">Line move</th><th>Result</th><th className="r">Net</th><th className="hide-s" style={{ width: 40 }} />
              </tr></thead>
              <tbody>{groups.map(([d, list], i) => {
                if (budget <= 0) return null;
                const o = d == null || isOpen(d, i), ds = d == null ? null : summarize(list);
                const slice = o ? list.slice(0, budget) : []; budget -= slice.length;
                return (
                  <React.Fragment key={d == null ? "all" : d}>
                    {d != null ? <tr className={cx("group", o && "open")}><td><Expander open={o} label={o ? "Hide this date" : "Show this date"} onClick={() => setClosed((c) => ({ ...c, [d]: o }))} /></td><td colSpan={cols - 1}>{d === today ? "Today" : d ? fDay(d) : "No date"}<span className="dim num" style={{ fontWeight: 480 }}> &nbsp;{list.length} bet{list.length === 1 ? "" : "s"}{ds.n ? `, ${ds.w}-${ds.l}${ds.p ? `-${ds.p}` : ""}` : ""}{ds.open ? `, ${ds.open} open` : ""}</span>{ds.n ? <span className={cx("num", tone(ds.net))} style={{ fontWeight: 600 }}> &nbsp;{fUnits(ds.net)}</span> : null}</td></tr> : null}
                    {slice.map((b) => <BetRow key={idOf(b)} b={b} showSport={showSport} checked={sel.has(idOf(b))} onCheck={onCheck} onOdds={updateOdds} onUnits={updateUnits} onRemove={removeOne} />)}
                  </React.Fragment>
                );
              })}</tbody>
            </table>
          )}
          {!onlyParlays && budget <= 0 && view.length > shown ? <div className="more"><Btn onClick={() => setShown((n) => n + 300)}>Show 300 more</Btn></div> : null}
          {withParlays ? (
            <div className="page" style={{ display: "grid", gap: 12 }}>
              <div className="row"><div className="h2 grow">Parlays</div><span className="note num">Showing {parlayView.length} of {parlays.length}</span></div>
              {parlays.length === 0 ? <Empty title="No tracked parlays">Build one in the Parlay builder and it shows up here with its own record.</Empty>
                : parlayView.length === 0 ? <Empty title="No parlays match these filters" />
                  : <div className="grid g2" style={{ alignItems: "start" }}>{parlayView.map((p) => <TrackedParlay key={p.id} p={p} />)}</div>}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
