import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookmarkPlus, Bug, Check, ChevronDown, ChevronLeft, ChevronRight, Download, ListFilter, MoreHorizontal, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { probToAmerican, suggestedUnits } from "./math";
import { BoardHead, BoardRow, TrendRow } from "./cards";
import { makeDeltaSignal } from "./signals";
import { Chip, GameDetail } from "./slate";
import { PlayerAnalysis, PlayerAnalysisIntro } from "./analysis";
import { ModelPage } from "./model";
import { useBets } from "./betStore";
import { betFromEntry, clearBoard, getBoard, saveBoard, setLiveCredits, setSlate } from "./live";
import { clearBoardLog as wipeBoardLog, downloadBoardLogCsv, settleBoardLog as gradeBoardLog } from "./boardlog";
import { Badge, Banner, Btn, Empty, Expander, Field, MenuBtn, Panel, Pop, SearchField, Seg, Select, Switch, Team, TextIn, Th, confirmDialog, cx, fOdds, fSigned, fTime, readLS, toast, writeLS } from "../ui/kit";

/* SportApp: the shared Edge Finder shell (Slate / Board / Trends / Players / Model).
   Tracked bets and their stats live in the hub (src/hub); this page tracks into the same shared store.
   Everything sport-specific comes from the `sport` adapter (see sports/mlb/adapter.tsx); this file holds
   no sport logic of its own, so every sport looks and behaves the same. */

const TABS = [["slate", "Slate"], ["board", "Board"], ["trends", "Trends"], ["analysis", "Players"], ["log", "Model"]];
// Board filters. Saved per sport (except the search text and the game, which belong to one slate).
const EMPTY_F = { q: "", cls: "all", cat: "all", game: "all", side: "all", minEdge: "", minModel: "", minEV: "", minOdds: "", maxOdds: "", minDelta: "", maxDelta: "", aligned: false, signal: "all", evOnly: false, best: false };
const BUILT_IN_PRESETS = [
  { id: "all", name: "Everything", f: {} },
  { id: "ev", name: "+EV, best side", f: { evOnly: true, best: true } },
  { id: "signal", name: "Strong signal, projection agrees", f: { signal: "strong", aligned: true } },
];
const LS_PRESETS = "ef_board_presets_v1", LS_VIEW = "ef_board_view_v1";
const CHIP = {
  cls: (v) => (v === "lines" ? "Game lines" : "Player props"), minEV: (v) => `EV at least ${v}%`, minEdge: (v) => `Edge at least ${v}%`, minModel: (v) => `Model at least ${v}%`,
  minOdds: (v) => `No shorter than ${fOdds(Number(v))}`, maxOdds: (v) => `No longer than ${fOdds(Number(v))}`, minDelta: (v) => `Projection gap at least ${v}`, maxDelta: (v) => `Projection gap at most ${v}`,
  aligned: () => "Projection agrees", signal: (v) => (v === "strong" ? "Strong signal" : "Moderate signal or better"),
};
const amToB = (o) => (o > 0 ? o / 100 : 100 / -o);
const getDelta = (e) => (e.proj ?? 0) - parseFloat(e.line ?? 0);
const clock = (iso) => fTime(iso);

/* ============================================================ */
// tab / onTabChange (optional): lets the app frame drive the active tab from the page address
// (#/mlb/board). Without them the shell keeps its own tab state exactly as before.
export default function SportApp({ sport, tab: routeTab = null, onTabChange = null }) {
  const { ALL_PROPS, BOOKS, BOOK_LABELS, CATEGORY_ORDER, DEFAULT_LINE, ODDS_TESTING_LIMIT, isLineType, matchesQuery, STAT_ORDER, TREND_PROPS } = sport.config;
  const { LS_CREDITS, MODEL_VERSION, appendBoardLog, boardLogReady, getBoardLogSaveError, loadBoardLog, loadBookOverrides, loadCredits, loadShowCoverage, saveBookOverrides, saveShowCoverage } = sport.storage;
  const { fetchSchedule, fetchOddsEvents, fetchEventOdds, matchEvent, oddsDebug, parseEventOdds, parseGameOdds, buildGameLineEntries, searchPlayers, fetchPlayerAnalysisProfile, findPlayerInSlate, buildTrendCard } = sport.api;
  const { projectProp } = sport.model;
  // Every page element is the shared component; a sport supplies only data. Rows get the sport's
  // game-line / yes-no market lists and its calibrated signal thresholds (config.SIGNAL_RULES).
  const isYesNoType = sport.config.isYesNoType || null;
  const getDeltaSignal = useMemo(() => makeDeltaSignal(sport.config.SIGNAL_RULES), [sport]);
  const rowCfg = useMemo(() => ({ isLineType, isYesNoType, getDeltaSignal }), [sport, getDeltaSignal]);
  const meta = sport.meta;
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const [date, setDate] = useState(todayStr());
  // previous / next day: shifts by calendar day using Date's own rollover, so month and year
  // boundaries are handled for free.
  function shiftDate(days) {
    setDate((cur) => {
      const [y, m, d] = cur.split("-").map(Number);
      const nd = new Date(y, (m || 1) - 1, d || 1);
      nd.setDate(nd.getDate() + days);
      return `${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, "0")}-${String(nd.getDate()).padStart(2, "0")}`;
    });
  }
  const season = date.slice(0, 4);
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [stamp, setStamp] = useState(null);
  const [ownTab, setOwnTab] = useState(routeTab || "slate");
  const tab = routeTab || ownTab;
  const setTab = (k) => { setOwnTab(k); if (onTabChange) onTabChange(k); };
  const [open, setOpen] = useState(null);
  const [detail, setDetail] = useState({});
  const [book, setBook] = useState("draftkings");
  const [bookOverrides, setBookOverrides] = useState(() => loadBookOverrides());
  const [showCoverage, setShowCoverage] = useState(() => loadShowCoverage());
  function toggleShowCoverage() { setShowCoverage((v) => { const n = !v; saveShowCoverage(n); return n; }); }
  function setBookOverride(type, bk) {
    setBookOverrides((prev) => {
      const next = { ...prev };
      if (!bk) delete next[type]; else next[type] = bk;
      saveBookOverrides(next);
      return next;
    });
  }
  const [board, setBoard] = useState({});            // pk -> entries[]
  const [pulledAt, setPulledAt] = useState({});      // pk -> when its odds were pulled
  const [oddsLoading, setOddsLoading] = useState(null);
  const [pullingAll, setPullingAll] = useState(null); // null | { done, total } while "pull all" runs
  const [credits, setCredits] = useState(loadCredits());
  const [pullCost, setPullCost] = useState(null);     // credits the last odds pull used
  const fetchesRef = useRef(0);
  const creditsRef = useRef(credits);
  creditsRef.current = credits;
  const [logRows, setLogRows] = useState(() => loadBoardLog());
  const [boardLogSettling, setBoardLogSettling] = useState(false);
  const [boardLogSettleMsg, setBoardLogSettleMsg] = useState("");
  const [f, setFRaw] = useState(() => ({ ...EMPTY_F, ...readLS(`ef_board_filters_v1_${sport.id}`, {}), q: "", game: "all" }));
  const [boardSort, setBoardSort] = useState({ k: "ev", d: -1 });
  const [boardView, setBoardViewRaw] = useState(() => readLS(LS_VIEW, "flat"));
  const [shown, setShown] = useState(80);
  const [presets, setPresets] = useState(() => readLS(LS_PRESETS, []));
  const [presetName, setPresetName] = useState("");
  const setF = (patch) => { setShown(80); setFRaw((p) => { const n = { ...p, ...patch }; const { q: _q, game: _game, ...keep } = n; writeLS(`ef_board_filters_v1_${sport.id}`, keep); return n; }); };
  const setBoardView = (v) => { setBoardViewRaw(v); writeLS(LS_VIEW, v); };
  const [coverage, setCoverage] = useState({});   // pk -> { game, book, returned[], matched[] }
  const [trendSearch, setTrendSearch] = useState("");
  const [trendCatFilter, setTrendCatFilter] = useState("all"); // prop type, mirrors the Board's market filter
  const [trendGameFilter, setTrendGameFilter] = useState("all");
  const [trendSideFilter, setTrendSideFilter] = useState("all"); // all | over | under
  const [trendSplit, setTrendSplit] = useState("recentForm"); // which of the 3 splits the minimum hit rate applies to
  const [trendRecentN, setTrendRecentN] = useState(10); // "recent form" sample size
  const [trendMinHit, setTrendMinHit] = useState("");
  const [trendSourceFilter, setTrendSourceFilter] = useState("all"); // all | book | model
  const [trendSort, setTrendSort] = useState({ k: "recentForm", d: -1 });
  const [trendBulkLoading, setTrendBulkLoading] = useState(null); // null | { done, total } while a bulk "load trends" pass is running
  const [analysisQuery, setAnalysisQuery] = useState("");
  const [analysisSearching, setAnalysisSearching] = useState(false);
  const [analysisResults, setAnalysisResults] = useState([]);
  const [analysisProfile, setAnalysisProfile] = useState(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisErr, setAnalysisErr] = useState("");
  const [stakeMode] = useState("flat");      // flat | kelly (default for NEW tracked bets)
  // tracked bets live in the shared per-sport store (core/betStore.ts), so the hub and this page
  // edit the same list; the store saves every change and writes settled results into the board log
  const [myBets, setMyBets] = useBets(sport);
  const [draft, setDraft] = useState(null);
  const [showManual, setShowManual] = useState(false);
  const eventsRef = useRef({ date: null, events: null });
  const inflight = useRef(new Set());

  // The board log lives in IndexedDB and loads async: read it once it is ready.
  useEffect(() => { boardLogReady.then((rows) => setLogRows(rows)); }, []);
  useEffect(() => { if (credits != null) { try { localStorage.setItem(LS_CREDITS, String(credits)); } catch { /* ignore */ } } }, [credits]);
  useEffect(() => { setLiveCredits(credits); }, [credits]);
  async function refreshCredits() { try { const ev = await fetchOddsEvents(); if (ev.remaining != null) setCredits(ev.remaining); } catch { /* ignore */ } }
  useEffect(() => { refreshCredits(); /* free /events call, no quota cost; eslint-disable-next-line */ }, []);

  // Odds pulled for a date are kept (core/live.ts), so Refresh and a page reload reload the schedule and
  // stats without throwing the board away. Changing to another date starts that date's board empty.
  async function loadSchedule(d) {
    setLoading(true); setErr(""); setOpen(null); setDetail({});
    const saved = getBoard(sport.id);
    const keep = !!(saved && saved.date === d && saved.board && Object.keys(saved.board).length);
    if (!keep) setFRaw((p) => (p.game === "all" ? p : { ...p, game: "all" }));
    setBoard(keep ? saved.board : {}); setCoverage(keep ? saved.coverage || {} : {}); setPulledAt(keep ? saved.pulledAt || {} : {});
    eventsRef.current = { date: null, events: null };
    try {
      const gs = await fetchSchedule(d); setGames(gs); setStamp(new Date());
      if (!gs.length) setErr("No games on this date.");
    } catch (e) { setErr(`The schedule could not be loaded (${e.message}).`); setGames([]); }
    finally { setLoading(false); }
  }
  useEffect(() => { loadSchedule(date); /* eslint-disable-next-line */ }, [date]);
  useEffect(() => { setSlate(sport.id, { date, games }); /* eslint-disable-next-line */ }, [games]);
  useEffect(() => { if (Object.keys(board).length) saveBoard(sport.id, { date, book, board, coverage, pulledAt }); /* eslint-disable-next-line */ }, [board, coverage, pulledAt]);
  function clearPulledOdds() { setBoard({}); setCoverage({}); setPulledAt({}); clearBoard(sport.id); }

  async function loadDetail(g) {
    if (detail[g.pk] && detail[g.pk].ready) return detail[g.pk];
    if (inflight.current.has(g.pk)) return null;
    inflight.current.add(g.pk);
    setDetail((p) => ({ ...p, [g.pk]: { loading: true } }));
    const obj = await sport.loadGameDetail(g, { season, date });
    setDetail((p) => ({ ...p, [g.pk]: obj }));
    inflight.current.delete(g.pk);
    return obj;
  }
  async function expand(g) {
    if (open === g.pk) { setOpen(null); return; }
    setOpen(g.pk);
    if (!g.manual) await loadDetail(g);
  }
  /* model game line is read-only (computed from team run env × park) */

  // Trends "load all" button: load games one at a time, not all at once (games.forEach with no
  // await) — the exact lesson from NFL's debugging saga, where firing every game's loadDetail
  // concurrently was suspected (wrongly, as it turned out, but it's still the safer pattern) of
  // tripping a rate limit across hundreds of simultaneous requests. Applied here proactively.
  async function loadTrendsForGames(list) {
    if (trendBulkLoading) return;
    const todo = list.filter((g) => !(detail[g.pk] && detail[g.pk].ready) && !g.manual);
    if (!todo.length) return;
    setTrendBulkLoading({ done: 0, total: todo.length });
    for (let i = 0; i < todo.length; i++) {
      await loadDetail(todo[i]).catch(() => {});
      setTrendBulkLoading({ done: i + 1, total: todo.length });
    }
    setTrendBulkLoading(null);
  }
  // Trends-only: merges the current season's real gamelog with the prior-season fallback (when
  // loadDetail fetched one because the current season's sample was thin) so "last N games" doesn't
  // dead-end at a season boundary early in the year. Pure read of already-fetched state.
  function trendGamelogFor(d, pid) {
    const cur = (d && d.gamelogs && d.gamelogs[pid]) || [];
    const prior = (d && d.priorGamelogs && d.priorGamelogs[pid]) || [];
    if (!cur.length && !prior.length) return null;
    return [...cur, ...prior];
  }


  async function runAnalysisSearch() {
    const q = analysisQuery.trim();
    if (!q) return;
    setAnalysisSearching(true); setAnalysisErr("");
    try {
      const res = await searchPlayers(q, season);
      setAnalysisResults(res);
      if (!res.length) setAnalysisErr(`No ${meta.league} players matched "${q}".`);
    } catch (e) {
      setAnalysisResults([]);
      setAnalysisErr(`Player search failed (${String((e && e.message) || e)}).`);
    } finally { setAnalysisSearching(false); }
  }
  async function selectAnalysisPlayer(player) {
    setAnalysisLoading(true); setAnalysisErr(""); setAnalysisProfile(null);
    try {
      const profile = await fetchPlayerAnalysisProfile(player, season, date);
      setAnalysisProfile(profile);
      const spot = findPlayerInSlate(profile.player.id, games);
      if (spot && !spot.game.manual) await loadDetail(spot.game);
    } catch (e) {
      setAnalysisErr(`Could not load player profile (${String((e && e.message) || e)}).`);
    } finally { setAnalysisLoading(false); }
  }

  function goToAnalysis(player) {
    setAnalysisQuery(player.name || "");
    setAnalysisResults([]);
    setTab("analysis");
    selectAnalysisPlayer(player);
  }

  /* ---- odds fetch for one game -> board entries. Returns an error message, or null when it worked. ---- */
  async function pullOne(g) {
    if (fetchesRef.current >= ODDS_TESTING_LIMIT) return `The limit of ${ODDS_TESTING_LIMIT} odds pulls per session was reached. Reload the page to reset it.`;
    setOddsLoading(g.pk);
    try {
      const d = await loadDetail(g);
      if (!d) return null;
      if (!eventsRef.current.events || eventsRef.current.date !== date) {
        const ev = await fetchOddsEvents(); eventsRef.current = { date, events: ev.events }; if (ev.remaining != null) setCredits(ev.remaining);
      }
      const ev = matchEvent(eventsRef.current.events, g);
      if (!ev) return `No odds event matched ${g.away} at ${g.home}.`;
      // pull the primary book PLUS any per-market override books in one call: the odds API charges per
      // (region, market) however many bookmakers you list, so this costs the same as a single-book fetch.
      const validOverrides = Object.fromEntries(Object.entries(bookOverrides).filter(([t, bk]) => bk && bk !== book && BOOKS.some((b) => b.key === bk) && ALL_PROPS.includes(t)));
      const booksNeeded = [...new Set([book, ...Object.values(validOverrides)])];
      const before = creditsRef.current;
      const res = await fetchEventOdds(ev.id, booksNeeded.join(","));
      if (res.remaining != null) { setCredits(res.remaining); if (before != null && before - res.remaining > 0) setPullCost(before - res.remaining); creditsRef.current = res.remaining; }
      fetchesRef.current += 1;
      const dbg = oddsDebug(res.data, book);
      // rows are parsed per book, then merged type by type: a type with an override sources its rows
      // from that book instead of the primary one, but only when the primary book is missing that market.
      const rowsByBook = {}; for (const bk of booksNeeded) rowsByBook[bk] = parseEventOdds(res.data, bk);
      const rows = [];
      for (const t of ALL_PROPS) {
        const overrideBook = validOverrides[t];
        const primaryHasIt = (rowsByBook[book] || []).some((r) => r.type === t);
        const effectiveBook = overrideBook && !primaryHasIt ? overrideBook : book;
        const bkRows = (rowsByBook[effectiveBook] || []).filter((r) => r.type === t);
        for (const r of bkRows) rows.push({ ...r, srcBook: effectiveBook });
      }
      const hrOverrideBook = validOverrides[meta.diagnosticsType];
      const hrDbg = hrOverrideBook ? oddsDebug(res.data, hrOverrideBook) : null;
      const gl = parseGameOdds(res.data, book, g);          // moneyline / spread / total
      const entries = sport.buildPropEntries(g, d, rows, book, gl);
      const lineEntries = buildGameLineEntries(g, d, gl, book);
      entries.push(...lineEntries);
      const returned = [...new Set(rows.map((r) => r.type)), ...lineEntries.map((e) => e.type)];
      const matched = [...new Set(entries.map((e) => e.type))];
      const hrUsedBook = (rows.find((r) => r.type === meta.diagnosticsType) || {}).srcBook || null;
      const hrFellBack = !!(hrOverrideBook && hrUsedBook === hrOverrideBook);
      setCoverage((c) => ({ ...c, [g.pk]: { game: `${g.away}@${g.home}`, book, returned, matched, rawKeys: dbg.rawKeys, hasHR: dbg.hasHR, hrSample: dbg.hrSample, books: dbg.books, usedBook: dbg.usedBook, hrUsedBook, hrFellBack, hrOverrideAvailable: hrDbg ? hrDbg.hasHR : null, statcast: d.statcastCoverage || (d.statcast && d.statcast.verification) } }));
      setBoard((b) => ({ ...b, [g.pk]: entries }));
      setPulledAt((p) => ({ ...p, [g.pk]: new Date().toISOString() }));
      if (!entries.length) return `Odds came back for ${g.away} at ${g.home} but no players matched. Try closer to lineup lock, or another book.`;
      return null;
    } catch (e) {
      return `The odds pull failed (${e.message}). Check the key, the credits, or the connection.`;
    } finally { setOddsLoading(null); }
  }
  async function getOdds(g) { setErr(""); const problem = await pullOne(g); if (problem) setErr(problem); }
  // every upcoming game that has no odds yet, one at a time
  const unpulled = games.filter((g) => !g.manual && g.status !== "FINAL" && !(board[g.pk] || []).length);
  async function pullAll(list) {
    setErr(""); setPullingAll({ done: 0, total: list.length });
    const problems = [];
    for (let i = 0; i < list.length; i++) {
      const problem = await pullOne(list[i]);
      if (problem) problems.push(problem);
      setPullingAll({ done: i + 1, total: list.length });
      if (fetchesRef.current >= ODDS_TESTING_LIMIT) break;
    }
    setPullingAll(null);
    if (problems.length) setErr(problems.length === 1 ? problems[0] : `${problems.length} of ${list.length} pulls had a problem. First: ${problems[0]}`);
    toast(`Pulled odds for ${list.length - problems.length} of ${list.length} games.`);
  }
  function askPullAll() {
    const n = unpulled.length, left = ODDS_TESTING_LIMIT - fetchesRef.current;
    const each = pullCost || 9;
    confirmDialog({
      title: `Pull odds for ${n} game${n === 1 ? "" : "s"}?`,
      body: `This uses about ${(n * each).toLocaleString()} odds credits (${pullCost ? `the last pull used ${pullCost}` : "around 9 per game"}).${credits != null ? ` You have ${credits.toLocaleString()} left.` : ""}${n > left ? ` Only ${Math.max(0, left)} more pulls fit under this session's limit of ${ODDS_TESTING_LIMIT}.` : ""}`,
      confirm: "Pull odds", onConfirm: () => pullAll(unpulled),
    });
  }

  /* ---- board (flattened, filtered, grouped, sorted) ---- */
  const boardEntries = useMemo(() => Object.values(board).flat(), [board]);
  const analysisSpot = useMemo(() => analysisProfile ? findPlayerInSlate(analysisProfile.player.id, games) : null, [analysisProfile, games]);
  const analysisDetail = analysisSpot ? detail[analysisSpot.game.pk] : null;
  const analysisCtx = useMemo(() => {
    if (!analysisProfile || !analysisSpot || !analysisDetail || !analysisDetail.ready) return null;
    return sport.analysisCtx(analysisDetail, analysisSpot, analysisProfile);
  }, [analysisProfile, analysisSpot, analysisDetail]);
  const analysisProjections = useMemo(() => {
    if (!analysisCtx) return [];
    const props = sport.propsForKind(analysisCtx.kind);
    return props.map((type) => {
      const line = DEFAULT_LINE[type] || "0.5";
      const pr = projectProp(analysisCtx, type, parseFloat(line));
      return { type, line, ...pr, overP: pr.pOver, underP: pr.pOver != null ? 1 - pr.pOver : null, overFair: pr.pOver != null ? probToAmerican(pr.pOver) : "\u2013", underFair: pr.pOver != null ? probToAmerican(1 - pr.pOver) : "\u2013" };
    });
  }, [analysisCtx]);
  const analysisBoardEntries = useMemo(() => {
    if (!analysisProfile) return [];
    const pid = String(analysisProfile.player.id);
    return boardEntries.filter((e) => String(e.playerId) === pid);
  }, [analysisProfile, boardEntries]);
  const analysisBoardGameCount = analysisSpot ? ((board[analysisSpot.game.pk] || []).length) : 0;

  // Board Snapshot Logger: fires whenever the board updates (new game loaded or refreshed).
  // Logs ALL candidates — not just ones above the edge threshold — so we have unbiased
  // data for calibration analysis, CLV measurement, and residual model training.
  useEffect(() => {
    if (boardEntries.length > 0) {
      appendBoardLog(boardEntries, MODEL_VERSION, date).then(() => {
        setLogRows(loadBoardLog());
        const err = getBoardLogSaveError();
        if (err) setBoardLogSettleMsg(err);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardEntries]);

  const boardGames = useMemo(() => {
    const seen = {}; const out = [];
    for (const e of boardEntries) if (!seen[e.gamePk]) { seen[e.gamePk] = 1; out.push({ pk: String(e.gamePk), label: e.game }); }
    return out;
  }, [boardEntries]);
  /* ---- board: filtered, sorted, optionally grouped by market ---- */
  const boardRows = useMemo(() => {
    const minE = parseFloat(f.minEdge), minM = parseFloat(f.minModel), minEv = parseFloat(f.minEV);
    const minB = f.minOdds === "" || isNaN(Number(f.minOdds)) ? null : amToB(Number(f.minOdds));
    const maxB = f.maxOdds === "" || isNaN(Number(f.maxOdds)) ? null : amToB(Number(f.maxOdds));
    const minD = parseFloat(f.minDelta), maxD = parseFloat(f.maxDelta);
    let rows = boardEntries.filter((e) => {
      if (e.modelP == null) return false;
      if (e.modelP >= 0.999 || e.modelP <= 0.001) return false; // already-decided live prop / blowout line: price is stale + unbettable, edge is fake
      if (!isNaN(minE) && !(e.edge != null && e.edge * 100 >= minE)) return false;
      if (!isNaN(minM) && !(e.modelP * 100 >= minM)) return false;
      if (!isNaN(minEv) && !(e.ev != null && e.ev * 100 >= minEv)) return false;
      if (f.evOnly && !(e.ev != null && e.ev > 0)) return false;
      if (f.cat !== "all" && e.type !== f.cat) return false;
      if (f.game !== "all" && String(e.gamePk) !== f.game) return false;
      if (f.side !== "all" && e.side !== f.side) return false;
      if (f.cls === "props" && isLineType(e.type)) return false;
      if (f.cls === "lines" && !isLineType(e.type)) return false;
      if (minB != null || maxB != null) { const b = amToB(Number(e.odds)); if (minB != null && b < minB) return false; if (maxB != null && b > maxB) return false; }
      if (!isNaN(minD) && getDelta(e) < minD) return false;
      if (!isNaN(maxD) && getDelta(e) > maxD) return false;
      if (f.aligned) { const d = getDelta(e); if (e.side === "over" && d <= 0) return false; if (e.side === "under" && d >= 0) return false; }
      if (f.signal !== "all") { const sig = getDeltaSignal(e.type, e.proj, e.line); if (f.signal === "strong" && sig !== "strong") return false; if (f.signal === "moderate" && sig == null) return false; }
      if (!matchesQuery(e, f.q)) return false;
      return true;
    });
    // best side: of the two sides of one market, keep the one with the higher expected return
    if (f.best) { const top = new Map(); for (const e of rows) { const k = `${e.gamePk}|${e.playerId}|${e.type}|${e.line}`; const c = top.get(k); if (!c || (e.ev ?? -9) > (c.ev ?? -9)) top.set(k, e); } rows = [...top.values()]; }
    const key = boardSort.k, val = (e) => (key === "delta" ? getDelta(e) : key === "odds" ? amToB(Number(e.odds)) : e[key]);
    return rows.sort((a, b) => { const x = val(a), y = val(b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (typeof x === "string" ? x.localeCompare(String(y)) : x - y) * boardSort.d; });
  }, [boardEntries, boardSort, f]);
  const boardGroups = useMemo(() => (boardView === "grouped" ? STAT_ORDER.map((t) => [t, boardRows.filter((e) => e.type === t)]).filter((g) => g[1].length) : [[null, boardRows]]), [boardRows, boardView]);
  const activeKeys = Object.keys(EMPTY_F).filter((k) => f[k] !== EMPTY_F[k]);
  const chipKeys = activeKeys.filter((k) => CHIP[k]);
  const allPresets = [...BUILT_IN_PRESETS, ...presets];
  const samePreset = (p) => Object.keys(EMPTY_F).every((k) => k === "q" || k === "game" || f[k] === ({ ...EMPTY_F, ...p.f })[k]);
  const currentPreset = allPresets.find(samePreset) || null;
  function savePreset() {
    const name = presetName.trim(); if (!name) return;
    const { q: _q, game: _game, ...rest } = f;
    const next = [...presets, { id: `u${Date.now()}`, name, f: Object.fromEntries(Object.entries(rest).filter(([k, v]) => v !== EMPTY_F[k])) }];
    setPresets(next); writeLS(LS_PRESETS, next); setPresetName(""); toast("Preset saved. It works on every sport.");
  }
  function removePreset(id) { const next = presets.filter((p) => p.id !== id); setPresets(next); writeLS(LS_PRESETS, next); }
  function clearFilters() { setF({ ...EMPTY_F }); }

  /* ---- Trends (recent form / head-to-head / home-away hit rates): a pure client-side view over
     detail[g.pk].gamelogs. The adapter's trendSubjects() says which players and props get cards. ---- */
  const trendDebug = useMemo(() => {
    let players = 0, withCurGames = 0, withAnyGames = 0, propAttempts = 0, cardsBuilt = 0;
    for (const g of games) {
      const d = detail[g.pk];
      if (!d || !d.ready) continue;
      const bEntriesForGame = boardEntries.filter((e) => String(e.gamePk) === String(g.pk));
      for (const t of sport.trendSubjects(g, d)) {
        players++;
        const cur = (d.gamelogs && d.gamelogs[t.pid]) || [];
        if (cur.length) withCurGames++;
        const merged = trendGamelogFor(d, t.pid);
        if (merged && merged.length) withAnyGames++;
        for (const type of t.props) {
          propAttempts++;
          if (buildTrendCard(t.player, t.pid, type, merged, g, t.isHome, bEntriesForGame, trendRecentN)) cardsBuilt++;
        }
      }
    }
    return { players, withCurGames, withAnyGames, propAttempts, cardsBuilt };
  }, [games, detail, boardEntries, trendRecentN]);
  const trendCards = useMemo(() => {
    const out = [];
    for (const g of games) {
      const d = detail[g.pk];
      if (!d || !d.ready) continue;
      const bEntriesForGame = boardEntries.filter((e) => String(e.gamePk) === String(g.pk));
      for (const t of sport.trendSubjects(g, d)) {
        const merged = trendGamelogFor(d, t.pid);
        for (const type of t.props) {
          const card = buildTrendCard(t.player, t.pid, type, merged, g, t.isHome, bEntriesForGame, trendRecentN);
          if (card) out.push(card);
        }
      }
    }
    return out;
  }, [games, detail, boardEntries, trendRecentN]);
  const trendGames = useMemo(() => {
    const seen = {}; const out = [];
    for (const c of trendCards) if (!seen[c.gamePk]) { seen[c.gamePk] = 1; out.push({ pk: String(c.gamePk), label: c.game }); }
    return out;
  }, [trendCards]);
  const entryById = useMemo(() => new Map(boardEntries.map((e) => [e.id, e])), [boardEntries]);
  const filteredTrends = useMemo(() => {
    const minHit = parseFloat(trendMinHit);
    const rows = trendCards.filter((c) => {
      if (trendCatFilter !== "all" && c.type !== trendCatFilter) return false;
      if (trendGameFilter !== "all" && String(c.gamePk) !== trendGameFilter) return false;
      if (trendSideFilter !== "all" && c.side !== trendSideFilter) return false;
      if (trendSourceFilter !== "all" && c.sourced !== trendSourceFilter) return false;
      if (trendSearch && !`${c.name} ${c.game}`.toLowerCase().includes(trendSearch.toLowerCase())) return false;
      if (!isNaN(minHit)) { const s = c[trendSplit]; if (!(s && s.pct != null && s.pct * 100 >= minHit)) return false; }
      return true;
    });
    const k = trendSort.k, entry = (c) => (c.boardEntryId ? entryById.get(c.boardEntryId) : null);
    const val = (c) => (k === "recentForm" || k === "vsOpp" || k === "homeAway" ? (c[k] && c[k].pct != null ? c[k].pct : null) : k === "modelP" || k === "ev" ? (entry(c) ? entry(c)[k] : null) : k === "odds" ? (c.odds != null ? amToB(Number(c.odds)) : null) : c[k]);
    return rows.sort((a, b) => { const x = val(a), y = val(b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (typeof x === "string" ? x.localeCompare(String(y)) : x - y) * trendSort.d; });
  }, [trendCards, trendCatFilter, trendGameFilter, trendSideFilter, trendSourceFilter, trendSearch, trendMinHit, trendSplit, trendSort, entryById]);
  const trendFiltersActive = trendCatFilter !== "all" || trendGameFilter !== "all" || trendSideFilter !== "all" || trendSourceFilter !== "all" || trendSearch !== "" || trendMinHit !== "";
  function clearTrendFilters() { setTrendCatFilter("all"); setTrendGameFilter("all"); setTrendSideFilter("all"); setTrendSourceFilter("all"); setTrendSearch(""); setTrendMinHit(""); }

  /* ---- tracking ---- */
  const trackedKeys = useMemo(() => new Set(myBets.map((b) => b.key)), [myBets]);
  function recordFor(e) {
    const sug = suggestedUnits(e.modelP, Number(e.odds));
    const units = stakeMode === "kelly" ? (sug > 0 ? sug : 1) : 1;
    const gtrk = games.find((x) => x.pk === e.gamePk);
    const liveBet = !!((e.calc && e.calc.live) || (gtrk && gtrk.status === "LIVE")); // was the game in progress when placed?
    return betFromEntry(e, date, units, sug, liveBet);
  }
  function trackBet(e) {
    if (myBets.some((b) => b.key === e.id)) return;
    const rec = recordFor(e);
    setMyBets((p) => (p.some((b) => b.key === rec.key) ? p : [rec, ...p]));
  }
  // Untrack from the Board, with an undo. A bet that has already settled is left for My bets to manage.
  function untrackBet(e) {
    const i = myBets.findIndex((b) => b.key === e.id);
    if (i < 0) return;
    const bet = myBets[i];
    if (bet.status !== "open") { toast("That bet has already settled. Remove it from My bets if you need to."); return; }
    setMyBets((p) => p.filter((b) => b.key !== bet.key));
    toast(`Removed ${isLineType(bet.type) ? bet.game : bet.name} from My bets.`, () => setMyBets((p) => (p.some((b) => b.key === bet.key) ? p : [...p.slice(0, i), bet, ...p.slice(i)])));
  }
  // Tracks every play currently passing the Board's filters in one batch (deduped against the stored list).
  function trackAllFiltered() {
    const all = boardRows;
    if (!all.length) { toast("No plays match the current filters."); return; }
    let added = 0;
    setMyBets((prev) => {
      const seen = new Set(prev.map((b) => b.key));
      const additions = [];
      for (const e of all) { if (seen.has(e.id)) continue; seen.add(e.id); additions.push(recordFor(e)); }
      added = additions.length;
      return additions.length ? [...additions, ...prev] : prev;
    });
    toast(added ? `Tracked ${added} new bet${added === 1 ? "" : "s"} from the current filters.` : "Every play in view is already tracked.");
  }
  const untrackedCount = boardRows.reduce((n, e) => n + (trackedKeys.has(e.id) ? 0 : 1), 0);
  // stable handlers, so the memoised Board rows only re-render when their own data changes
  const fns = useRef({});
  fns.current = { trackBet, untrackBet, goToAnalysis };
  const onTrack = useCallback((e) => fns.current.trackBet(e), []);
  const onUntrack = useCallback((e) => fns.current.untrackBet(e), []);
  const onPlayer = useCallback((e) => fns.current.goToAnalysis({ id: e.playerId, name: e.name }), []);
  function addManualBet() {
    if (!draft || draft.odds === "") return;
    const key = `m-${Date.now()}`;
    let modelP = null, proj = null;
    if (draft.ctx) { const pr = projectProp(draft.ctx, draft.type, parseFloat(draft.line)); modelP = draft.side === "over" ? pr.pOver : 1 - pr.pOver; proj = pr.proj; }
    const sug = suggestedUnits(modelP, Number(draft.odds));
    const units = stakeMode === "kelly" ? (sug > 0 ? sug : 1) : 1;
    const rec = { key, date, gamePk: draft.pk, game: draft.game, playerId: draft.playerId, name: draft.name, type: draft.type, line: draft.line, side: draft.side, odds: Number(draft.odds), book: "manual", modelP, proj, novig: null, units, suggested: sug, status: "open", actual: null };
    setMyBets((p) => [rec, ...p]); setDraft(null);
  }

  /* ---- board log (the Model tab): settle, download, clear. The work itself is in core/boardlog.ts ---- */
  async function settleFullBoardLog() {
    setBoardLogSettling(true); setBoardLogSettleMsg("");
    try {
      const r = await gradeBoardLog(sport, setBoardLogSettleMsg);
      setLogRows(loadBoardLog()); setBoardLogSettleMsg(r.message);
    } catch (e) { setBoardLogSettleMsg(`Settling failed: ${String((e && e.message) || e)}`); }
    finally { setBoardLogSettling(false); }
  }
  function exportBoardLogCSV() { if (!downloadBoardLogCsv(sport)) toast("The board log is empty. Pull odds for a game to start logging."); }
  function clearLog() {
    confirmDialog({
      title: `Clear the ${meta.title} board log?`, danger: true, confirm: "Clear log",
      body: `${logRows.length.toLocaleString()} logged plays will be deleted. This cannot be undone, so download the CSV first if you want a copy. Tracked bets are not affected.`,
      onConfirm: () => { wipeBoardLog(sport); setLogRows([]); setBoardLogSettleMsg(""); toast("Board log cleared."); },
    });
  }

  /* draft from a board entry's player (manual line/odds) */
  function draftFromGame(g, kind, pid, name) {
    const ctx = sport.draftCtx(detail[g.pk], g, kind, pid);
    const dd = sport.draftDefaults(kind);
    setDraft({ pk: g.pk, game: `${g.away}@${g.home}`, playerId: pid, name, kind, type: dd.type, line: dd.line, side: "over", odds: "", ctxKind: kind, ctx });
  }

  /* manual game add (failsafe) */
  const [mg, setMg] = useState({ away: "", home: "", time: "" });
  function addManualGame() {
    if (!mg.away || !mg.home) return;
    setGames((p) => [...p, { pk: "m" + Date.now(), manual: true, status: "MANUAL", home: mg.home.toUpperCase(), away: mg.away.toUpperCase(), homeName: "", awayName: "", time: mg.time || "TBD", venue: "Manual", homeSP: null, awaySP: null, homeLineup: [], awayLineup: [], homeId: null, awayId: null }]);
    setMg({ away: "", home: "", time: "" });
  }

  const trackedByGame = useMemo(() => { const m = {}; for (const b of myBets) if (b.status === "open") m[b.gamePk] = (m[b.gamePk] || 0) + 1; return m; }, [myBets]);

  /* ============================ UI ============================ */
  const overrideCount = Object.keys(bookOverrides).length;
  const liveCount = games.filter((g) => g.status === "LIVE").length;
  const pulledCount = games.filter((g) => (board[g.pk] || []).length).length;
  const moreCount = chipKeys.length;
  const gamesReady = games.filter((g) => detail[g.pk] && detail[g.pk].ready).length;
  const trendMore = (trendMinHit !== "" ? 1 : 0) + (trendSourceFilter !== "all" ? 1 : 0);
  let budget = shown;
  return (
    <>
      <header className="top">
        <MenuBtn />
        <h1>{meta.title}</h1>
        <div className="tabs" role="tablist">
          {TABS.map(([k, l]) => (
            <button type="button" role="tab" aria-selected={tab === k} key={k} className={cx("tab", tab === k && "on")} onClick={() => setTab(k)}>
              {l}{k === "board" && boardEntries.length ? <small className="num">{boardEntries.length.toLocaleString()}</small> : null}{k === "trends" && trendCards.length ? <small className="num">{trendCards.length.toLocaleString()}</small> : null}
            </button>
          ))}
        </div>
        <span className="grow" />
        <div className="row" style={{ gap: 2 }}>
          <Btn sm icon kind="ghost" aria-label="Previous day" title="Previous day" onClick={() => shiftDate(-1)}><ChevronLeft /></Btn>
          <input type="date" className="field datefield num" aria-label="Slate date" value={date} onChange={(e) => { if (e.target.value) setDate(e.target.value); }} />
          <Btn sm icon kind="ghost" aria-label="Next day" title="Next day" onClick={() => shiftDate(1)}><ChevronRight /></Btn>
          {date !== todayStr() ? <Btn sm onClick={() => setDate(todayStr())}>Today</Btn> : null}
        </div>
        <span className="hide-s"><Select label="Sportsbook" value={book} onChange={setBook} options={BOOKS.map((b) => [b.key, b.label])} /></span>
        <span className="hide-s">
          <Pop right width={380} button={(o, t) => <Btn icon on={o || overrideCount > 0} onClick={t} aria-label="More options" title={meta.overrideTitle}><MoreHorizontal /></Btn>}>
            {(close) => (<>
              <div className="h2">Per-market books{overrideCount ? ` (${overrideCount})` : ""}</div>
              <p className="note">Sources one market's odds from another book, but only when {BOOK_LABELS[book]} does not carry that market for the game. It costs no extra credits: both books come back in one pull.</p>
              <div style={{ maxHeight: 300, overflow: "auto", display: "grid", gap: 6 }}>
                {ALL_PROPS.map((t) => (
                  <label key={t} className="frow" style={{ gridTemplateColumns: "1fr 170px" }}><span>{t}</span>
                    <select className="field sm" value={bookOverrides[t] || ""} onChange={(e) => setBookOverride(t, e.target.value)}>
                      <option value="">Same as {BOOK_LABELS[book]}</option>
                      {BOOKS.filter((b) => b.key !== book).map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
                    </select>
                  </label>
                ))}
              </div>
              <div style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}>
                <Btn sm kind="danger" disabled={!boardEntries.length} onClick={() => { close(); confirmDialog({ title: "Clear the pulled odds?", body: `The ${meta.title} board for this date is emptied. Pulling the odds again uses credits. Tracked bets and the board log are kept.`, confirm: "Clear odds", danger: true, onConfirm: clearPulledOdds }); }}><Trash2 />Clear pulled odds</Btn>
              </div>
            </>)}
          </Pop>
        </span>
        <Btn kind="primary" disabled={loading} onClick={() => loadSchedule(date)} title="Reload the schedule and stats. Odds already pulled for this date are kept."><RefreshCw /><span className="hide-s">{loading ? "Loading" : "Refresh"}</span></Btn>
      </header>

      {err ? <Banner onClose={() => setErr("")}>{err}</Banner> : null}

      {/* ---------------- SLATE ---------------- */}
      {tab === "slate" && (
        <div className="screen">
          <div className="bar">
            <span className="mid">{loading && !games.length ? "Loading the schedule" : `${games.length} game${games.length === 1 ? "" : "s"}${liveCount ? `, ${liveCount} live` : ""}. Odds pulled for ${pulledCount}.`}</span>
            <span className="grow" />
            <span className="note num hide-s">Odds credits <b className={credits != null && credits < 1000 ? "warn" : ""} style={{ fontWeight: 620, color: credits != null && credits < 1000 ? undefined : "var(--ink)" }}>{credits != null ? credits.toLocaleString() : "–"}</b>{stamp ? `, schedule loaded ${stamp.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</span>
            <Btn disabled={!unpulled.length || !!pullingAll || oddsLoading != null} onClick={askPullAll}><Download />{pullingAll ? `Pulling ${pullingAll.done} of ${pullingAll.total}` : unpulled.length ? `Pull all upcoming (${unpulled.length})` : "All games pulled"}</Btn>
          </div>
          <div className="scroll">
            {games.map((g) => {
              const d = detail[g.pk], isOpen = open === g.pk, hasOdds = (board[g.pk] || []).length;
              const scored = (g.status === "LIVE" || g.status === "FINAL") && g.homeScore != null;
              const fin = g.status === "FINAL", busy = oddsLoading === g.pk;
              return (
                <div key={g.pk} className={cx("game", isOpen && "open")}>
                  <div className="game-row" onClick={() => expand(g)}>
                    <div className="num" style={{ fontWeight: 600 }}>
                      {g.status === "LIVE" ? <span className="row" style={{ gap: 6, color: "var(--live)" }}><span className="livedot" />{scored ? sport.game.liveLabel(g) : "Live"}</span> : fin ? <span className="mid">Final{sport.game.finalSuffix(g) || ""}</span> : g.time}
                    </div>
                    <div className="matchup">
                      <Team sport={sport.id} ab={g.away} lg />{scored ? <span className={cx("num", fin && g.awayScore < g.homeScore && "mid")}>{g.awayScore}</span> : null}
                      <span className="at">at</span>
                      <Team sport={sport.id} ab={g.home} lg />{scored ? <span className={cx("num", fin && g.homeScore < g.awayScore && "mid")}>{g.homeScore}</span> : null}
                    </div>
                    <div className="hide-s"><Chip s={g.status} /></div>
                    <div className="hide-s mid trunc">{g.manual ? "Added by hand" : sport.game.subtitle(g)}</div>
                    <div className="row" onClick={(e) => e.stopPropagation()}>
                      {trackedByGame[g.pk] ? <span className="hide-s"><Badge kind="accent" title={`${trackedByGame[g.pk]} open tracked bet${trackedByGame[g.pk] === 1 ? "" : "s"} on this game`}>{trackedByGame[g.pk]} tracked</Badge></span> : null}
                      {g.manual || fin ? null : hasOdds
                        ? <Btn sm kind="ghost" disabled={busy || !!pullingAll} title={`${hasOdds} priced plays. Pull this game's odds again.`} onClick={() => getOdds(g)}><RefreshCw />{busy ? "Pulling" : pulledAt[g.pk] ? clock(pulledAt[g.pk]) : "Pulled"}</Btn>
                        : <Btn sm kind="primary" disabled={busy || !!pullingAll} onClick={() => getOdds(g)}>{busy ? "Pulling" : "Pull odds"}</Btn>}
                    </div>
                    <Expander open={isOpen} label={isOpen ? "Hide lineups" : "Show lineups"} onClick={(e) => { e.stopPropagation(); expand(g); }} />
                  </div>
                  {isOpen ? (
                    <div className="game-detail">
                      {d && d.loading ? <div className="note" style={{ padding: "12px 0" }}>Loading stats.</div> : null}
                      {g.manual ? <div className="note" style={{ padding: "12px 0" }}>A game added by hand has no model context. Track its bets by hand from My bets.</div> : null}
                      {d && d.ready ? (<>
                        <GameDetail g={g} view={sport.slateView(g, d)} sportId={sport.id} onDraft={(dr) => draftFromGame(g, dr.kind, dr.id, dr.name)} onAnalysis={goToAnalysis} />
                        {hasOdds ? <div className="note">{hasOdds} priced plays from this game are on the Board. <button type="button" className="link" onClick={() => { setF({ game: String(g.pk) }); setTab("board"); }}>Open them</button></div>
                          : !fin ? <div className="note">Pull odds to price this game's props on the Board ({BOOK_LABELS[book] || book}).</div> : null}
                      </>) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {!games.length && !loading ? <Empty title="No games on this date">Pick another date, or add a game by hand below.</Empty> : null}
            <div style={{ padding: "14px 20px" }}>
              <Btn sm kind="ghost" onClick={() => setShowManual((s) => !s)}><Plus />{showManual ? "Hide" : "Add a game by hand"}</Btn>
              {showManual ? (
                <div className="row wrap" style={{ marginTop: 10 }}>
                  {[["away", "Away"], ["home", "Home"], ["time", "Time"]].map(([k, ph]) => <TextIn key={k} num={false} width={96} placeholder={ph} aria-label={ph} value={mg[k]} onChange={(v) => setMg((p) => ({ ...p, [k]: v }))} />)}
                  <Btn sm kind="primary" disabled={!mg.away || !mg.home} onClick={addManualGame}>Add game</Btn>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* ---------------- BOARD ---------------- */}
      {tab === "board" && (boardEntries.length === 0 ? (
        <div className="scroll"><Empty title="No odds pulled yet" action={<Btn kind="primary" onClick={() => setTab("slate")}>Go to the slate</Btn>}>The board fills in as you pull odds for each game. Every pull is also saved to the board log for the Model tab.</Empty></div>
      ) : (
        <div className="screen">
          <div className="bar">
            <SearchField value={f.q} onChange={(q) => setF({ q })} placeholder="Search player or team" />
            <Select label="Market" value={f.cat} onChange={(cat) => setF({ cat })} options={[["all", "All markets"], ...CATEGORY_ORDER.map((c) => [c, c])]} />
            <Select label="Game" value={f.game} onChange={(game) => setF({ game })} options={[["all", "All games"], ...boardGames.map((x) => [x.pk, x.label.replace("@", " at ")])]} />
            <span className="hide-s"><Seg label="Side" value={f.side} onChange={(side) => setF({ side })} options={[["all", "Both"], ["over", "Over"], ["under", "Under"]]} /></span>
            <Pop width={320} button={(o, t) => <Btn on={o || moreCount > 0} onClick={t}><ListFilter />Filters{moreCount ? ` (${moreCount})` : ""}</Btn>}>
              <Field label="Minimum EV %"><TextIn value={f.minEV} onChange={(minEV) => setF({ minEV })} /></Field>
              <Field label="Minimum edge %"><TextIn value={f.minEdge} onChange={(minEdge) => setF({ minEdge })} /></Field>
              <Field label="Minimum model %"><TextIn value={f.minModel} onChange={(minModel) => setF({ minModel })} placeholder="65" /></Field>
              <Field label="Projection gap, at least" title="Projection minus the line"><TextIn value={f.minDelta} onChange={(minDelta) => setF({ minDelta })} placeholder="0.5" /></Field>
              <Field label="Projection gap, at most" title="Projection minus the line"><TextIn value={f.maxDelta} onChange={(maxDelta) => setF({ maxDelta })} placeholder="2.0" /></Field>
              <Field label="Odds no shorter than"><TextIn value={f.minOdds} onChange={(minOdds) => setF({ minOdds })} placeholder="-300" /></Field>
              <Field label="Odds no longer than"><TextIn value={f.maxOdds} onChange={(maxOdds) => setF({ maxOdds })} placeholder="+300" /></Field>
              <Field label="Projection signal"><Select sm label="Projection signal" value={f.signal} onChange={(signal) => setF({ signal })} options={[["all", "Any"], ["moderate", "Moderate +"], ["strong", "Strong"]]} /></Field>
              <Field label="Type"><Select sm label="Type" value={f.cls} onChange={(cls) => setF({ cls })} options={[["all", "All"], ["props", "Props"], ["lines", "Lines"]]} /></Field>
              <Switch on={f.aligned} onChange={(aligned) => setF({ aligned })} title="Only plays where the projection sits on the bet's side of the line">Projection agrees with the side</Switch>
            </Pop>
            <span className="grow" />
            {Object.keys(coverage).length > 0 ? <Btn icon on={showCoverage} onClick={toggleShowCoverage} aria-label="Odds feed diagnostics" title="Odds feed diagnostics for each pulled game"><Bug /></Btn> : null}
            <Pop right width={300} button={(o, t) => <Btn on={o} onClick={t}><BookmarkPlus /><span className="trunc" style={{ maxWidth: 170 }}>{currentPreset ? currentPreset.name : "Presets"}</span><ChevronDown /></Btn>}>
              {(close) => (<>
                <div style={{ display: "grid", gap: 2 }}>
                  {allPresets.map((p) => (
                    <div className="row" key={p.id} style={{ gap: 2 }}>
                      <button type="button" className="menu-item" onClick={() => { setF({ ...EMPTY_F, ...p.f, q: f.q, game: f.game }); close(); }}>{currentPreset && currentPreset.id === p.id ? <Check size={14} /> : <span style={{ width: 14 }} />}<span className="trunc">{p.name}</span></button>
                      {String(p.id).startsWith("u") ? <Btn sm icon kind="ghost" aria-label={`Delete preset ${p.name}`} title="Delete preset" onClick={() => removePreset(p.id)}><X /></Btn> : null}
                    </div>
                  ))}
                </div>
                <div style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }} className="row">
                  <TextIn num={false} className="field sm grow" placeholder="Name the current filters" value={presetName} onChange={setPresetName} />
                  <Btn sm kind="primary" disabled={!presetName.trim()} onClick={() => { savePreset(); close(); }}>Save</Btn>
                </div>
              </>)}
            </Pop>
            <Btn kind="primary" disabled={!untrackedCount} title="Track every play in the current view" onClick={() => (untrackedCount > 25 ? confirmDialog({ title: `Track ${untrackedCount} plays?`, body: "Every play in the current view that you are not already tracking is added to My bets at 1 unit.", confirm: "Track all", onConfirm: trackAllFiltered }) : trackAllFiltered())}>Track all ({untrackedCount})</Btn>
          </div>
          <div className="bar tight">
            <Switch on={f.evOnly} onChange={(evOnly) => setF({ evOnly })}>+EV only</Switch>
            <Switch on={f.best} onChange={(best) => setF({ best })} title="Of the two sides of a market, show the one with the higher expected return">Best side only</Switch>
            {chipKeys.length ? <span className="sep" /> : null}
            {chipKeys.map((k) => <span className="chip" key={k}>{CHIP[k](f[k])}<button type="button" aria-label="Remove filter" onClick={() => setF({ [k]: EMPTY_F[k] })}><X /></button></span>)}
            {activeKeys.length ? <Btn sm kind="ghost" onClick={clearFilters}>Clear all</Btn> : null}
            <span className="grow" />
            <span className="note num">{boardRows.length === boardEntries.length ? `${boardRows.length.toLocaleString()} plays` : `${boardRows.length.toLocaleString()} of ${boardEntries.length.toLocaleString()} plays`}</span>
            <Seg label="Layout" value={boardView} onChange={setBoardView} options={[["flat", "Flat"], ["grouped", "By market"]]} />
          </div>
          <div className="scroll">
            {showCoverage && Object.keys(coverage).length > 0 ? (
              <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--line)" }}>
                <Panel title="Odds feed diagnostics" sub="What each pull returned. Mostly useful when a market is missing." actions={<Btn sm kind="ghost" onClick={toggleShowCoverage}>Hide</Btn>}>
                  <div className="grid" style={{ gap: 12 }}>
                    {Object.values(coverage).map((c, i) => (
                      <div key={i} className="note num" style={{ display: "grid", gap: 2 }}>
                        <div><b style={{ color: "var(--ink)" }}>{c.game.replace("@", " at ")}</b>, {BOOK_LABELS[c.usedBook || c.book] || c.usedBook || c.book}: <span className="mid">{c.matched.length ? c.matched.join(", ") : "no players matched"}</span></div>
                        <div>Raw markets returned: {c.rawKeys && c.rawKeys.length ? c.rawKeys.join(", ") : "none"}</div>
                        <div>{c.hasHR
                          ? <span className="pos">{meta.diagnosticsMarketKey} is present{c.hrSample ? `. Sample: name "${c.hrSample.name}", description "${c.hrSample.description}", point ${c.hrSample.point}` : ""}</span>
                          : <span className="warn">{meta.diagnosticsMarketKey} was not returned by {BOOK_LABELS[c.usedBook || c.book] || c.usedBook || c.book} (the book or feed did not carry it for this game)</span>}</div>
                        {c.hrFellBack ? <div className="accent-t">{meta.diagnosticsType} odds fell back to {BOOK_LABELS[c.hrUsedBook] || c.hrUsedBook} for this game (the primary book did not carry it)</div> : null}
                        {!c.hasHR && !c.hrFellBack && c.hrOverrideAvailable === false ? <div className="warn">The fallback book did not carry {meta.diagnosticsType} odds for this game either</div> : null}
                        {c.statcast ? <div className={c.statcast.verdict === "statcast_confirmed" ? "pos" : ""}>Statcast: {c.statcast.verdict}, exit-velocity balls {c.statcast.battedBallsWithExitVelo || 0}, xBA balls {c.statcast.battedBallsWithXBA || 0}</div> : null}
                        {c.statcast && c.statcast.sources ? <div>Source: {c.statcast.sources}</div> : null}
                        {c.books && c.books.length > 1 ? <div>Books in the response: {c.books.join(", ")}</div> : null}
                      </div>
                    ))}
                  </div>
                </Panel>
              </div>
            ) : null}
            {!boardRows.length ? <Empty title="Nothing matches these filters" action={<Btn onClick={clearFilters}>Clear filters</Btn>}>{boardEntries.length.toLocaleString()} plays are on the board for {boardGames.length} game{boardGames.length === 1 ? "" : "s"}.</Empty> : (
              <table className="tbl">
                <BoardHead sort={boardSort} onSort={setBoardSort} />
                <tbody>
                  {boardGroups.map(([t, list]) => {
                    if (budget <= 0) return null;
                    const slice = list.slice(0, budget); budget -= slice.length;
                    return (
                      <React.Fragment key={t || "all"}>
                        {t ? <tr className="group"><td colSpan={12}>{t}<span className="dim num" style={{ fontWeight: 480 }}> &nbsp;{list.length} play{list.length === 1 ? "" : "s"}, best EV {fSigned(Math.max(...list.map((e) => e.ev ?? -9)))}</span></td></tr> : null}
                        {slice.map((e) => <BoardRow key={e.id} e={e} sportId={sport.id} cfg={rowCfg} bookLabel={BOOK_LABELS[e.book] || e.book} tracked={trackedKeys.has(e.id)} onTrack={onTrack} onUntrack={onUntrack} onPlayer={onPlayer} />)}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
            {boardRows.length > shown ? <div className="more"><Btn onClick={() => setShown((n) => n + 100)}>Show 100 more ({(boardRows.length - shown).toLocaleString()} left)</Btn></div> : null}
          </div>
        </div>
      ))}

      {/* ---------------- TRENDS ---------------- */}
      {tab === "trends" && (
        <div className="screen">
          <div className="bar">
            <SearchField value={trendSearch} onChange={setTrendSearch} placeholder="Search player or team" />
            <Select label="Market" value={trendCatFilter} onChange={setTrendCatFilter} options={[["all", "All markets"], ...TREND_PROPS.map((t) => [t, t])]} />
            <Select label="Game" value={trendGameFilter} onChange={setTrendGameFilter} options={[["all", "All games"], ...trendGames.map((g) => [g.pk, g.label.replace("@", " at ")])]} />
            <span className="hide-s"><Seg label="Side" value={trendSideFilter} onChange={setTrendSideFilter} options={[["all", "Both"], ["over", "Over"], ["under", "Under"]]} /></span>
            <span className="label hide-s">Sample</span>
            <span className="hide-s"><Seg label="Sample size" value={trendRecentN} onChange={setTrendRecentN} options={[5, 8, 10, 15, 20].map((n) => [n, `Last ${n}`])} /></span>
            <Pop width={320} button={(o, t) => <Btn on={o || trendMore > 0} onClick={t}><ListFilter />Filters{trendMore ? ` (${trendMore})` : ""}</Btn>}>
              <Field label="Minimum hit rate %"><TextIn value={trendMinHit} onChange={setTrendMinHit} /></Field>
              <label className="frow" style={{ gridTemplateColumns: "1fr 150px" }}><span>Measured on</span><Select sm label="Hit rate measured on" value={trendSplit} onChange={setTrendSplit} options={[["recentForm", "Recent form"], ["vsOpp", "Vs opponent"], ["homeAway", "Home or away"]]} /></label>
              <label className="frow" style={{ gridTemplateColumns: "1fr 150px" }}><span>Line source</span><Select sm label="Line source" value={trendSourceFilter} onChange={setTrendSourceFilter} options={[["all", "Any"], ["book", "Book line"], ["model", "No book line"]]} /></label>
            </Pop>
            {trendFiltersActive ? <Btn sm kind="ghost" onClick={clearTrendFilters}>Clear</Btn> : null}
            <span className="grow" />
            {games.length > 0 ? <span className="note num">{trendBulkLoading ? `Loading ${trendBulkLoading.done} of ${trendBulkLoading.total}` : `${gamesReady} of ${games.length} games loaded`}, {filteredTrends.length.toLocaleString()} trends</span> : null}
            {games.some((g) => !g.manual && !(detail[g.pk] && detail[g.pk].ready)) ? <Btn sm disabled={!!trendBulkLoading} onClick={() => loadTrendsForGames(games)}>Load the rest</Btn> : null}
          </div>
          <div className="scroll">
            {games.length === 0 ? <Empty title="No slate loaded">Trends are built from the games on the Slate.</Empty>
              : trendCards.length === 0 ? (
                trendDebug.players === 0 ? (
                  <Empty title="No game data loaded yet" action={<Btn kind="primary" disabled={!!trendBulkLoading} onClick={() => loadTrendsForGames(games)}>{trendBulkLoading ? `Loading ${trendBulkLoading.done} of ${trendBulkLoading.total}` : "Load trends for all games"}</Btn>}>
                    Trends read the same lineups and game logs the Slate and Board use ({meta.statsSource}). Loading them is free and uses no odds credits.
                  </Empty>
                ) : (
                  <Empty title="Games are loaded, but no trends came out">
                    <div className="num">Game log this season: {trendDebug.withCurGames} of {trendDebug.players} players. With last season as a fallback: {trendDebug.withAnyGames} of {trendDebug.players}. Prop checks run: {trendDebug.propAttempts}. Trends built: {trendDebug.cardsBuilt}.</div>
                    <div style={{ marginTop: 8 }}>{trendDebug.withAnyGames === 0
                      ? "Every player's game log came back empty. Press Refresh, then load trends again. If it is still zero after that, check the browser console for warnings."
                      : "Game logs are loading, but no player cleared a line in any split. Try a wider sample, or this slate's players may have too short a history."}</div>
                  </Empty>
                )
              ) : filteredTrends.length === 0 ? <Empty title="No trends match these filters" action={<Btn onClick={clearTrendFilters}>Clear filters</Btn>} />
              : (
                <table className="tbl dense">
                  <thead><tr>
                    <Th k="name" sort={trendSort} onSort={setTrendSort}>Player</Th><Th k="game" sort={trendSort} onSort={setTrendSort} className="hide-s">Game</Th><Th k="type" sort={trendSort} onSort={setTrendSort} className="hide-s">Pick</Th>
                    <Th k="odds" sort={trendSort} onSort={setTrendSort} r className="hide-s hide-m">Odds</Th><Th k="recentForm" sort={trendSort} onSort={setTrendSort} r>Last {trendRecentN}</Th>
                    <Th k="vsOpp" sort={trendSort} onSort={setTrendSort} r className="hide-s" title="His record against this opponent">Vs opponent</Th><Th k="homeAway" sort={trendSort} onSort={setTrendSort} r className="hide-s" title="His record in the same home or away spot as this game">Home or away</Th>
                    <Th k="modelP" sort={trendSort} onSort={setTrendSort} r className="hide-s hide-m">Model</Th><Th k="ev" sort={trendSort} onSort={setTrendSort} r>EV</Th><th style={{ width: 52 }} />
                  </tr></thead>
                  <tbody>{filteredTrends.slice(0, 400).map((c) => { const entry = c.boardEntryId ? entryById.get(c.boardEntryId) : null; return <TrendRow key={c.id} c={c} entry={entry} sportId={sport.id} cfg={rowCfg} tracked={entry ? trackedKeys.has(entry.id) : false} onTrack={onTrack} onUntrack={onUntrack} onPlayer={onPlayer} />; })}</tbody>
                </table>
              )}
            {filteredTrends.length > 400 ? <div className="note" style={{ padding: 14, textAlign: "center" }}>Showing the first 400 of {filteredTrends.length.toLocaleString()}. Narrow the filters to see the rest.</div> : null}
          </div>
        </div>
      )}

      {/* ---------------- PLAYERS ---------------- */}
      {tab === "analysis" && (
        <div className="screen">
          <div className="bar">
            <SearchField value={analysisQuery} onChange={setAnalysisQuery} onEnter={runAnalysisSearch} placeholder={`Search any ${meta.league} player, for example ${meta.searchPlaceholder}`} width={340} />
            <Btn kind="primary" disabled={analysisSearching || !analysisQuery.trim()} onClick={runAnalysisSearch}>{analysisSearching ? "Searching" : "Search"}</Btn>
            {(analysisProfile || analysisResults.length > 0 || analysisQuery) ? <Btn kind="ghost" onClick={() => { setAnalysisQuery(""); setAnalysisResults([]); setAnalysisProfile(null); setAnalysisErr(""); }}>Clear</Btn> : null}
            <span className="grow" />
            <span className="note hide-s">A player on the selected slate also gets matchup context, projections and his board markets.</span>
          </div>
          <div className="scroll"><div className="page" style={{ display: "grid", gap: 16 }}>
            {analysisErr ? <Banner onClose={() => setAnalysisErr("")}>{analysisErr}</Banner> : null}
            {analysisResults.length > 0 ? (
              <Panel title="Search results" sub={`${analysisResults.length} player${analysisResults.length === 1 ? "" : "s"}`}>
                <div className="grid g3" style={{ gap: 8 }}>
                  {analysisResults.map((p) => { const selected = analysisProfile && String(analysisProfile.player.id) === String(p.id); return (
                    <button type="button" key={p.id} className={cx("ticket pickable", selected && "on")} onClick={() => selectAnalysisPlayer(p)}><span className="name">{p.name}</span><span className="note num">{String(meta.searchResultLine(p)).replace(/ · /g, ", ").replace(/—/g, "–")}</span></button>
                  ); })}
                </div>
              </Panel>
            ) : null}
            {!analysisProfile && !analysisLoading && analysisResults.length === 0 ? <PlayerAnalysisIntro games={games} boardCount={boardEntries.length} intro={meta.intro} /> : null}
            {analysisLoading ? <div className="note" style={{ padding: "40px 0", textAlign: "center" }}>Loading the player.</div> : null}
            {analysisProfile && !analysisLoading ? (
              <PlayerAnalysis
                view={sport.playerView({ profile: analysisProfile, spot: analysisSpot, detail: analysisDetail, projections: analysisProjections })}
                rowCfg={rowCfg} sportId={sport.id}
                profile={analysisProfile} spot={analysisSpot} detail={analysisDetail}
                projections={analysisProjections} boardEntries={analysisBoardEntries} boardGameCount={analysisBoardGameCount}
                bookLabel={BOOK_LABELS[book] || book} oddsLoading={oddsLoading}
                oddsReady={!!(analysisSpot && (board[analysisSpot.game.pk] || []).length > 0 && coverage[analysisSpot.game.pk]?.book === book)}
                onFetchOdds={() => { if (analysisSpot) getOdds(analysisSpot.game); }}
                trackedKeys={trackedKeys} onTrack={onTrack} onUntrack={onUntrack}
              />
            ) : null}
          </div></div>
        </div>
      )}

      {/* ---------------- MODEL (board log) ---------------- */}
      {tab === "log" && <ModelPage sport={sport} rows={logRows} settling={boardLogSettling} message={boardLogSettleMsg} onSettle={settleFullBoardLog} onDownload={exportBoardLogCSV} onClear={clearLog} />}

      {/* manual bet tray */}
      {draft ? (
        <div className="tray">
          <div><div className="name">{draft.name}</div><div className="note">{String(meta.draftKindLabel(draft.ctxKind) || "").toLowerCase()}, manual bet, {draft.game.replace("@", " at ")}</div></div>
          <label className="stack"><span className="label">Market</span><Select label="Market" value={draft.type} onChange={(v) => setDraft((p) => ({ ...p, type: v, line: DEFAULT_LINE[v] || "0.5" }))} options={sport.propsForKind(draft.ctxKind)} /></label>
          <label className="stack"><span className="label">Line</span><TextIn className="field num" width={84} value={draft.line} onChange={(v) => setDraft((p) => ({ ...p, line: v }))} placeholder="0.5" /></label>
          <label className="stack"><span className="label">Side</span><Seg label="Side" value={draft.side} onChange={(v) => setDraft((p) => ({ ...p, side: v }))} options={[["over", "Over"], ["under", "Under"]]} /></label>
          <label className="stack"><span className="label">Odds</span><TextIn className="field num" width={84} value={draft.odds} onChange={(v) => setDraft((p) => ({ ...p, odds: v }))} placeholder="-115" /></label>
          <span className="grow" />
          <Btn kind="ghost" onClick={() => setDraft(null)}>Cancel</Btn>
          <Btn kind="primary" disabled={draft.odds === ""} onClick={() => { addManualBet(); toast("Bet tracked. It is in My bets."); }}>Track bet</Btn>
        </div>
      ) : null}
    </>
  );
}
