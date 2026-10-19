import { useCallback, useEffect, useMemo, useState } from "react";
import {
  selectAll, insertRow, updateRows, callCollector, checkWriterKey, getWriterKey, setWriterKey,
  priceSide, decimalOdds, fmtOdds, pct, etToday, shiftDate, slateWindow, fmtTimeET,
} from "./efdb";

/* ============================================================================
   TrackedSportApp: ONE research/tracking page shared by every sport.
   A sport supplies only a config (name, collector function, markets, blend weight). Everything
   else (games, pull odds, board, filters, tracking, settlement, results) is identical, and all
   data lives in the shared Supabase tables, so every sport is tracked the same way.

   Collection is MANUAL: nothing pulls odds or settles unless you press the button.
   ============================================================================ */

export type SportConfig = {
  sport: string;                 // key used in the shared tables, e.g. "nhl"
  title: string;                 // "NHL"
  emoji: string;
  collector: string;             // edge function name, e.g. "nhl-collector"
  keep: number;                  // blend weight toward the model (0 = market only, 1 = model only)
  markets: Record<string, { label: string; unit: string }>;
  monthlyCap?: number;           // shown next to credits used
  modelNote?: string;            // one-line honesty note shown on the board
};

const BOOK_LABELS: Record<string, string> = {
  draftkings: "DraftKings", fanduel: "FanDuel", betmgm: "BetMGM", caesars: "Caesars",
  espnbet: "ESPN BET", fanatics: "Fanatics", williamhill_us: "Caesars",
};
const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };
const num = (s: string) => (s === "" || s == null ? null : Number(s));
const inRange = (v: number | null, lo: number | null, hi: number | null) =>
  v == null ? lo == null && hi == null : (lo == null || v >= lo) && (hi == null || v <= hi);
const profit = (status: string, odds: number, units: number) =>
  status === "won" ? units * (decimalOdds(odds) - 1) : status === "lost" ? -units : 0;

export default function TrackedSportApp({ config }: { config: SportConfig }) {
  const { sport } = config;
  const [date, setDate] = useState(etToday());
  const [tab, setTab] = useState<"games" | "board" | "bets" | "results">("games");
  const [events, setEvents] = useState<any[]>([]);
  const [snaps, setSnaps] = useState<any[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [bets, setBets] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [monthCredits, setMonthCredits] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [keyOk, setKeyOk] = useState<boolean | null>(null);
  const [showKey, setShowKey] = useState(false);

  const loadDay = useCallback(async (d: string) => {
    setLoading(true);
    try {
      const w = slateWindow(d);
      const ev = await selectAll(`events?sport=eq.${sport}&start_time=gte.${w.from}&start_time=lt.${w.to}&order=start_time.asc`);
      setEvents(ev);
      const ids = ev.map((e: any) => e.event_id);
      setSnaps(ids.length ? await selectAll(`snapshots?sport=eq.${sport}&event_id=in.(${ids.join(",")})`) : []);
      setRows(await selectAll(`v_prop_board?sport=eq.${sport}&is_latest=eq.true&start_time=gte.${w.from}&start_time=lt.${w.to}`));
    } catch (e: any) {
      setMsg({ kind: "err", text: `Could not load ${d}: ${e.message || e}` });
    } finally { setLoading(false); }
  }, [sport]);
  const loadBets = useCallback(async () => {
    try { setBets(await selectAll(`v_tracked_bets?sport=eq.${sport}&deleted_at=is.null&order=created_at.desc`)); } catch { /* shown on next action */ }
  }, [sport]);
  const loadRuns = useCallback(async () => {
    try {
      setRuns(await selectAll(`collector_runs?sport=eq.${sport}&order=started_at.desc&limit=6`));
      const m = new Date(); m.setUTCDate(1); m.setUTCHours(0, 0, 0, 0);
      const r = await selectAll(`collector_runs?sport=eq.${sport}&started_at=gte.${m.toISOString()}&select=credits_used`);
      setMonthCredits(r.reduce((s: number, x: any) => s + (x.credits_used || 0), 0));
    } catch { /* non-critical */ }
  }, [sport]);

  useEffect(() => { loadDay(date); }, [date, loadDay]);
  useEffect(() => { loadBets(); loadRuns(); checkWriterKey().then(setKeyOk).catch(() => setKeyOk(false)); }, [loadBets, loadRuns]);

  async function pullOdds() {
    setBusy("pull"); setMsg(null);
    try {
      const res = await callCollector(config.collector, { job: "snapshot", kind: "auto", date });
      const n = res.notes || {};
      const games = (n.games || []).filter((g: any) => !g.err);
      const errs = (n.games || []).filter((g: any) => g.err);
      setMsg({
        kind: "ok",
        text: games.length
          ? `Pulled ${games.length} game(s): ${games.map((g: any) => `${g.matchup} (${g.kind}, ${g.predictions} preds)`).join(", ")} · ${res.credits} credits${res.remaining != null ? ` · ${res.remaining.toLocaleString()} left on account` : ""}${errs.length ? ` · ${errs.length} failed` : ""}`
          : n.skipped || n.reason || "Nothing to pull.",
      });
      await Promise.all([loadDay(date), loadRuns()]);
    } catch (e: any) { setMsg({ kind: "err", text: e.message || String(e) }); }
    finally { setBusy(null); }
  }
  async function settle() {
    setBusy("settle"); setMsg(null);
    try {
      const res = await callCollector(config.collector, { job: "settle", date });
      const done = (res.notes?.settled || []).filter((s: any) => s.rows);
      setMsg({ kind: "ok", text: done.length ? `Graded ${done.length} finished game(s). Tracked bets update automatically.` : `No newly finished games (checked ${res.notes?.checked ?? 0}).` });
      await Promise.all([loadDay(date), loadBets(), loadRuns()]);
    } catch (e: any) { setMsg({ kind: "err", text: e.message || String(e) }); }
    finally { setBusy(null); }
  }

  const lastRemaining = runs.find((r) => r.credits_remaining != null)?.credits_remaining ?? null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <div className="max-w-5xl mx-auto px-4 pb-24">
        <header className="pt-5 pb-3 sticky top-0 bg-slate-950 z-20 border-b border-slate-800">
          <div className="flex items-end justify-between flex-wrap gap-3">
            <div>
              <h1 className="text-2xl font-black tracking-tight">{config.emoji} {config.title} <span className="text-emerald-400">EDGE</span> FINDER</h1>
              <p className="text-[11px] text-slate-400 mt-0.5" style={mono}>shared tracking · manual pulls · multi-book consensus</p>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <button onClick={() => setDate(shiftDate(date, -1))} aria-label="Previous day" className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-800">◂</button>
              <input type="date" aria-label="Slate date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-sm text-slate-100" />
              <button onClick={() => setDate(shiftDate(date, 1))} aria-label="Next day" className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-800">▸</button>
              <button onClick={() => setDate(etToday())} className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs hover:bg-slate-800 text-slate-300">today</button>
              <button onClick={() => setShowKey((s) => !s)} className={`rounded-lg px-2.5 py-1.5 text-xs font-medium border ${keyOk ? "border-emerald-700 text-emerald-300" : "border-amber-700 text-amber-300"}`} title="Edge Finder key: required to pull odds, settle, and track">
                🔑 {keyOk ? "key set" : "set key"}
              </button>
            </div>
          </div>
          {showKey && <KeyPanel onSaved={async () => { const ok = await checkWriterKey().catch(() => false); setKeyOk(ok); if (ok) setShowKey(false); return ok; }} />}
          <nav className="flex items-center justify-between mt-3 flex-wrap gap-2" aria-label={`${config.title} sections`}>
            <div className="flex gap-1 flex-wrap">
              {([["games", "Games"], ["board", `Board${rows.length ? ` (${rows.length})` : ""}`], ["bets", `My Bets${bets.length ? ` (${bets.length})` : ""}`], ["results", "Results"]] as const).map(([k, l]) => (
                <button key={k} onClick={() => setTab(k)} aria-current={tab === k ? "page" : undefined}
                  className={`px-3.5 py-1.5 rounded-lg text-sm font-semibold ${tab === k ? "bg-slate-800 text-emerald-400" : "text-slate-400 hover:text-slate-200"}`}>{l}</button>
              ))}
            </div>
            <div className="text-[11px] text-slate-400" style={mono}>
              credits this month: <b className="text-slate-200">{monthCredits.toLocaleString()}</b>{config.monthlyCap ? ` / ${config.monthlyCap.toLocaleString()}` : ""}
              {lastRemaining != null && <> · account left: <b className={lastRemaining < 1500 ? "text-amber-300" : "text-slate-200"}>{lastRemaining.toLocaleString()}</b></>}
            </div>
          </nav>
        </header>

        {msg && <div role="status" className={`mt-3 text-sm rounded-lg px-3 py-2 border ${msg.kind === "err" ? "text-amber-200 bg-amber-950/40 border-amber-800/60" : "text-emerald-200 bg-emerald-950/30 border-emerald-900/60"}`}>{msg.text}</div>}

        {tab === "games" && <GamesTab config={config} events={events} snaps={snaps} rows={rows} loading={loading} busy={busy} onPull={pullOdds} onSettle={settle} keyOk={!!keyOk} />}
        {tab === "board" && <BoardTab config={config} rows={rows} bets={bets} keyOk={!!keyOk} onTracked={loadBets} setMsg={setMsg} loading={loading} />}
        {tab === "bets" && <BetsTab config={config} bets={bets} onChanged={loadBets} setMsg={setMsg} />}
        {tab === "results" && <ResultsTab config={config} />}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- key panel */
function KeyPanel({ onSaved }: { onSaved: () => Promise<boolean> }) {
  const [v, setV] = useState(getWriterKey());
  const [state, setState] = useState<string>("");
  return (
    <div className="mt-2 bg-slate-900/70 border border-slate-800 rounded-lg px-3 py-2.5 text-xs text-slate-300 flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 flex-1 min-w-[220px]">
        <span>Edge Finder key (stored only in this browser; lets you pull odds, settle and track)</span>
        <input type="password" value={v} onChange={(e) => setV(e.target.value)} placeholder="paste key" autoComplete="off"
          className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-100" style={mono} />
      </label>
      <button onClick={async () => { setWriterKey(v); setState("checking…"); const ok = await onSaved(); setState(ok ? "accepted" : "rejected: check the key"); }}
        className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded px-3 py-1.5">Save</button>
      {state && <span role="status" className={state === "accepted" ? "text-emerald-300" : "text-amber-300"}>{state}</span>}
    </div>
  );
}

/* ---------------------------------------------------------------- games */
function GamesTab({ config, events, snaps, rows, loading, busy, onPull, onSettle, keyOk }: any) {
  const snapBy = useMemo(() => {
    const m: Record<string, any> = {};
    for (const s of snaps) (m[s.event_id] = m[s.event_id] || {})[s.kind] = s;
    return m;
  }, [snaps]);
  const predBy = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of rows) m[r.event_id] = (m[r.event_id] || 0) + 1;
    return m;
  }, [rows]);
  const upcoming = events.filter((e: any) => !e.final && ["FUT", "PRE"].includes(e.status));
  return (
    <section className="mt-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={onPull} disabled={!!busy || !keyOk} className="bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white font-bold text-sm rounded-lg px-3 py-1.5"
          title="Pulls the opening snapshot for games that don't have one; within 60 min of start, pulls the near-close snapshot instead. Each game/snapshot is pulled once.">
          {busy === "pull" ? "Pulling…" : "Pull odds"}
        </button>
        <button onClick={onSettle} disabled={!!busy || !keyOk} className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-bold text-sm rounded-lg px-3 py-1.5" title="Grades finished games from official box scores (free).">
          {busy === "settle" ? "Settling…" : "Settle finished"}
        </button>
        {!keyOk && <span className="text-[11px] text-amber-300">Set your key (🔑) to enable pulls and settlement.</span>}
        <span className="text-[11px] text-slate-400 ml-auto" style={mono}>~{Object.keys(config.markets).length} credits per game per snapshot · {upcoming.length} upcoming</span>
      </div>
      {loading ? <div className="py-8 text-center text-sm text-slate-400" style={mono}>loading…</div>
        : events.length === 0 ? (
          <div className="py-10 text-center text-sm text-slate-400">
            No {config.title} games stored for this date yet. Press <b className="text-sky-300">Pull odds</b> to load the slate and its odds.
          </div>
        ) : events.map((e: any) => {
          const s = snapBy[e.event_id] || {};
          const live = e.status === "LIVE" || e.status === "CRIT";
          return (
            <div key={e.event_id} className="bg-slate-900/70 border border-slate-800 rounded-xl px-4 py-3 flex items-center gap-3 flex-wrap">
              <div className="text-[11px] text-slate-400 w-16 shrink-0" style={mono}>{fmtTimeET(e.start_time)}</div>
              <div className="flex-1 min-w-[140px]">
                <div className="font-bold">{e.away} <span className="text-slate-500">@</span> {e.home}</div>
                <div className="text-[11px] text-slate-400">{e.away_name} at {e.home_name}</div>
              </div>
              {(e.final || live) && e.home_score != null && <div className="text-sm font-bold" style={mono}>{e.away_score}–{e.home_score}</div>}
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wide ${e.final ? "bg-slate-700 text-slate-200" : live ? "bg-rose-600 text-white" : e.status === "PPD" || e.status === "CNCL" ? "bg-amber-700 text-white" : "bg-slate-800 text-slate-300"}`}>
                {e.final ? "FINAL" : live ? "LIVE" : e.status === "PPD" ? "POSTPONED" : e.status === "CNCL" ? "CANCELED" : "SCHEDULED"}
              </span>
              <div className="flex gap-1.5 text-[10px]" style={mono}>
                {["open", "close"].map((k) => (
                  <span key={k} title={s[k] ? `${k} snapshot: ${new Date(s[k].captured_at).toLocaleString()} · ${s[k].quotes} quotes` : `no ${k} snapshot`}
                    className={`px-1.5 py-0.5 rounded border ${s[k] ? "border-sky-700 text-sky-300" : "border-slate-700 text-slate-500"}`}>
                    {k} {s[k] ? fmtTimeET(s[k].captured_at) : "—"}
                  </span>
                ))}
                <span className="px-1.5 py-0.5 rounded border border-slate-700 text-slate-300">{predBy[e.event_id] || 0} preds</span>
              </div>
            </div>
          );
        })}
    </section>
  );
}

/* ---------------------------------------------------------------- board */
const SORTS: Record<string, [string, (a: any, b: any) => number]> = {
  ev_desc: ["EV ↓", (a, b) => (b.p?.ev ?? -9) - (a.p?.ev ?? -9)],
  edge_desc: ["Edge ↓", (a, b) => (b.p?.edge ?? -9) - (a.p?.edge ?? -9)],
  model_desc: ["Model % ↓", (a, b) => (b.p?.blendCond ?? 0) - (a.p?.blendCond ?? 0)],
  delta_desc: ["Proj vs line ↓", (a, b) => b.delta - a.delta],
  start_asc: ["Start time", (a, b) => Date.parse(a.r.start_time) - Date.parse(b.r.start_time)],
  name_asc: ["Player A–Z", (a, b) => String(a.r.player_name).localeCompare(String(b.r.player_name))],
};

function BoardTab({ config, rows, bets, keyOk, onTracked, setMsg, loading }: any) {
  const [market, setMarket] = useState("all");
  const [side, setSide] = useState("all");
  const [game, setGame] = useState("all");
  const [q, setQ] = useState("");
  const [upcomingOnly, setUpcomingOnly] = useState(true);
  const [rng, setRng] = useState<Record<string, string>>({});
  const [sort, setSort] = useState("ev_desc");
  const [units, setUnits] = useState("1");
  const [mode, setMode] = useState<"paper" | "placed">("paper");
  const [openId, setOpenId] = useState<string | null>(null);

  const entries = useMemo(() => {
    const out: any[] = [];
    for (const r of rows) {
      for (const s of ["over", "under"] as const) {
        const odds = s === "over" ? r.best_over : r.best_under;
        if (odds == null) continue;
        const p = priceSide({ side: s, pOver: num(r.p_over), pUnder: num(r.p_under), pPush: num(r.p_push), novigOver: num(r.novig_over), odds, keep: config.keep });
        const line = Number(r.line), proj = Number(r.proj);
        out.push({
          id: `${r.id}-${s}`, r, side: s, odds, book: s === "over" ? r.best_over_book : r.best_under_book, p,
          delta: s === "over" ? proj - line : line - proj,
        });
      }
    }
    return out;
  }, [rows, config.keep]);

  const games = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.event_id, `${r.away}@${r.home}`);
    return [...m.entries()];
  }, [rows]);
  const trackedKeys = useMemo(() => new Set(bets.map((b: any) => `${b.event_id}|${b.player_id}|${b.market}|${Number(b.line)}|${b.side}`)), [bets]);

  const f = (k: string) => num(rng[k] ?? "");
  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const minO = f("minOdds"), maxO = f("maxOdds");
    return entries.filter((e) => {
      if (market !== "all" && e.r.market !== market) return false;
      if (side !== "all" && e.side !== side) return false;
      if (game !== "all" && e.r.event_id !== game) return false;
      if (upcomingOnly && (e.r.final || Date.parse(e.r.start_time) <= Date.now())) return false;
      if (qq && !`${e.r.player_name} ${e.r.team} ${e.r.away} ${e.r.home}`.toLowerCase().includes(qq)) return false;
      if (!inRange(e.p?.ev != null ? e.p.ev * 100 : null, f("minEV"), f("maxEV"))) return false;
      if (!inRange(e.p?.edge != null ? e.p.edge * 100 : null, f("minEdge"), f("maxEdge"))) return false;
      if (!inRange(e.p ? e.p.blendCond * 100 : null, f("minModel"), f("maxModel"))) return false;
      if (!inRange(e.delta, f("minDelta"), f("maxDelta"))) return false;
      const d = decimalOdds(e.odds);
      if (minO != null && d < decimalOdds(minO)) return false;
      if (maxO != null && d > decimalOdds(maxO)) return false;
      return true;
    }).sort(SORTS[sort][1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, market, side, game, q, upcomingOnly, rng, sort]);

  async function track(e: any) {
    try {
      await insertRow("tracked_bets", {
        sport: config.sport, event_id: e.r.event_id, player_id: e.r.player_id, player_name: e.r.player_name, team: e.r.team,
        market: e.r.market, line: Number(e.r.line), side: e.side, book: e.book, odds: e.odds,
        units: Math.max(0, Number(units) || 0), mode, model_version: e.r.model_version, snapshot_kind: e.r.snapshot_kind,
        proj: Number(e.r.proj), model_p: e.p ? +(e.p.blendCond * (1 - e.p.push)).toFixed(5) : null,
        raw_p: e.p ? +(e.p.rawCond * (1 - e.p.push)).toFixed(5) : null, novig: e.p?.mkt != null ? +e.p.mkt.toFixed(5) : null,
        ev: e.p?.ev != null ? +e.p.ev.toFixed(5) : null,
      });
      setMsg({ kind: "ok", text: `Tracked ${e.r.player_name} ${e.side} ${e.r.line} ${config.markets[e.r.market]?.label || e.r.market} @ ${fmtOdds(e.odds)} (${mode}, ${units}u).` });
      onTracked();
    } catch (err: any) { setMsg({ kind: "err", text: err.message || String(err) }); }
  }

  const rangeInput = (k: string, label: string, ph: string) => (
    <label className="text-[11px] text-slate-400 flex flex-col gap-0.5">{label}
      <input value={rng[k] ?? ""} onChange={(ev) => setRng((p) => ({ ...p, [k]: ev.target.value }))} placeholder={ph} inputMode="decimal"
        className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-sm w-[4.5rem] text-slate-100 placeholder:text-slate-600" />
    </label>
  );
  const activeRanges = Object.values(rng).filter((v) => v !== "").length;

  return (
    <section className="mt-3">
      {config.modelNote && <div className="mb-3 text-[11px] text-slate-400 border border-slate-800 rounded-lg px-3 py-2 bg-slate-900/40">{config.modelNote}</div>}
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search player or team" aria-label="Search" className="bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-sm w-44 text-slate-100 placeholder:text-slate-500" />
        <Select label="market" v={market} set={setMarket} opts={[["all", "All markets"], ...Object.entries(config.markets).map(([k, m]: any) => [k, m.label])]} />
        <Select label="side" v={side} set={setSide} opts={[["all", "Both"], ["over", "Over"], ["under", "Under"]]} />
        <Select label="game" v={game} set={setGame} opts={[["all", "All games"], ...games]} />
        <Select label="sort" v={sort} set={setSort} opts={Object.entries(SORTS).map(([k, v]) => [k, v[0]])} />
        <label className="text-xs text-slate-300 flex items-center gap-1.5"><input type="checkbox" checked={upcomingOnly} onChange={(e) => setUpcomingOnly(e.target.checked)} className="accent-emerald-500" />upcoming only</label>
        <div className="ml-auto text-[11px] text-slate-400" style={mono}>{filtered.length} of {entries.length}</div>
      </div>
      <div className="flex items-end gap-2.5 flex-wrap mb-3 p-2.5 rounded-lg bg-slate-900/40 border border-slate-800">
        {rangeInput("minEV", "EV % min", "any")}{rangeInput("maxEV", "EV % max", "any")}
        {rangeInput("minEdge", "edge pp min", "any")}{rangeInput("maxEdge", "edge pp max", "any")}
        {rangeInput("minModel", "model % min", "any")}{rangeInput("maxModel", "model % max", "any")}
        {rangeInput("minOdds", "odds min", "e.g. -200")}{rangeInput("maxOdds", "odds max", "e.g. +300")}
        {rangeInput("minDelta", "proj−line min", "any")}{rangeInput("maxDelta", "proj−line max", "any")}
        {activeRanges > 0 && <button onClick={() => setRng({})} className="text-[11px] text-slate-400 hover:text-rose-300 border border-slate-700 rounded px-2 py-1">clear ranges</button>}
        <div className="ml-auto flex items-end gap-2">
          <label className="text-[11px] text-slate-400 flex flex-col gap-0.5">units
            <input value={units} onChange={(e) => setUnits(e.target.value)} inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-sm w-14 text-slate-100" />
          </label>
          <Select label="record as" v={mode} set={setMode} opts={[["paper", "Paper"], ["placed", "Placed"]]} />
        </div>
      </div>
      <p className="text-[11px] text-slate-500 mb-2">“proj−line” is direction-adjusted (positive = projection favors your side). Odds = best price across books; market % = consensus de-vigged across books with both sides.</p>
      {loading ? <div className="py-8 text-center text-sm text-slate-400" style={mono}>loading…</div>
        : entries.length === 0 ? <div className="py-10 text-center text-sm text-slate-400">No priced props for this date yet. Use <b className="text-sky-300">Pull odds</b> on the Games tab.</div>
        : filtered.length === 0 ? <div className="py-10 text-center text-sm text-slate-400">Nothing passes the current filters.</div>
        : (
          <div className="space-y-2">
            {filtered.slice(0, 300).map((e) => {
              const tracked = trackedKeys.has(`${e.r.event_id}|${e.r.player_id}|${e.r.market}|${Number(e.r.line)}|${e.side}`);
              const evGood = (e.p?.ev ?? -1) >= 0;
              const label = config.markets[e.r.market]?.label || e.r.market;
              return (
                <div key={e.id} className="bg-slate-900/70 border border-slate-800 rounded-xl overflow-hidden">
                  <div className="flex items-center gap-3 px-4 py-2.5 flex-wrap">
                    <div className="flex-1 min-w-[180px]">
                      <div className="font-semibold truncate">{e.r.player_name} <span className="text-slate-500 text-xs">{e.r.team} · {e.r.away}@{e.r.home} · {fmtTimeET(e.r.start_time)}</span></div>
                      <div className="text-[11px] text-slate-300" style={mono}>
                        {e.side} {Number(e.r.line)} {label} @ <b>{fmtOdds(e.odds)}</b> <span className="text-slate-500">{BOOK_LABELS[e.book] || e.book}</span>
                        {" · "}<span className="text-sky-300">proj {Number(e.r.proj).toFixed(2)}</span>
                        <span className={`ml-1 font-bold ${e.delta > 0 ? "text-emerald-400" : "text-rose-400"}`}>{e.delta >= 0 ? "+" : "−"}{Math.abs(e.delta).toFixed(2)}</span>
                      </div>
                    </div>
                    <div className="text-right text-[11px]" style={mono}>
                      <div className="text-slate-300">model {pct(e.p?.blendCond)} · mkt {pct(e.p?.mkt)} <span className="text-slate-500">({e.r.books_2way}bk)</span></div>
                      <div className={evGood ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>EV {e.p?.ev != null ? `${e.p.ev >= 0 ? "+" : ""}${(e.p.ev * 100).toFixed(1)}%` : "—"} · edge {e.p?.edge != null ? `${e.p.edge >= 0 ? "+" : ""}${(e.p.edge * 100).toFixed(1)}pp` : "—"}</div>
                    </div>
                    <button onClick={() => setOpenId(openId === e.id ? null : e.id)} aria-expanded={openId === e.id} className="text-[11px] text-slate-400 hover:text-emerald-300 border border-slate-700 rounded px-2 py-1">{openId === e.id ? "hide" : "why"}</button>
                    <button onClick={() => track(e)} disabled={tracked || !keyOk} title={!keyOk ? "Set your key (🔑) to track" : ""}
                      className={`text-[11px] font-bold rounded px-2 py-1 ${tracked ? "bg-slate-700 text-slate-400" : "bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40"}`}>{tracked ? "tracked" : "track"}</button>
                  </div>
                  {openId === e.id && <Explain e={e} config={config} />}
                </div>
              );
            })}
            {filtered.length > 300 && <div className="text-[11px] text-slate-400 text-center">Showing first 300; narrow the filters to see the rest.</div>}
          </div>
        )}
    </section>
  );
}

function Explain({ e, config }: any) {
  const inp = e.r.inputs || {};
  const items = Object.entries(inp).filter(([, v]) => v != null && typeof v !== "object");
  return (
    <div className="border-t border-slate-800 px-4 py-2.5 text-[11px] text-slate-300 grid sm:grid-cols-2 gap-x-6 gap-y-1" style={mono}>
      <div>raw model {pct(e.p?.rawCond)} → blended {pct(e.p?.blendCond)} (keeps {Math.round(config.keep * 100)}% of the model's disagreement with market)</div>
      <div>market (consensus no-vig) {pct(e.p?.mkt)} from {e.r.books_2way} book(s) · {e.r.books} quoting</div>
      <div>projection {Number(e.r.proj).toFixed(3)} · {e.r.model_version} · {e.r.snapshot_kind} snapshot</div>
      {e.p?.push > 0 && <div>push chance {pct(e.p.push)} (integer line; EV accounts for it)</div>}
      {items.map(([k, v]: any) => <div key={k}>{k}: {typeof v === "number" ? (Number.isInteger(v) ? v : Math.abs(v) < 10 ? v.toFixed(3) : v.toFixed(1)) : String(v)}</div>)}
    </div>
  );
}

function Select({ label, v, set, opts }: { label: string; v: string; set: (x: any) => void; opts: any[] }) {
  return (
    <label className="text-xs text-slate-400 flex items-center gap-1.5 whitespace-nowrap">{label}
      <select value={v} onChange={(e) => set(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100">
        {opts.map(([k, l]: any) => <option key={k} value={k}>{l}</option>)}
      </select>
    </label>
  );
}

/* ---------------------------------------------------------------- my bets */
function BetsTab({ config, bets, onChanged, setMsg }: any) {
  const [status, setStatus] = useState("all");
  const [mode, setMode] = useState("all");
  const [market, setMarket] = useState("all");
  const view = bets.filter((b: any) =>
    (status === "all" || (status === "settled" ? ["won", "lost", "push", "void"].includes(b.status) : b.status === status)) &&
    (mode === "all" || b.mode === mode) && (market === "all" || b.market === market));
  const settled = view.filter((b: any) => b.status === "won" || b.status === "lost");
  const w = settled.filter((b: any) => b.status === "won").length;
  const staked = settled.reduce((s: number, b: any) => s + Number(b.units), 0);
  const net = settled.reduce((s: number, b: any) => s + profit(b.status, b.odds, Number(b.units)), 0);
  const expected = settled.reduce((s: number, b: any) => s + (b.ev != null ? Number(b.ev) * Number(b.units) : 0), 0);

  async function remove(b: any) {
    try { await updateRows("tracked_bets", `id=eq.${b.id}`, { deleted_at: new Date().toISOString() }); onChanged(); }
    catch (e: any) { setMsg({ kind: "err", text: e.message || String(e) }); }
  }
  return (
    <section className="mt-3">
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <Select label="status" v={status} set={setStatus} opts={[["all", "All"], ["open", "Open"], ["settled", "Settled"], ["won", "Won"], ["lost", "Lost"], ["push", "Push"], ["void", "Void"]]} />
        <Select label="type" v={mode} set={setMode} opts={[["all", "Paper + placed"], ["paper", "Paper"], ["placed", "Placed"]]} />
        <Select label="market" v={market} set={setMarket} opts={[["all", "All markets"], ...Object.entries(config.markets).map(([k, m]: any) => [k, m.label])]} />
        <div className="ml-auto text-[11px] text-slate-300" style={mono}>
          showing {view.length} of {bets.length}
          {settled.length > 0 && <> · {w}-{settled.length - w} ({pct(w / settled.length)}) · net <b className={net >= 0 ? "text-emerald-400" : "text-rose-400"}>{net >= 0 ? "+" : ""}{net.toFixed(2)}u</b> · ROI {pct(staked ? net / staked : null)} · expected {expected >= 0 ? "+" : ""}{expected.toFixed(2)}u</>}
        </div>
      </div>
      {view.length === 0 ? <div className="py-10 text-center text-sm text-slate-400">No tracked bets{bets.length ? " match these filters" : " yet. Track from the Board"}.</div> : (
        <div className="space-y-2">
          {view.map((b: any) => {
            const pill: Record<string, string> = { open: "bg-slate-700 text-slate-200", won: "bg-emerald-600 text-white", lost: "bg-rose-600 text-white", push: "bg-amber-600 text-slate-950", void: "bg-slate-600 text-slate-200" };
            const pnl = profit(b.status, b.odds, Number(b.units));
            return (
              <div key={b.id} className="bg-slate-900/70 border border-slate-800 rounded-xl px-4 py-2.5 flex items-center gap-3 flex-wrap">
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${pill[b.status] || pill.open}`}>{b.status}</span>
                <div className="flex-1 min-w-[180px]">
                  <div className="font-semibold">{b.player_name} <span className="text-slate-500 text-xs">{b.away}@{b.home} · {new Date(b.start_time).toLocaleDateString()}</span></div>
                  <div className="text-[11px] text-slate-300" style={mono}>{b.side} {Number(b.line)} {config.markets[b.market]?.label || b.market} @ {fmtOdds(b.odds)} {BOOK_LABELS[b.book] || b.book} · {Number(b.units)}u {b.mode}</div>
                </div>
                <div className="text-right text-[11px]" style={mono}>
                  <div className="text-slate-300">model {pct(b.model_p)} · mkt {pct(b.novig)} · EV {b.ev != null ? `${(b.ev * 100).toFixed(1)}%` : "—"}</div>
                  <div className="text-slate-400">actual {b.actual != null ? Number(b.actual) : "—"}{b.status === "won" || b.status === "lost" ? <> · <b className={pnl >= 0 ? "text-emerald-400" : "text-rose-400"}>{pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}u</b></> : null}</div>
                </div>
                <button onClick={() => remove(b)} aria-label={`Remove ${b.player_name} bet`} className="text-[11px] text-slate-500 hover:text-rose-300 border border-slate-700 rounded px-2 py-1">remove</button>
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-4 text-[11px] text-slate-500">Results are graded automatically from official box scores when you press Settle. A player who doesn't play is void. “Expected” is the sum of each bet's EV at the time you tracked it, a check on whether results are running above or below what the model claimed.</p>
    </section>
  );
}

/* ---------------------------------------------------------------- results */
function ResultsTab({ config }: { config: SportConfig }) {
  const [from, setFrom] = useState(shiftDate(etToday(), -30));
  const [to, setTo] = useState(etToday());
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    setRows(null); setErr("");
    selectAll(`v_prop_board?sport=eq.${config.sport}&is_latest=eq.true&final=eq.true&start_time=gte.${slateWindow(from).from}&start_time=lt.${slateWindow(to).to}&select=event_id,market,line,p_over,p_under,p_push,novig_over,best_over,best_under,actual,participated,model_version`)
      .then((r) => { if (alive) setRows(r); }).catch((e) => { if (alive) setErr(String(e.message || e)); });
    return () => { alive = false; };
  }, [config.sport, from, to]);

  const stats = useMemo(() => {
    if (!rows) return null;
    const by: Record<string, any> = {};
    const add = (k: string) => (by[k] = by[k] || { n: 0, bRaw: 0, bBlend: 0, bMkt: 0, sumRaw: 0, hits: 0, picks: 0, pickWins: 0, pickMkt: 0, pickProfit: 0, pickEv: 0, events: new Set() });
    for (const r of rows) {
      if (r.actual == null || r.participated === false || r.novig_over == null) continue;
      const actual = Number(r.actual), line = Number(r.line);
      if (actual === line) continue; // push: excluded from scoring
      const y = actual > line ? 1 : 0;
      for (const key of [r.market, "__all"]) {
        const s = add(key);
        const po = priceSide({ side: "over", pOver: num(r.p_over), pUnder: num(r.p_under), pPush: num(r.p_push), novigOver: num(r.novig_over), odds: null, keep: config.keep });
        if (!po) continue;
        s.n++; s.events.add(r.event_id);
        s.bRaw += (po.rawCond - y) ** 2; s.bBlend += (po.blendCond - y) ** 2; s.bMkt += (Number(r.novig_over) - y) ** 2;
        s.sumRaw += po.rawCond; s.hits += y;
        for (const side of ["over", "under"] as const) {
          const odds = side === "over" ? r.best_over : r.best_under;
          if (odds == null) continue;
          const p = priceSide({ side, pOver: num(r.p_over), pUnder: num(r.p_under), pPush: num(r.p_push), novigOver: num(r.novig_over), odds, keep: config.keep });
          if (!p || p.ev == null || p.ev <= 0) continue;
          const won = side === "over" ? y === 1 : y === 0;
          s.picks++; s.pickWins += won ? 1 : 0; s.pickMkt += p.mkt ?? 0; s.pickEv += p.ev;
          s.pickProfit += won ? decimalOdds(odds) - 1 : -1;
        }
      }
    }
    return by;
  }, [rows, config.keep]);

  const order = ["__all", ...Object.keys(config.markets)];
  return (
    <section className="mt-3">
      <div className="flex items-end gap-3 flex-wrap mb-3 p-2.5 rounded-lg bg-slate-900/40 border border-slate-800">
        <label className="text-xs text-slate-400 flex flex-col gap-1">from<input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100" /></label>
        <label className="text-xs text-slate-400 flex flex-col gap-1">to<input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100" /></label>
        <p className="text-[11px] text-slate-400 flex-1 min-w-[240px]">Every prediction on finished games (latest snapshot per game), not just tracked bets. Lower Brier is better; the model only adds value where it beats the market column. “+EV picks” = every side the model rated +EV at the best available price.</p>
      </div>
      {err && <div className="text-sm text-amber-300 mb-2">{err}</div>}
      {!rows ? <div className="py-8 text-center text-sm text-slate-400" style={mono}>loading…</div>
        : !stats || !stats.__all ? <div className="py-10 text-center text-sm text-slate-400">No graded predictions in this range yet. Pull odds before games, then Settle after they finish.</div>
        : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]" style={mono}>
              <caption className="sr-only">{config.title} model versus market by market</caption>
              <thead className="text-slate-400 text-left">
                <tr className="border-b border-slate-800">
                  <th scope="col" className="py-1.5 pr-3">market</th><th scope="col" className="pr-3">lines</th><th scope="col" className="pr-3">games</th>
                  <th scope="col" className="pr-3">Brier raw</th><th scope="col" className="pr-3">Brier blend</th><th scope="col" className="pr-3">Brier mkt</th>
                  <th scope="col" className="pr-3">avg P(over) vs hit</th>
                  <th scope="col" className="pr-3">+EV picks</th><th scope="col" className="pr-3">won − mkt</th><th scope="col" className="pr-3">flat ROI</th><th scope="col">claimed EV</th>
                </tr>
              </thead>
              <tbody>
                {order.filter((k) => stats[k]).map((k) => {
                  const s = stats[k];
                  const better = s.bBlend < s.bMkt;
                  return (
                    <tr key={k} className={`border-b border-slate-900 ${k === "__all" ? "font-bold" : ""}`}>
                      <th scope="row" className="py-1.5 pr-3 text-left">{k === "__all" ? "All" : config.markets[k]?.label || k}</th>
                      <td className="pr-3">{s.n}</td><td className="pr-3">{s.events.size}</td>
                      <td className="pr-3">{(s.bRaw / s.n).toFixed(4)}</td>
                      <td className={`pr-3 ${better ? "text-emerald-400" : "text-rose-300"}`}>{(s.bBlend / s.n).toFixed(4)}</td>
                      <td className="pr-3">{(s.bMkt / s.n).toFixed(4)}</td>
                      <td className="pr-3">{pct(s.sumRaw / s.n)} vs {pct(s.hits / s.n)}</td>
                      <td className="pr-3">{s.picks}</td>
                      <td className={`pr-3 ${s.picks && s.pickWins / s.picks - s.pickMkt / s.picks >= 0 ? "text-emerald-400" : "text-rose-300"}`}>{s.picks ? `${((s.pickWins / s.picks - s.pickMkt / s.picks) * 100).toFixed(1)}pp` : "—"}</td>
                      <td className="pr-3">{s.picks ? pct(s.pickProfit / s.picks) : "—"}</td>
                      <td>{s.picks ? pct(s.pickEv / s.picks) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-3 text-[11px] text-slate-500">Small samples swing a lot: treat anything under a few hundred lines or ~30 games as noise. Pushes and players who didn't play are excluded.</p>
          </div>
        )}
    </section>
  );
}
