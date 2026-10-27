/* Hub · My Bets: every sport's tracked bets in one place, filterable by sport. With one sport selected
   it is that sport's old My Bets tab (same list, filters, sorts, edits, CSV, backup, settle, line
   refresh). "All" merges the sports, with a sport tag on each row, followed by tracked parlays.
   "Parlays" shows only parlays (status / date / search / sort; the single-bet filters don't apply).
   Each sport's bets stay stored separately; parlays have their own store (src/parlay/store.ts). */
import { useEffect, useMemo, useState } from "react";
import { MultiSel, Sel } from "../core/ui";
import { MyBetRow } from "../core/cards";
import { profitUnits } from "../core/math";
import { EMPTY_BET_FILTERS, betFacets, betFiltersActive, betsBackupJson, betsCsv, betStats, downloadText, fetchOpenBetResults, filterSortBets, gradeOpenBets, mergeRestored, newFromBackup, refreshBetLines } from "../core/bets";
import { BET_FILTER_LABELS, BET_FILTER_OPTS, HUB_SPORT, HUB_SPORTS } from "./sports";
import { getParlays, parlayDate, parlaysCsv, setParlays, syncParlayResults, useParlays } from "../parlay/store";
import { TrackedParlay } from "../parlay/ParlayCard";
import { scopedBets, setSportBets, useHubBets } from "./useHubBets";
import { HubHeader, combinedStats } from "./common";

const BOOK_LABELS = Object.assign({}, ...HUB_SPORTS.map((s) => s.sport.config.BOOK_LABELS));
const matchesQuery = (b, q) => HUB_SPORT[b._sport].sport.config.matchesQuery(b, q);

// parlays under the My Bets controls that apply to them: show (status), date, search, sort
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

export default function MyBets({ active = true }) {
  const all = useHubBets();
  const parlays = useParlays();
  const [sportFilter, setSportFilterRaw] = useState("all");
  const [f, setF] = useState(EMPTY_BET_FILTERS);
  const [showMore, setShowMore] = useState(false);
  const [settleMsg, setSettleMsg] = useState("");
  const [lineMsg, setLineMsg] = useState("");
  const [settling, setSettling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const set = (patch) => setF((p) => ({ ...p, ...patch }));
  // a game / category / book picked for one sport doesn't exist in another
  const setSportFilter = (v) => { setSportFilterRaw(v); set({ games: [], types: [], books: [] }); };
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

  const edit = (b, fn) => setSportBets(b._sport, (p) => p.map((x) => (x.key === b.key ? fn(x) : x)));
  const updateOdds = (b, odds) => edit(b, (x) => ({ ...x, odds: odds === "" ? "" : Number(odds) }));
  const updateUnits = (b, units) => edit(b, (x) => ({ ...x, units: units === "" ? "" : Math.max(0, Number(units)) }));
  const removeBet = (b) => setSportBets(b._sport, (p) => p.filter((x) => x.key !== b.key));

  // Settle: every sport in view (all four, or the selected one) in one click
  async function settleAll() {
    const withOpen = scope.filter((s) => all[s.id].some((b) => b.status === "open"));
    const openParlays = withParlays && parlays.some((p) => p.status === "open");
    if (!withOpen.length && !openParlays) { setSettleMsg("No open bets to settle."); return; }
    setSettling(true); setSettleMsg("Settling…");
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
    const singles = withOpen.length ? `Settled ${total} bet(s)${withOpen.length > 1 || sportFilter === "all" ? ` (${parts.join(" · ")})` : ""}. Unsettled games are still in progress.` : "";
    const parl = openParlays ? ` ${legs} parlay leg(s) graded.${stillOpen ? " Open legs settle once their game is graded: run that sport's Board Log settle, or settle the matching tracked bet." : ""}` : "";
    setSettleMsg((singles + parl).trim());
    setSettling(false);
  }

  // Refresh lines: each open bet is matched to its OWN game (looked up by the bet's date), so bets
  // from any date get a current price, not just the date a sport page has loaded
  async function refreshLines() {
    const jobs = scope.map((s) => ({ s, open: all[s.id].filter((b) => b.status === "open" && b.book && b.book !== "manual") })).filter((j) => j.open.length);
    if (!jobs.length) { setLineMsg("No open tracked bets with a book to refresh (manual bets have no book to pull)."); return; }
    setRefreshing(true); setLineMsg("Refreshing lines…");
    let matched = 0, missed = 0, games = 0, frozen = 0, credits = null;
    const errors = [];
    for (const { s, open } of jobs) {
      try {
        const api = s.sport.api;
        const byPk = {};
        for (const date of [...new Set(open.map((b) => b.date).filter(Boolean))]) {
          const list = await api.fetchSchedule(date).catch(() => []);
          for (const g of list || []) byPk[String(g.pk)] = g;
        }
        const getEvents = async () => { const ev = await api.fetchOddsEvents(); if (ev.remaining != null) credits = ev.remaining; return ev.events || []; };
        const r = await refreshBetLines(s.sport, open, { getEvents, findGame: (pk) => byPk[String(pk)] || null, onCredits: (n) => { credits = n; } });
        setSportBets(s.id, (prev) => prev.map((b) => (r.updates[b.key] ? { ...b, ...r.updates[b.key] } : b)));
        matched += r.matched; missed += r.missed; games += r.games; frozen += r.frozen;
      } catch (e) { errors.push(`${s.label}: ${String((e && e.message) || e)}`); }
    }
    setLineMsg(`Updated ${matched} line(s) across ${games} game(s)${frozen ? ` · ${frozen} frozen at close (game started)` : ""}${missed ? ` · ${missed} not found (scratched, settled, or line moved off your number)` : ""}.${credits != null ? ` ${credits} odds credits left.` : ""}${errors.length ? ` Line refresh failed for ${errors.join("; ")}` : ""}`);
    setRefreshing(false);
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
        const parsed = JSON.parse(reader.result);
        const plan = {}; // sport id -> incoming bets
        let parlayNote = "";
        if (parsed && Array.isArray(parsed.parlays)) {
          const have = new Set(getParlays().map((p) => p.id));
          const add = parsed.parlays.filter((p) => p && p.id && Array.isArray(p.legs) && !have.has(p.id));
          if (add.length) setParlays((cur) => [...cur, ...add]);
          parlayNote = `Parlays: ${add.length} of ${parsed.parlays.length}`;
        }
        if (parsed && Array.isArray(parsed.parlays) && !parsed.sports) { setSettleMsg(`Restored from backup (${parlayNote}; duplicates skipped).`); return; }
        if (parsed && parsed.sports && typeof parsed.sports === "object") {
          for (const s of HUB_SPORTS) if (Array.isArray(parsed.sports[s.id])) plan[s.id] = parsed.sports[s.id];
        } else {
          const incoming = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.bets) ? parsed.bets : null);
          if (!incoming) { setSettleMsg("Restore failed: not a valid bet backup file."); return; }
          const byApp = parsed && parsed.app ? HUB_SPORTS.find((s) => s.sport.meta.backupApp === parsed.app) : null;
          const target = byApp ? byApp.id : sportFilter !== "all" && !onlyParlays ? sportFilter : null;
          if (!target) { setSettleMsg("Restore: this backup doesn't say which sport it's from. Pick the sport above, then restore again."); return; }
          plan[target] = incoming;
        }
        const parts = [];
        for (const [id, incoming] of Object.entries(plan)) {
          const toAdd = newFromBackup(all[id], incoming);
          setSportBets(id, (cur) => mergeRestored(cur, toAdd));
          parts.push(`${HUB_SPORT[id].label}: ${toAdd.length} of ${incoming.length}`);
        }
        if (parlayNote) parts.push(parlayNote);
        setSettleMsg(`Restored from backup (${parts.join(" · ")}; duplicates skipped).`);
      } catch { setSettleMsg("Restore failed: could not parse the JSON file."); }
    };
    reader.readAsText(file);
  }

  const inView = (() => {
    const st = view.filter((b) => b.status === "won" || b.status === "lost" || b.status === "push" || b.status === "void");
    if (!st.length) return null;
    const w = st.filter((b) => b.status === "won").length, l = st.filter((b) => b.status === "lost").length, p = st.filter((b) => b.status === "push").length;
    const net = st.reduce((s, b) => s + (profitUnits(b.status, Number(b.odds), b.units != null ? b.units : 1) || 0), 0);
    const wr = (w + l) ? (w / (w + l) * 100).toFixed(1) : "0.0";
    return <span>· settled in view: <b className="text-slate-200">{w}-{l}{p ? `-${p}` : ""}</b> ({wr}%) · net <b className={net >= 0 ? "text-emerald-400" : "text-rose-400"}>{net >= 0 ? "+" : ""}{net.toFixed(2)}u</b></span>;
  })();
  const inp = "bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <div className="max-w-5xl mx-auto px-4 pb-28">
        <HubHeader title="MY" accent="BETS" sub="every sport's tracked bets · settle · line moves · backup" />
        <div className="mt-3">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <Sel compact label="sport" v={sportFilter} opts={BET_FILTER_OPTS} labels={BET_FILTER_LABELS} onChange={setSportFilter} />
              <input value={f.search} onChange={(e) => set({ search: e.target.value })} placeholder="search player or team" className="bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-sm w-44 text-slate-100" />
              <Sel compact label="show" v={f.status} opts={["all", "open", "settled", "won", "lost", "push", "void"]} labels={{ all: "All", open: "Open", settled: "Settled", won: "Won", lost: "Lost", push: "Push", void: "Void" }} onChange={(v) => set({ status: v })} />
              <Sel compact label="date" v={f.date} opts={["all", ...(onlyParlays ? parlayDates : facets.dates)]} labels={{ all: "All dates" }} onChange={setDate} />
              {!onlyParlays && <>
              <MultiSel compact label="game" selected={f.games} opts={facets.games} onChange={(v) => set({ games: v })} />
              <MultiSel compact label="category" selected={f.types} opts={facets.types} onChange={(v) => set({ types: v })} />
              <MultiSel compact label="book" selected={f.books} opts={facets.books} labels={BOOK_LABELS} onChange={(v) => set({ books: v })} />
              <Sel compact label="side" v={f.side} opts={["all", ...facets.sides]} labels={{ all: "All sides" }} onChange={(v) => set({ side: v })} />
              </>}
              {onlyParlays
                ? <Sel compact label="sort" v={["recent", "model_desc", "model_asc", "ev_desc", "ev_asc", "edge_desc", "edge_asc"].includes(f.sort) ? f.sort : "recent"} opts={["recent", "model_desc", "model_asc", "ev_desc", "ev_asc", "edge_desc", "edge_asc"]} labels={{ recent: "Most recent", model_desc: "Model % ↓", model_asc: "Model % ↑", ev_desc: "EV ↓", ev_asc: "EV ↑", edge_desc: "Edge ↓", edge_asc: "Edge ↑" }} onChange={(v) => set({ sort: v })} />
                : <Sel compact label="sort" v={f.sort} opts={["recent", "game", "model_desc", "model_asc", "ev_desc", "ev_asc", "edge_desc", "edge_asc", "clv_desc", "clv_asc", "delta_desc", "delta_asc"]} labels={{ recent: "Most recent", game: "Game", model_desc: "Model % ↓", model_asc: "Model % ↑", ev_desc: "EV ↓", ev_asc: "EV ↑", edge_desc: "Edge ↓", edge_asc: "Edge ↑", clv_desc: "Line move ↓", clv_asc: "Line move ↑", delta_desc: "Proj Δ ↓", delta_asc: "Proj Δ ↑" }} onChange={(v) => set({ sort: v })} />}
              {!onlyParlays && <button onClick={() => setShowMore((s) => !s)} className={`text-xs rounded px-2.5 py-1.5 border ${showMore || moreCount ? "border-emerald-700 text-emerald-300" : "border-slate-700 text-slate-400 hover:text-slate-200"}`}>more{moreCount ? ` (${moreCount})` : ""} {showMore ? "▴" : "▾"}</button>}
              {betFiltersActive(f) && <button onClick={() => setF((p) => ({ ...EMPTY_BET_FILTERS, sort: p.sort }))} className="text-[11px] text-slate-400 hover:text-rose-300 border border-slate-700 rounded px-2.5 py-1.5">clear</button>}
            </div>
            <div className="flex items-center gap-2 self-end">
              <button onClick={exportCSV} disabled={nothing} className="bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white font-bold text-sm rounded-lg px-3 py-1.5">Download CSV</button>
              <button onClick={backup} disabled={nothing} className="bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white font-bold text-sm rounded-lg px-3 py-1.5" title="Save a .json backup you can restore later or on another device">Backup</button>
              <label className="bg-slate-700 hover:bg-slate-600 text-white font-bold text-sm rounded-lg px-3 py-1.5 cursor-pointer" title="Restore bets from a .json backup">Restore
                <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => { restore(e.target.files && e.target.files[0]); e.target.value = ""; }} />
              </label>
              <button onClick={refreshLines} disabled={refreshing || onlyParlays} className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-bold text-sm rounded-lg px-3 py-1.5" title="Pull the current price for each open tracked bet (line movement / CLV). ~9 credits per game.">{refreshing ? "…" : "Refresh lines"}</button>
              <button onClick={settleAll} disabled={settling} className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-bold text-sm rounded-lg px-3 py-1.5">{settling ? "Settling…" : "Settle finished"}</button>
            </div>
          </div>
          {showMore && !onlyParlays && (
            <div className="flex items-end gap-3 flex-wrap mb-3 p-2.5 rounded-lg bg-slate-900/40 border border-slate-800">
              <label className="text-xs text-slate-400 flex flex-col gap-1">min model %<input value={f.minModel} onChange={(e) => set({ minModel: e.target.value })} placeholder="any" inputMode="decimal" className={inp} /></label>
              <label className="text-xs text-slate-400 flex flex-col gap-1">min edge %<input value={f.minEdge} onChange={(e) => set({ minEdge: e.target.value })} placeholder="any" inputMode="decimal" className={inp} /></label>
              <label className="text-xs text-slate-400 flex flex-col gap-1">max edge %<input value={f.maxEdge} onChange={(e) => set({ maxEdge: e.target.value })} placeholder="any" inputMode="decimal" className={inp} /></label>
              <label className="text-xs text-slate-400 flex flex-col gap-1">min proj Δ<input value={f.minDelta} onChange={(e) => set({ minDelta: e.target.value })} placeholder="e.g. 0.5" inputMode="decimal" className={inp} /></label>
              <label className="text-xs text-slate-400 flex flex-col gap-1">max proj Δ<input value={f.maxDelta} onChange={(e) => set({ maxDelta: e.target.value })} placeholder="e.g. 2.0" inputMode="decimal" className={inp} /></label>
              <label className="text-xs text-slate-400 flex flex-col gap-1">min odds<input value={f.minOdds} onChange={(e) => set({ minOdds: e.target.value })} placeholder="-300" inputMode="numeric" className={inp} /></label>
              <label className="text-xs text-slate-400 flex flex-col gap-1">max odds<input value={f.maxOdds} onChange={(e) => set({ maxOdds: e.target.value })} placeholder="+300" inputMode="numeric" className={inp} /></label>
              <label className="text-xs text-slate-400 flex flex-col gap-1">proj aligned
                <button onClick={() => set({ dirAligned: !f.dirAligned })} className={`text-xs rounded px-3 py-1.5 border font-medium ${f.dirAligned ? "border-sky-600 bg-sky-950 text-sky-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`} title="Only show bets where proj direction matched the bet side">{f.dirAligned ? "on" : "off"}</button>
              </label>
            </div>
          )}
          {settleMsg && <div className="text-[11px] text-slate-400 mb-2">{settleMsg}</div>}
          {lineMsg && <div className="text-[11px] text-indigo-300 mb-2">{lineMsg}</div>}
          {bets.length > 0 && (
            <div className="text-[11px] text-slate-400 mb-2 flex items-center gap-x-3 gap-y-1 flex-wrap">
              <span>showing <b className="text-slate-200">{view.length}</b> of {bets.length} bets</span>
              {inView}
            </div>
          )}
          {onlyParlays ? null : bets.length === 0 ? (
            <div className="text-sm text-slate-500 py-10 text-center">No bets tracked. Add from a sport's Board (<span className="text-emerald-400">track</span>) or draft one from a player on its Slate.</div>
          ) : view.length === 0 ? (
            <div className="text-sm text-slate-500 py-10 text-center">No bets match this filter.</div>
          ) : (
            <div className="space-y-2">
              {view.map((b) => {
                const hs = HUB_SPORT[b._sport];
                const row = <MyBetRow {...hs.rowCfg} b={b} onOdds={(v) => updateOdds(b, v)} onUnits={(v) => updateUnits(b, v)} onRemove={() => removeBet(b)} />;
                return sportFilter === "all"
                  ? <div key={`${b._sport}:${b.key}`} className="flex items-center gap-2"><span className="w-6 text-center shrink-0" title={hs.label}>{hs.icon}</span><div className="flex-1 min-w-0">{row}</div></div>
                  : <div key={`${b._sport}:${b.key}`}>{row}</div>;
              })}
            </div>
          )}
          {withParlays && (
            <div className={onlyParlays ? "" : "mt-6"}>
              <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1.5">🧩 PARLAYS · showing {parlayView.length} of {parlays.length}</div>
              {parlays.length === 0
                ? <div className="text-sm text-slate-500 py-6 text-center">No tracked parlays. Build one in the Parlay Builder.</div>
                : parlayView.length === 0
                  ? <div className="text-sm text-slate-500 py-6 text-center">No parlays match this filter.</div>
                  : <div className="space-y-2">{parlayView.map((p) => <TrackedParlay key={p.id} p={p} />)}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
