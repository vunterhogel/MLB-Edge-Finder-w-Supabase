import { useEffect, useMemo, useRef, useState } from "react";
import { evPerUnit, impliedProb, pct, probToAmerican, profitUnits, suggestedUnits } from "./math";
import { MultiSel, NumIn, Sel, StatCard, mono } from "./ui";

/* SportApp: the shared Edge Finder shell (Slate / Board / Trends / Player Analysis / My Bets / Stats).
   Built from the MLB page, which is the design standard. Everything sport-specific comes from the
   `sport` adapter (see sports/mlb/adapter.tsx); this file holds no sport logic of its own. */

/* ============================================================ */
export default function SportApp({ sport }) {
  const { ALL_PROPS, BOOKS, BOOK_LABELS, CATEGORY_ORDER, DEFAULT_LINE, ODDS_TESTING_LIMIT, isLineType, matchesQuery, STAT_ORDER, TREND_PROPS } = sport.config;
  const { BOARD_DB_KEY, LS_BOARD_LOG, LS_CREDITS, MODEL_VERSION, appendBoardLog, boardLogReady, getBoardLogSaveError, idbDel, loadBets, loadBoardLog, loadBookOverrides, loadCredits, loadShowCoverage, resetBoardLogCache, saveBets, saveBoardLog, saveBookOverrides, saveShowCoverage, settleBoardLog } = sport.storage;
  const { fetchSchedule, fetchOddsEvents, fetchEventOdds, matchEvent, oddsDebug, parseEventOdds, parseGameOdds, matchCurrentOdds, buildGameLineEntries, fetchGameResult, searchPlayers, fetchPlayerAnalysisProfile, findPlayerInSlate, buildTrendCard, getDeltaSignal } = sport.api;
  const { projectProp } = sport.model;
  const { Chip, ScoreLine, GameSubtitle, SlateDetail, BoardRow, MyBetRow, TrendCard, PlayerAnalysisIntro, PlayerProfilePanel } = sport.ui;
  const meta = sport.meta;
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const [date, setDate] = useState(todayStr());
  // ◂/▸ day-step + "today" shortcut (ported from the NBA Edge Finder's date nav) — shifts by
  // calendar day using Date's own rollover so month/year boundaries are handled for free.
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
  const [tab, setTab] = useState("slate");
  const [open, setOpen] = useState(null);
  const [detail, setDetail] = useState({});
  const [book, setBook] = useState("draftkings");
  const [bookOverrides, setBookOverrides] = useState(() => loadBookOverrides());
  const [showBookPanel, setShowBookPanel] = useState(false);
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
  const [oddsLoading, setOddsLoading] = useState(null);
  const [credits, setCredits] = useState(loadCredits());
  const [oddsFetches, setOddsFetches] = useState(0);
  const [boardLogCount, setBoardLogCount] = useState(() => loadBoardLog().length);
  const [boardLogSettling, setBoardLogSettling] = useState(false);
  const [boardLogSettleMsg, setBoardLogSettleMsg] = useState("");
  const [boardSort, setBoardSort] = useState("ev_desc");
  const [minEdge, setMinEdge] = useState("");
  const [minModel, setMinModel] = useState("");
  const [minEV, setMinEV] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const [boardSearch, setBoardSearch] = useState("");
  const [showMoreBoard, setShowMoreBoard] = useState(false);
  const [showProjBar, setShowProjBar] = useState(true);
  const [gameFilter, setGameFilter] = useState("all");
  const [sideFilter, setSideFilter] = useState("all");
  const [minOdds, setMinOdds] = useState("");
  const [maxOdds, setMaxOdds] = useState("");
  const [minDelta, setMinDelta] = useState("");
  const [maxDelta, setMaxDelta] = useState("");
  const [dirAligned, setDirAligned] = useState(false); // only show plays where proj direction matches bet side
  const [signalFilter, setSignalFilter] = useState("all"); // all | moderate | strong — delta gate signal tier
  const [trackAllMsg, setTrackAllMsg] = useState(""); // feedback line under the Board's "track all filtered" button
  const [coverage, setCoverage] = useState({});   // pk -> { game, book, returned[], matched[] }
  const [classFilter, setClassFilter] = useState("all");   // all | props | lines
  const [trendSearch, setTrendSearch] = useState("");
  const [trendCatFilter, setTrendCatFilter] = useState("all"); // prop type, mirrors Board's catFilter
  const [trendGameFilter, setTrendGameFilter] = useState("all");
  const [trendSideFilter, setTrendSideFilter] = useState("all"); // all | over | under
  const [trendSplit, setTrendSplit] = useState("recentForm"); // which of the 3 splits drives min-hit/sort
  const [trendRecentN, setTrendRecentN] = useState(10); // "recent form" sample size
  const [trendMinHit, setTrendMinHit] = useState("");
  const [trendSourceFilter, setTrendSourceFilter] = useState("all"); // all | book | model
  const [trendSort, setTrendSort] = useState("hit_desc");
  const [showMoreTrends, setShowMoreTrends] = useState(false);
  const [trendBulkLoading, setTrendBulkLoading] = useState(null); // null | { done, total } while a bulk "load trends" pass is running
  const [analysisQuery, setAnalysisQuery] = useState("");
  const [analysisSearching, setAnalysisSearching] = useState(false);
  const [analysisResults, setAnalysisResults] = useState([]);
  const [analysisProfile, setAnalysisProfile] = useState(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisErr, setAnalysisErr] = useState("");
  const [betStatusFilter, setBetStatusFilter] = useState("all"); // all|open|won|lost
  const [betSort, setBetSort] = useState("recent");        // recent|ev_desc|ev_asc|edge_desc|edge_asc
  const [betDateFilter, setBetDateFilter] = useState("all"); // all | a specific YYYY-MM-DD
  const [betGameFilters, setBetGameFilters] = useState<string[]>([]);   // [] = all; multi-select games
  const [betTypeFilters, setBetTypeFilters] = useState<string[]>([]);   // [] = all; multi-select categories
  const [betBookFilters, setBetBookFilters] = useState<string[]>([]);   // [] = all; multi-select sportsbooks
  const [betSideFilter, setBetSideFilter] = useState("all");  // all | over | under | home | away
  const [betSearch, setBetSearch] = useState("");
  const [showMoreBets, setShowMoreBets] = useState(false);
  const [betMinModel, setBetMinModel] = useState("");        // min model % on My Bets
  const [betMinEdge, setBetMinEdge] = useState("");          // min edge % on My Bets
  const [betMaxEdge, setBetMaxEdge] = useState("");          // max edge % on My Bets
  const [betMinOdds, setBetMinOdds] = useState("");
  const [betMaxOdds, setBetMaxOdds] = useState("");
  const [betMinDelta, setBetMinDelta] = useState("");        // min proj delta (proj - line)
  const [betMaxDelta, setBetMaxDelta] = useState("");        // max proj delta
  const [betDirAligned, setBetDirAligned] = useState(false);// only show bets where proj direction matched side
  const [stakeMode, setStakeMode] = useState("flat");      // flat | kelly (default for NEW tracked bets)
  const [statsStartDate, setStatsStartDate] = useState("");  // YYYY-MM-DD, inclusive
  const [statsEndDate, setStatsEndDate] = useState("");      // YYYY-MM-DD, inclusive
  const [myBets, setMyBets] = useState(loadBets());
  const [draft, setDraft] = useState(null);
  const [showManual, setShowManual] = useState(false);
  const [settleMsg, setSettleMsg] = useState("");
  const [lineMsg, setLineMsg] = useState("");
  const [refreshingLines, setRefreshingLines] = useState(false);
  const eventsRef = useRef({ date: null, events: null });
  const inflight = useRef(new Set());

  useEffect(() => { saveBets(myBets); }, [myBets]);
  // When myBets changes and any bets have settled, write results back into the board log
  // so ALL board candidates (not just tracked bets) get graded via settleBoardLog.
  useEffect(() => { void settleBoardLog(myBets); }, [myBets]);
  // Clear game multi-select when date changes — previously selected games may belong to a different date.
  useEffect(() => { setBetGameFilters([]); }, [betDateFilter]);
  // Board log persists in IndexedDB and loads async — sync the count once ready.
  useEffect(() => { boardLogReady.then((rows) => setBoardLogCount(rows.length)); }, []);
  useEffect(() => { if (credits != null) { try { localStorage.setItem(LS_CREDITS, String(credits)); } catch { /* ignore */ } } }, [credits]);
  async function refreshCredits() { try { const ev = await fetchOddsEvents(); if (ev.remaining != null) setCredits(ev.remaining); } catch { /* ignore */ } }
  useEffect(() => { refreshCredits(); /* free /events call, no quota cost; eslint-disable-next-line */ }, []);

  async function loadSchedule(d) {
    setLoading(true); setErr(""); setOpen(null); setDetail({}); setBoard({}); setCoverage({});
    eventsRef.current = { date: null, events: null };
    try {
      const gs = await fetchSchedule(d); setGames(gs); setStamp(new Date());
      if (!gs.length) setErr("No games on this date.");
    } catch (e) { setErr(`Schedule fetch blocked (${e.message}).`); setGames([]); }
    finally { setLoading(false); }
  }
  useEffect(() => { loadSchedule(date); /* eslint-disable-next-line */ }, [date]);

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

  /* ---- odds fetch for one game -> board entries ---- */
  async function getOdds(g) {
    if (oddsFetches >= ODDS_TESTING_LIMIT) { setErr(`Per-session fetch cap (${ODDS_TESTING_LIMIT}) reached — reload to reset, or raise ODDS_TESTING_LIMIT.`); return; }
    setOddsLoading(g.pk); setErr("");
    try {
      const d = await loadDetail(g);
      if (!d) { setOddsLoading(null); return; }
      if (!eventsRef.current.events || eventsRef.current.date !== date) {
        const ev = await fetchOddsEvents(); eventsRef.current = { date, events: ev.events }; if (ev.remaining != null) setCredits(ev.remaining);
      }
      const ev = matchEvent(eventsRef.current.events, g);
      if (!ev) { setErr(`No odds event matched ${g.away}@${g.home}.`); setOddsLoading(null); return; }
      // pull the primary book PLUS any per-market override books in one call — the-odds-api
      // charges per (region, market) regardless of how many bookmakers you list, so this
      // costs the same as a single-book fetch (see refreshLines' comment on the same trick).
      const validOverrides = Object.fromEntries(Object.entries(bookOverrides).filter(([t, bk]) => bk && bk !== book && BOOKS.some((b) => b.key === bk) && ALL_PROPS.includes(t)));
      const booksNeeded = [...new Set([book, ...Object.values(validOverrides)])];
      const res = await fetchEventOdds(ev.id, booksNeeded.join(",")); if (res.remaining != null) setCredits(res.remaining);
      setOddsFetches((n) => n + 1);
      const dbg = oddsDebug(res.data, book);
      // rows are parsed per-book, then merged type-by-type: a type with an override sources
      // its rows from that book instead of the primary one (falls back to primary if the
      // override book didn't return that market for this event either).
      const rowsByBook = {}; for (const bk of booksNeeded) rowsByBook[bk] = parseEventOdds(res.data, bk);
      const rows = [];
      for (const t of ALL_PROPS) {
        const overrideBook = validOverrides[t];
        const primaryHasIt = (rowsByBook[book] || []).some((r) => r.type === t);
        // prefer the override book whenever the primary book is missing this market;
        // otherwise stick with the primary book so the rest of the board stays on it.
        const effectiveBook = overrideBook && !primaryHasIt ? overrideBook : book;
        const bkRows = (rowsByBook[effectiveBook] || []).filter((r) => r.type === t);
        for (const r of bkRows) rows.push({ ...r, srcBook: effectiveBook });
      }
      const hrOverrideBook = validOverrides[meta.diagnosticsType];
      const hrDbg = hrOverrideBook ? oddsDebug(res.data, hrOverrideBook) : null;
      const entries = sport.buildPropEntries(g, d, rows, book);
      const gl = parseGameOdds(res.data, book, g);          // moneyline / run line / total
      const lineEntries = buildGameLineEntries(g, d, gl, book);
      entries.push(...lineEntries);
      const returned = [...new Set(rows.map((r) => r.type)), ...lineEntries.map((e) => e.type)];
      const matched = [...new Set(entries.map((e) => e.type))];
      const hrUsedBook = (rows.find((r) => r.type === meta.diagnosticsType) || {}).srcBook || null;
      const hrFellBack = !!(hrOverrideBook && hrUsedBook === hrOverrideBook);
      setCoverage((c) => ({ ...c, [g.pk]: { game: `${g.away}@${g.home}`, book, returned, matched, rawKeys: dbg.rawKeys, hasHR: dbg.hasHR, hrSample: dbg.hrSample, books: dbg.books, usedBook: dbg.usedBook, hrUsedBook, hrFellBack, hrOverrideAvailable: hrDbg ? hrDbg.hasHR : null, statcast: d.statcastCoverage || (d.statcast && d.statcast.verification) } }));
      setBoard((b) => ({ ...b, [g.pk]: entries }));
      if (!entries.length) setErr(`Got odds for ${g.away}@${g.home} but matched no players (try closer to lineup lock, or another book).`);
    } catch (e) {
      setErr(`Odds fetch failed (${e.message}). Check the key/credits or CORS.`);
    } finally { setOddsLoading(null); }
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
      return { type, line, ...pr, overP: pr.pOver, underP: 1 - pr.pOver, overFair: probToAmerican(pr.pOver), underFair: probToAmerican(1 - pr.pOver) };
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
        setBoardLogCount(loadBoardLog().length);
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
  const amToB = (o) => (o > 0 ? o / 100 : 100 / -o);
  const grouped = useMemo(() => {
    const minE = parseFloat(minEdge);
    const minM = parseFloat(minModel);
    const minEv = parseFloat(minEV);
    const minB = minOdds === "" || isNaN(Number(minOdds)) ? null : amToB(Number(minOdds));
    const maxB = maxOdds === "" || isNaN(Number(maxOdds)) ? null : amToB(Number(maxOdds));
    const minD = parseFloat(minDelta);
    const maxD = parseFloat(maxDelta);
    const getDelta = (e) => (e.proj ?? 0) - parseFloat(e.line ?? 0);
    const f = boardEntries.filter((e) => {
      if (e.modelP == null) return false;
      if (e.modelP >= 0.999 || e.modelP <= 0.001) return false; // already-decided live prop / blowout line: price is stale + unbettable, edge is fake
      if (!isNaN(minE) && !(e.edge != null && e.edge * 100 >= minE)) return false;
      if (!isNaN(minM) && !(e.modelP * 100 >= minM)) return false;
      if (!isNaN(minEv) && !(e.ev != null && e.ev * 100 >= minEv)) return false;
      if (catFilter !== "all" && e.type !== catFilter) return false;
      if (gameFilter !== "all" && String(e.gamePk) !== gameFilter) return false;
      if (sideFilter !== "all" && e.side !== sideFilter) return false;
      if (classFilter === "props" && isLineType(e.type)) return false;
      if (classFilter === "lines" && !isLineType(e.type)) return false;
      if (minB != null || maxB != null) { const b = amToB(Number(e.odds)); if (minB != null && b < minB) return false; if (maxB != null && b > maxB) return false; }
      if (!isNaN(minD) && getDelta(e) < minD) return false;
      if (!isNaN(maxD) && getDelta(e) > maxD) return false;
      if (dirAligned) { const d = getDelta(e); if (e.side === "over" && d <= 0) return false; if (e.side === "under" && d >= 0) return false; }
      if (signalFilter !== "all") { const sig = getDeltaSignal(e.type, e.proj, e.line); if (signalFilter === "strong" && sig !== "strong") return false; if (signalFilter === "moderate" && sig == null) return false; }
      if (!matchesQuery(e, boardSearch)) return false;
      return true;
    });
    const cmp = {
      ev_desc: (a, b) => (b.ev ?? -9) - (a.ev ?? -9), ev_asc: (a, b) => (a.ev ?? 9) - (b.ev ?? 9),
      edge_desc: (a, b) => (b.edge ?? -9) - (a.edge ?? -9), edge_asc: (a, b) => (a.edge ?? 9) - (b.edge ?? 9),
      proj_desc: (a, b) => (b.proj ?? -9) - (a.proj ?? -9), proj_asc: (a, b) => (a.proj ?? 9e9) - (b.proj ?? 9e9),
      delta_desc: (a, b) => getDelta(b) - getDelta(a), delta_asc: (a, b) => getDelta(a) - getDelta(b),
    }[boardSort];
    const out = {};
    for (const t of STAT_ORDER) { const arr = f.filter((e) => e.type === t).sort(cmp); if (arr.length) out[t] = arr; }
    return out;
  }, [boardEntries, boardSort, minEdge, minModel, minEV, catFilter, classFilter, gameFilter, sideFilter, minOdds, maxOdds, minDelta, maxDelta, dirAligned, signalFilter, boardSearch]);
  const filtersActive = classFilter !== "all" || catFilter !== "all" || gameFilter !== "all" || sideFilter !== "all" || minEdge !== "" || minModel !== "" || minEV !== "" || minOdds !== "" || maxOdds !== "" || minDelta !== "" || maxDelta !== "" || dirAligned || signalFilter !== "all" || boardSearch !== "";
  function clearFilters() { setClassFilter("all"); setCatFilter("all"); setGameFilter("all"); setSideFilter("all"); setMinEdge(""); setMinModel(""); setMinEV(""); setMinOdds(""); setMaxOdds(""); setMinDelta(""); setMaxDelta(""); setDirAligned(false); setSignalFilter("all"); setBoardSearch(""); }

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
  const filteredTrends = useMemo(() => {
    const minHit = parseFloat(trendMinHit);
    const f = trendCards.filter((c) => {
      if (trendCatFilter !== "all" && c.type !== trendCatFilter) return false;
      if (trendGameFilter !== "all" && String(c.gamePk) !== trendGameFilter) return false;
      if (trendSideFilter !== "all" && c.side !== trendSideFilter) return false;
      if (trendSourceFilter !== "all" && c.sourced !== trendSourceFilter) return false;
      if (trendSearch && !`${c.name} ${c.game}`.toLowerCase().includes(trendSearch.toLowerCase())) return false;
      if (!isNaN(minHit)) { const s = c[trendSplit]; if (!(s && s.pct != null && s.pct * 100 >= minHit)) return false; }
      return true;
    });
    f.sort((a, b) => {
      if (trendSort === "name_asc") return a.name.localeCompare(b.name);
      const pa = (a[trendSplit] && a[trendSplit].pct != null) ? a[trendSplit].pct : -1;
      const pb = (b[trendSplit] && b[trendSplit].pct != null) ? b[trendSplit].pct : -1;
      return trendSort === "hit_asc" ? pa - pb : pb - pa;
    });
    return f;
  }, [trendCards, trendCatFilter, trendGameFilter, trendSideFilter, trendSourceFilter, trendSearch, trendMinHit, trendSplit, trendSort]);
  const trendFiltersActive = trendCatFilter !== "all" || trendGameFilter !== "all" || trendSideFilter !== "all" || trendSourceFilter !== "all" || trendSearch !== "" || trendMinHit !== "";
  function clearTrendFilters() { setTrendCatFilter("all"); setTrendGameFilter("all"); setTrendSideFilter("all"); setTrendSourceFilter("all"); setTrendSearch(""); setTrendMinHit(""); }

  /* ---- my bets ---- */
  function trackBet(e) {
    const exists = myBets.some((b) => b.key === e.id);
    if (exists) return;
    const sug = suggestedUnits(e.modelP, Number(e.odds));
    const units = stakeMode === "kelly" ? (sug > 0 ? sug : 1) : 1;
    const gtrk = games.find((x) => x.pk === e.gamePk);
    const liveBet = !!((e.calc && e.calc.live) || (gtrk && gtrk.status === "LIVE")); // was the game in progress when placed?
    const rec = { key: e.id, date, gamePk: e.gamePk, game: e.game, playerId: e.playerId, name: e.name, type: e.type, line: e.line, side: e.side, odds: e.odds, book: e.book, modelP: e.modelP, proj: e.proj, novig: e.novig, units, suggested: sug, status: "open", actual: null, live: liveBet };
    setMyBets((p) => [rec, ...p]);
  }
  // Bulk-tracks every play currently passing the Board's filters — one click instead of tapping
  // "track" on each row one at a time. Mirrors trackBet()'s own record shape exactly, but batches
  // into a single setMyBets call (and dedupes against `prev`, not a stale outer `myBets`) so N
  // additions don't turn into N separate re-renders or risk a stale-closure duplicate.
  function trackAllFiltered() {
    const all = Object.values(grouped).flat();
    if (!all.length) { setTrackAllMsg("No plays match the current filters."); return; }
    setMyBets((prev) => {
      const seen = new Set(prev.map((b) => b.key));
      const additions = [];
      for (const e of all) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        const sug = suggestedUnits(e.modelP, Number(e.odds));
        const units = stakeMode === "kelly" ? (sug > 0 ? sug : 1) : 1;
        const gtrk = games.find((x) => x.pk === e.gamePk);
        const liveBet = !!((e.calc && e.calc.live) || (gtrk && gtrk.status === "LIVE"));
        additions.push({ key: e.id, date, gamePk: e.gamePk, game: e.game, playerId: e.playerId, name: e.name, type: e.type, line: e.line, side: e.side, odds: e.odds, book: e.book, modelP: e.modelP, proj: e.proj, novig: e.novig, units, suggested: sug, status: "open", actual: null, live: liveBet });
      }
      setTrackAllMsg(additions.length ? `Tracked ${additions.length} new bet(s) from the current filters.` : "All filtered plays are already tracked.");
      return additions.length ? [...additions, ...prev] : prev;
    });
  }
  function updateBetOdds(key, odds) { setMyBets((p) => p.map((b) => b.key === key ? { ...b, odds: odds === "" ? "" : Number(odds) } : b)); }
  function updateBetUnits(key, units) { setMyBets((p) => p.map((b) => b.key === key ? { ...b, units: units === "" ? "" : Math.max(0, Number(units)) } : b)); }
  function removeBet(key) { setMyBets((p) => p.filter((b) => b.key !== key)); }
  function resetStats() {
    if (typeof window !== "undefined" && !window.confirm("Clear ALL tracked bets (open + settled)? This cannot be undone. Export a CSV first if you want a copy.")) return;
    setMyBets([]); setSettleMsg("");
  }
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

  async function settleBets() {
    const openByGame = {};
    for (const b of myBets) if (b.status === "open") (openByGame[b.gamePk] = openByGame[b.gamePk] || []).push(b);
    const pks = Object.keys(openByGame);
    if (!pks.length) { setSettleMsg("No open bets to settle."); return; }
    setSettleMsg("Settling…");
    const results = {};
    for (const pk of pks) { results[pk] = await fetchGameResult(pk); }
    let graded = 0;
    setMyBets((prev) => prev.map((b) => {
      if (b.status !== "open") return b;
      const res = results[b.gamePk];
      if (res && res.canceled) { graded++; return { ...b, status: "void", actual: "CANCELED" }; }   // postponed / canceled game: no action
      if (!res || !res.final) return b;
      if (isLineType(b.type)) {
        const { status, actual } = sport.gradeLineResult(b.type, b.side, parseFloat(b.line), res);
        if (!status) return b; graded++; return { ...b, status, actual };
      }
      const r = sport.gradeTrackedProp(b, res);
      if (r == null) return b;
      graded++; return { ...b, status: r.status, actual: r.actual };
    }));
    setSettleMsg(`Settled ${graded} bet(s). Unsettled games are still in progress.`);
  }

  // ── Full Board Log Settlement ──────────────────────────────────────────────
  // Grades EVERY board log candidate for every finished game — not just tracked bets.
  // Uses the sport's free stats API (no Odds API credits consumed).
  // This is what transforms the board log from "model output archive" into a genuine
  // calibration dataset: every prop the model evaluated gets an actual outcome attached.
  async function settleFullBoardLog() {
    await boardLogReady;
    const log = loadBoardLog();
    const unsettled = log.filter((e) => !e.settled);
    if (!unsettled.length) { setBoardLogSettleMsg("Board log is fully settled — nothing to do."); return; }

    // Unique gamePks across unsettled entries
    const pks = [...new Set(unsettled.map((e) => e.gamePk))];
    setBoardLogSettling(true);
    setBoardLogSettleMsg(`Fetching results for ${pks.length} game(s)…`);

    try {
      // Fetch game results from the sport's free stats API
      const results = {};
      for (const pk of pks) {
        results[pk] = await fetchGameResult(Number(pk));
      }

      let graded = 0;
      const updated = log.map((e) => {
        if (e.settled) return e;
        const res = results[e.gamePk];
        if (res && res.canceled) { graded++; return { ...e, settled: true, actualStat: null, result: "void" }; }
        if (!res || !res.final) return e; // game still in progress — leave unsettled

        // Game line props (moneyline / total / spread)
        if (isLineType(e.type)) {
          const { status, actual } = sport.gradeLineResult(e.type, e.side, parseFloat(e.line || "0"), res);
          if (!status) return e;
          graded++;
          return { ...e, settled: true, actualStat: actual, result: status };
        }

        // Player props: DNP -> void; otherwise graded off the box score
        const r = sport.gradeLogProp(e, res);
        if (r == null) return e;
        graded++;
        return { ...e, settled: true, actualStat: r.actual, result: r.status };
      });

      saveBoardLog(updated);
      const totalSettled = updated.filter((e) => e.settled).length;
      setBoardLogCount(updated.length);
      setBoardLogSettleMsg(
        `Graded ${graded} board log entr${graded === 1 ? "y" : "ies"} across ${pks.length} game(s). ` +
        `${totalSettled.toLocaleString()} / ${updated.length.toLocaleString()} total entries now settled.`
      );
    } catch (err) {
      setBoardLogSettleMsg(`Settlement failed: ${String((err && (err as Error).message) || err)}`);
    } finally {
      setBoardLogSettling(false);
    }
  }

  // pull the current market price for each open tracked bet (line movement / CLV). ~9 credits per game with open bets.
  async function refreshLines() {
    const open = myBets.filter((b) => b.status === "open" && b.book && b.book !== "manual");
    if (!open.length) { setLineMsg("No open tracked bets with a book to refresh (manual bets have no book to pull)."); return; }
    const byGame = {};
    for (const b of open) { (byGame[b.gamePk] = byGame[b.gamePk] || []).push(b); }
    setRefreshingLines(true); setLineMsg("Refreshing lines…");
    try {
      let events = eventsRef.current && eventsRef.current.events;
      if (!events) { const ev = await fetchOddsEvents(); events = ev.events || []; eventsRef.current = { date, events }; if (ev.remaining != null) setCredits(ev.remaining); }
      const updates = {}; let matched = 0, missed = 0, games_ = 0, frozen = 0;
      const at = new Date().toISOString();
      for (const pkStr in byGame) {
        const bets = byGame[pkStr];
        const g = games.find((x) => String(x.pk) === pkStr);
        const ev = g ? matchEvent(events, g) : null;
        if (!ev) { for (const b of bets) { updates[b.key] = { oddsCheckedAt: at, currentOdds: null, lineMissing: true }; missed++; } continue; }
        // has first pitch passed? prefer the book's commence_time; fall back to slate status
        const started = ev.commence_time ? (Date.parse(ev.commence_time) <= Date.now()) : (g && (g.status === "LIVE" || g.status === "FINAL"));
        // pregame bets freeze at the closing line once the game starts (live re-prices aren't comparable). live bets keep updating.
        for (const b of bets) { if (!b.live && started && b.currentOdds != null && !b.closing) { updates[b.key] = { closing: true, oddsCheckedAt: at }; frozen++; } }
        const toPull = bets.filter((b) => b.live || !started);
        if (!toPull.length) continue; // nothing to fetch for this game (all pregame bets are frozen) -> saves credits
        // ONE fetch per game covering every book we track on it. Up to 10 books = 1 region cost, so this halves credits vs per-book calls.
        const books = [...new Set(toPull.map((b) => b.book))];
        const res = await fetchEventOdds(ev.id, books.join(",")); games_++;
        if (res.remaining != null) setCredits(res.remaining);
        const parsed = {};
        for (const bk of books) parsed[bk] = { rows: parseEventOdds(res.data, bk), gl: parseGameOdds(res.data, bk, g) };
        for (const b of toPull) {
          const p = parsed[b.book];
          const cur = p ? matchCurrentOdds(b, p.rows, p.gl) : null;
          if (cur != null) { updates[b.key] = { currentOdds: cur, oddsCheckedAt: at, lineMissing: false, closing: false }; matched++; }
          else { updates[b.key] = { oddsCheckedAt: at, currentOdds: null, lineMissing: true }; missed++; }
        }
      }
      setMyBets((prev) => prev.map((b) => updates[b.key] ? { ...b, ...updates[b.key] } : b));
      setLineMsg(`Updated ${matched} line(s) across ${games_} game(s)${frozen ? ` · ${frozen} frozen at close (game started)` : ""}${missed ? ` · ${missed} not found (scratched, settled, or line moved off your number)` : ""}.`);
    } catch (e) { setLineMsg(`Line refresh failed: ${String((e && e.message) || e)}`); }
    setRefreshingLines(false);
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

  /* live recompute of My Bets EV (odds editable) */
  const myBetsView = useMemo(() => {
    let arr = myBets.map((b, i) => {
      const odds = Number(b.odds);
      const modelP = b.modelP, imp = isNaN(odds) ? null : impliedProb(odds);
      const fairRef = b.novig != null ? b.novig : imp;
      const edge = (modelP != null && fairRef != null) ? modelP - fairRef : null;
      const ev = (modelP != null && !isNaN(odds)) ? evPerUnit(modelP, odds) : null;
      const units = b.units != null ? b.units : 1;        // back-compat for older bets
      const suggested = b.suggested != null ? b.suggested : suggestedUnits(modelP, odds);
      // CLV: positive = market moved toward your side since you bet (your side's price shortened) = you beat the line
      const clv = (b.currentOdds != null && !isNaN(odds)) ? impliedProb(b.currentOdds) - impliedProb(odds) : null;
      return { ...b, imp, edge, ev, units, suggested, clv, _i: i };
    });
    if (betStatusFilter === "settled") arr = arr.filter((b) => b.status !== "open");
    else if (betStatusFilter !== "all") arr = arr.filter((b) => b.status === betStatusFilter);
    if (betDateFilter !== "all") arr = arr.filter((b) => b.date === betDateFilter);
    if (betGameFilters.length) arr = arr.filter((b) => betGameFilters.includes(b.game));
    if (betTypeFilters.length) arr = arr.filter((b) => betTypeFilters.includes(b.type));
    if (betBookFilters.length) arr = arr.filter((b) => betBookFilters.includes(b.book));
    if (betSideFilter !== "all") arr = arr.filter((b) => b.side === betSideFilter);
    if (betSearch.trim()) arr = arr.filter((b) => matchesQuery(b, betSearch));
    const bmM = parseFloat(betMinModel);
    if (!isNaN(bmM)) arr = arr.filter((b) => b.modelP != null && b.modelP * 100 >= bmM);
    const bmE = parseFloat(betMinEdge);
    if (!isNaN(bmE)) arr = arr.filter((b) => b.edge != null && b.edge * 100 >= bmE);
    const bxE = parseFloat(betMaxEdge);
    if (!isNaN(bxE)) arr = arr.filter((b) => b.edge != null && b.edge * 100 <= bxE);
    const minOB = betMinOdds === "" || isNaN(Number(betMinOdds)) ? null : amToB(Number(betMinOdds));
    const maxOB = betMaxOdds === "" || isNaN(Number(betMaxOdds)) ? null : amToB(Number(betMaxOdds));
    if (minOB != null || maxOB != null) arr = arr.filter((b) => { const bb = amToB(Number(b.odds)); if (isNaN(bb)) return false; if (minOB != null && bb < minOB) return false; if (maxOB != null && bb > maxOB) return false; return true; });
    const getBetDelta = (b) => (b.proj ?? 0) - parseFloat(b.line ?? 0);
    const bmD = parseFloat(betMinDelta);
    const bxD = parseFloat(betMaxDelta);
    if (!isNaN(bmD)) arr = arr.filter((b) => getBetDelta(b) >= bmD);
    if (!isNaN(bxD)) arr = arr.filter((b) => getBetDelta(b) <= bxD);
    if (betDirAligned) arr = arr.filter((b) => { const d = getBetDelta(b); return b.side === "over" ? d > 0 : d < 0; });
    const cmp = {
      recent: (a, b) => a._i - b._i,
      game: (a, b) => String(a.game || "").localeCompare(String(b.game || "")) || a._i - b._i,
      model_desc: (a, b) => (b.modelP ?? -9) - (a.modelP ?? -9), model_asc: (a, b) => (a.modelP ?? 9) - (b.modelP ?? 9),
      ev_desc: (a, b) => (b.ev ?? -9) - (a.ev ?? -9), ev_asc: (a, b) => (a.ev ?? 9) - (b.ev ?? 9),
      edge_desc: (a, b) => (b.edge ?? -9) - (a.edge ?? -9), edge_asc: (a, b) => (a.edge ?? 9) - (b.edge ?? 9),
      clv_desc: (a, b) => (b.clv ?? -9) - (a.clv ?? -9), clv_asc: (a, b) => (a.clv ?? 9) - (b.clv ?? 9),
      delta_desc: (a, b) => getBetDelta(b) - getBetDelta(a), delta_asc: (a, b) => getBetDelta(a) - getBetDelta(b),
    }[betSort] || ((a, b) => a._i - b._i);
    return arr.sort(cmp);
  }, [myBets, betStatusFilter, betSort, betDateFilter, betGameFilters, betTypeFilters, betBookFilters, betSideFilter, betMinModel, betMinEdge, betMaxEdge, betMinOdds, betMaxOdds, betMinDelta, betMaxDelta, betDirAligned, betSearch]);
  const betDates = useMemo(() => [...new Set(myBets.map((b) => b.date).filter(Boolean))].sort().reverse(), [myBets]);
  // Scope game list to the selected date so TEX@LAA from 8/9 doesn't appear when filtering to 8/11.
  const betGames = useMemo(() => {
    const base = betDateFilter !== "all" ? myBets.filter((b) => b.date === betDateFilter) : myBets;
    return [...new Set(base.map((b) => b.game).filter(Boolean))].sort();
  }, [myBets, betDateFilter]);
  const betTypes = useMemo(() => [...new Set(myBets.map((b) => b.type).filter(Boolean))].sort(), [myBets]);
  const betBooks = useMemo(() => [...new Set(myBets.map((b) => b.book).filter(Boolean))].sort(), [myBets]);
  const betSides = useMemo(() => [...new Set(myBets.map((b) => b.side).filter(Boolean))].sort(), [myBets]);
  const trackedByGame = useMemo(() => { const m = {}; for (const b of myBets) if (b.status === "open") m[b.gamePk] = (m[b.gamePk] || 0) + 1; return m; }, [myBets]);
  const betFiltersActive = betStatusFilter !== "all" || betGameFilters.length > 0 || betTypeFilters.length > 0 || betBookFilters.length > 0 || betSideFilter !== "all" || betDateFilter !== "all" || betMinModel !== "" || betMinEdge !== "" || betMaxEdge !== "" || betMinOdds !== "" || betMaxOdds !== "" || betMinDelta !== "" || betMaxDelta !== "" || betDirAligned || betSearch !== "";
  function clearBetFilters() { setBetStatusFilter("all"); setBetGameFilters([]); setBetTypeFilters([]); setBetBookFilters([]); setBetSideFilter("all"); setBetDateFilter("all"); setBetMinModel(""); setBetMinEdge(""); setBetMaxEdge(""); setBetMinOdds(""); setBetMaxOdds(""); setBetMinDelta(""); setBetMaxDelta(""); setBetDirAligned(false); setBetSearch(""); }

  const statsDates = useMemo(() => [...new Set(myBets.map((b) => b.date).filter(Boolean))].sort(), [myBets]);
  const stats = useMemo(() => {
    let settled = myBets.filter((b) => b.status === "won" || b.status === "lost" || b.status === "push" || b.status === "void");
    if (statsStartDate) settled = settled.filter((b) => b.date && b.date >= statsStartDate);
    if (statsEndDate) settled = settled.filter((b) => b.date && b.date <= statsEndDate);
    const unitsOf = (b) => (b.units != null && !isNaN(b.units) ? Number(b.units) : 1);
    const agg = (arr) => {
      const w = arr.filter((b) => b.status === "won").length, l = arr.filter((b) => b.status === "lost").length, ps = arr.filter((b) => b.status === "push").length, v = arr.filter((b) => b.status === "void").length;
      // stake-weighted (uses each bet's units). push + void are no-action: 0 profit, not staked.
      const net = arr.reduce((s, b) => s + profitUnits(b.status, Number(b.odds), unitsOf(b)), 0);
      const staked = arr.filter((b) => b.status !== "push" && b.status !== "void").reduce((s, b) => s + unitsOf(b), 0);
      // flat 1u baseline (for comparison)
      const flatNet = arr.reduce((s, b) => s + profitUnits(b.status, Number(b.odds), 1), 0);
      const flatRisked = w + l;
      return {
        n: arr.length, w, l, ps, v, winPct: flatRisked ? w / flatRisked : null,
        net, staked, roi: staked ? net / staked : null,
        flatNet, flatRoi: flatRisked ? flatNet / flatRisked : null,
      };
    };
    const byType = {}; for (const t of STAT_ORDER) { const a = settled.filter((b) => b.type === t); if (a.length) byType[t] = agg(a); }
    return { overall: agg(settled), byType, openCount: myBets.filter((b) => b.status === "open").length };
  }, [myBets, statsStartDate, statsEndDate]);

  /* ---------- CSV export (bets + stats summary) ---------- */
  function exportCSV() {
    const esc = (v) => { if (v == null) return ""; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const pctOr = (x) => (x == null ? "" : (x * 100).toFixed(1));
    const o = stats.overall;
    const lines = [];
    lines.push("SUMMARY");
    lines.push(["metric", "value"].join(","));
    lines.push(["settled", o.n].join(","));
    lines.push(["record", `${o.w}-${o.l}${o.ps ? `-${o.ps}` : ""}`].join(","));
    lines.push(["win_pct", o.winPct != null ? (o.winPct * 100).toFixed(1) + "%" : ""].join(","));
    lines.push(["net_units_staked", o.net.toFixed(2)].join(","));
    lines.push(["roi_staked_pct", o.roi != null ? (o.roi * 100).toFixed(1) + "%" : ""].join(","));
    lines.push(["net_units_flat1u", o.flatNet.toFixed(2)].join(","));
    lines.push(["roi_flat1u_pct", o.flatRoi != null ? (o.flatRoi * 100).toFixed(1) + "%" : ""].join(","));
    lines.push(["open", stats.openCount].join(","));
    lines.push("");
    lines.push("BY TYPE");
    lines.push(["type", "won", "lost", "push", "win_pct", "net_staked", "net_flat1u"].join(","));
    for (const t of STAT_ORDER) { const s = stats.byType[t]; if (!s) continue; lines.push([esc(t), s.w, s.l, s.ps, s.winPct != null ? (s.winPct * 100).toFixed(1) : "", s.net.toFixed(2), s.flatNet.toFixed(2)].join(",")); }
    lines.push("");
    lines.push("BETS");
    lines.push(["date", "game", "name", "type", "line", "side", "odds", "book", "model_pct", "proj", "novig_pct", "edge_pct", "ev_pct", "units", "suggested", "status", "actual", "profit_units", "current_odds", "clv_pts"].join(","));
    // export EVERY tracked bet (open + settled), independent of the My Bets view filters
    const allBets = [...myBets].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    for (const b of allBets) {
      const odds = Number(b.odds);
      const imp = isNaN(odds) ? null : impliedProb(odds);
      const fairRef = b.novig != null ? b.novig : imp;
      const edge = (b.modelP != null && fairRef != null) ? b.modelP - fairRef : null;
      const ev = (b.modelP != null && !isNaN(odds)) ? evPerUnit(b.modelP, odds) : null;
      const units = b.units != null ? b.units : 1;
      const profit = (b.status === "won" || b.status === "lost") ? profitUnits(b.status, odds, units).toFixed(2) : "";
      const clv = (b.currentOdds != null && !isNaN(odds)) ? ((impliedProb(b.currentOdds) - impliedProb(odds)) * 100).toFixed(1) : "";
      lines.push([
        esc(b.date), esc(b.game), esc(b.name), esc(b.type), esc(b.line), esc(b.side), esc(b.odds), esc(b.book),
        b.modelP != null ? (b.modelP * 100).toFixed(1) : "", b.proj != null ? Number(b.proj).toFixed(2) : "",
        b.novig != null ? (b.novig * 100).toFixed(1) : "", pctOr(edge), pctOr(ev),
        units, b.suggested != null ? b.suggested : "", esc(b.status), esc(b.actual), profit,
        b.currentOdds != null ? b.currentOdds : "", clv,
      ].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url; a.download = `${meta.csvPrefix}-${stamp}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  // Board log CSV export — every candidate ever shown on the board (not just tracked bets).
  // This is the primary calibration dataset: modelVersion, rawModelP, calibratedP, novig, edge,
  // proj, settled flag, actualStat, result, and CLV (once closing line capture is wired).
  function exportBoardLogCSV() {
    const log = loadBoardLog();
    if (!log.length) { alert("No board log entries yet. Load a game to start logging."); return; }
    const esc = (v) => { if (v == null) return ""; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const headers = ["logId","loggedAt","modelVersion","date","game","gameTimeIso","gamePk","playerId","name","type","line","side","odds","novig","rawModelP","calibratedP","edge","ev","proj","settled","actualStat","result","closingNovig","clv","live"];
    const rows = [headers.join(",")];
    for (const e of log) {
      rows.push([
        esc(e.logId), esc(e.loggedAt), esc(e.modelVersion), esc(e.date),
        esc(e.game), esc(e.gameTimeIso), esc(e.gamePk), esc(e.playerId), esc(e.name),
        esc(e.type), esc(e.line), esc(e.side), esc(e.odds),
        e.novig ?? "", e.rawModelP ?? "", e.calibratedP ?? "",
        e.edge ?? "", e.ev ?? "", e.proj ?? "",
        e.settled ? "true" : "false",
        e.actualStat ?? "", esc(e.result), e.closingNovig ?? "", e.clv ?? "", e.live == null ? "" : (e.live ? "true" : "false"),
      ].join(","));
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url; a.download = `${meta.boardLogCsvPrefix}-${stamp}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function clearBoardLog() {
    if (!window.confirm(`Clear ALL board log entries? This cannot be undone. Export a CSV first.`)) return;
    resetBoardLogCache();
    void idbDel(BOARD_DB_KEY);
    try { localStorage.removeItem(LS_BOARD_LOG); } catch { /* ignore */ }
    setBoardLogCount(0);
  }

  // lossless backup of the bet log so it survives a host/browser change (localStorage does not)
  function backupBets() {
    const data = JSON.stringify({ app: meta.backupApp, v: 1, exported: new Date().toISOString(), bets: myBets }, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${meta.csvPrefix}-bets-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function restoreBets(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const incoming = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.bets) ? parsed.bets : null);
        if (!incoming) { setSettleMsg("Restore failed: not a valid bet backup file."); return; }
        const have = new Set(myBets.map((b) => b.key));
        const toAdd = incoming.filter((b) => b && b.key != null && !have.has(b.key));
        setMyBets((cur) => { const k = new Set(cur.map((b) => b.key)); return [...cur, ...toAdd.filter((b) => !k.has(b.key))]; });
        setSettleMsg(`Restored ${toAdd.length} bet(s) from backup (${incoming.length} in file; duplicates skipped).`);
      } catch { setSettleMsg("Restore failed: could not parse the JSON file."); }
    };
    reader.readAsText(file);
  }

  /* ============================ UI ============================ */
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <div className="max-w-5xl mx-auto px-4 pb-28">
        <header className="pt-6 pb-3 sticky top-0 bg-slate-950 z-20 border-b border-slate-800">
          <div className="flex items-end justify-between flex-wrap gap-3">
            <div>
              <h1 className="text-2xl font-black tracking-tight">{`${meta.emoji} ${meta.title} `}<span className="text-emerald-400">EDGE</span> FINDER</h1>
              <p className="text-[11px] text-slate-500 mt-0.5" style={mono}>{meta.tagline}</p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1">
                <button onClick={() => shiftDate(-1)} className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-800">◂</button>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-sm text-slate-100" />
                <button onClick={() => shiftDate(1)} className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-800">▸</button>
                <button onClick={() => setDate(todayStr())} className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs hover:bg-slate-800 text-slate-400">today</button>
              </div>
              <select value={book} onChange={(e) => setBook(e.target.value)} className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm">
                {BOOKS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
              </select>
              <button onClick={() => setShowBookPanel((v) => !v)} className={`rounded-lg px-2 py-1.5 text-xs font-medium border ${showBookPanel || Object.keys(bookOverrides).length ? "border-sky-700 bg-sky-950 text-sky-300" : "border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200"}`} title={meta.overrideTitle}>
                books{Object.keys(bookOverrides).length ? ` (${Object.keys(bookOverrides).length})` : ""} ▾
              </button>
              <button onClick={() => loadSchedule(date)} className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm rounded-lg px-3 py-1.5">{loading ? "…" : "Refresh"}</button>
            </div>
          </div>
          {showBookPanel && (
            <div className="mt-2 bg-slate-900/70 border border-slate-800 rounded-lg px-3 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
              <span className="text-slate-500 w-full sm:w-auto" style={mono}>
                per-market book — sources that prop's odds from a different book than "{BOOK_LABELS[book]}" above, but only when {BOOK_LABELS[book]} doesn't carry that market for the game; otherwise it still uses {BOOK_LABELS[book]}. Costs no extra odds credits (both books pulled in one call).
              </span>
              {ALL_PROPS.map((t) => (
                <label key={t} className="flex items-center gap-1.5 text-slate-300">
                  {t}
                  <select
                    value={bookOverrides[t] || ""}
                    onChange={(e) => setBookOverride(t, e.target.value)}
                    className="bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-xs"
                  >
                    <option value="">(same as {BOOK_LABELS[book]})</option>
                    {BOOKS.filter((b) => b.key !== book).map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
                  </select>
                </label>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
            <div className="flex gap-1 flex-wrap">
              {[["slate", "Slate"], ["board", `Board${boardEntries.length ? ` (${boardEntries.length})` : ""}`], ["trends", `Trends${trendCards.length ? ` (${trendCards.length})` : ""}`], ["analysis", "Player Analysis"], ["mybets", `My Bets${myBets.length ? ` (${myBets.length})` : ""}`], ["stats", "Stats"]].map(([k, l]) => (
                <button key={k} onClick={() => setTab(k)} className={`px-3.5 py-1.5 rounded-lg text-sm font-semibold ${tab === k ? "bg-slate-800 text-emerald-400" : "text-slate-400 hover:text-slate-200"}`}>{l}</button>
              ))}
            </div>
            <div className="flex items-center gap-3 text-[10px] text-slate-500" style={mono}>
              <span>odds credits: <b className={credits != null && credits < 1000 ? "text-amber-400" : "text-slate-300"}>{credits != null ? credits.toLocaleString() : "—"}</b><span className="text-slate-600"> / mo</span></span>
              {stamp && <span>pulled {stamp.toLocaleTimeString()}</span>}
            </div>
          </div>
        </header>

        {err && <div className="mt-3 text-sm text-amber-300 bg-amber-950/40 border border-amber-800/50 rounded-lg px-3 py-2">{err}</div>}

        {/* ---------------- SLATE ---------------- */}
        {tab === "slate" && (
          <div className="mt-3 space-y-2">
            {games.map((g) => {
              const d = detail[g.pk]; const isOpen = open === g.pk; const hasOdds = (board[g.pk] || []).length;
              return (
                <div key={g.pk} className="bg-slate-900/70 border border-slate-800 rounded-xl overflow-hidden">
                  <div className="w-full flex items-center gap-3 px-4 py-3">
                    <button onClick={() => expand(g)} className="flex-1 flex items-center gap-3 text-left min-w-0">
                      <div className="text-[11px] text-slate-500 w-16 shrink-0" style={mono}>{g.time}</div>
                      <div className="flex-1 min-w-0">
                        <div className="font-bold truncate">{g.away} <span className="text-slate-600">@</span> {g.home}</div>
                        {(g.status === "LIVE" || g.status === "FINAL") && g.homeScore != null
                          ? <ScoreLine g={g} />
                          : <GameSubtitle g={g} />}
                      </div>
                      <Chip s={g.status} />
                    </button>
                    {trackedByGame[g.pk] ? <span title={`${trackedByGame[g.pk]} open tracked bet(s) on this game`} className="shrink-0 text-[10px] font-bold text-emerald-300 bg-emerald-900/40 border border-emerald-800 rounded-full px-1.5 py-0.5" style={mono}>● {trackedByGame[g.pk]}</span> : null}
                    {!g.manual && g.status !== "FINAL" && (
                      <button onClick={() => getOdds(g)} disabled={oddsLoading === g.pk}
                        className={`text-[11px] font-bold rounded px-2 py-1 ${hasOdds ? "bg-slate-700 text-slate-200" : "bg-sky-600 hover:bg-sky-500 text-white"}`}>
                        {oddsLoading === g.pk ? "…" : hasOdds ? "↻ odds" : "get odds"}
                      </button>
                    )}
                    <button onClick={() => expand(g)} className={`text-slate-600 transition ${isOpen ? "rotate-90" : ""}`}>▸</button>
                  </div>

                  {isOpen && (
                    <div className="px-4 pb-4 border-t border-slate-800">
                      {d && d.loading && <div className="py-6 text-center text-sm text-slate-500" style={mono}>loading stats…</div>}
                      {g.manual && <div className="py-3 text-xs text-slate-400">Manual game — model context unavailable; track bets by hand from My Bets.</div>}
                      {d && d.ready && (
                        <>
                          <SlateDetail g={g} d={d} draftFromGame={draftFromGame} goToAnalysis={goToAnalysis} />
                          {hasOdds ? <div className="mt-3 text-[11px] text-emerald-400/80">{hasOdds} priced props on the Board ({book}).</div>
                            : (g.status !== "FINAL" && <div className="mt-3 text-[11px] text-slate-500">Tap “get odds” to pull {book} props for this game into the Board.</div>)}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <div className="mt-4">
              <button onClick={() => setShowManual((s) => !s)} className="text-xs text-slate-400 hover:text-slate-200">{showManual ? "− hide" : "+ add a game manually"}</button>
              {showManual && (
                <div className="mt-2 flex flex-wrap gap-2 items-end bg-slate-900/60 border border-slate-800 rounded-lg p-3">
                  {[["away", "Away"], ["home", "Home"], ["time", "Time"]].map(([k, ph]) => (
                    <input key={k} placeholder={ph} value={mg[k]} onChange={(e) => setMg((p) => ({ ...p, [k]: e.target.value }))} className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-24" />
                  ))}
                  <button onClick={addManualGame} className="bg-violet-500 hover:bg-violet-400 text-white font-bold text-sm rounded px-3 py-1.5">Add</button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ---------------- BOARD ---------------- */}
        {tab === "board" && (
          <div className="mt-3">
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <input value={boardSearch} onChange={(e) => setBoardSearch(e.target.value)} placeholder="search player or team" className="bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-sm w-44 text-slate-100" />
              <Sel compact label="sort" v={boardSort} opts={["ev_desc", "ev_asc", "edge_desc", "edge_asc", "proj_desc", "proj_asc", "delta_desc", "delta_asc"]} labels={{ ev_desc: "EV ↓", ev_asc: "EV ↑", edge_desc: "Edge ↓", edge_asc: "Edge ↑", proj_desc: "Projection ↓", proj_asc: "Projection ↑", delta_desc: "Proj Δ ↓", delta_asc: "Proj Δ ↑" }} onChange={setBoardSort} />
              <Sel compact label="market" v={classFilter} opts={["all", "props", "lines"]} labels={{ all: "All markets", props: "Player props", lines: "Game lines" }} onChange={setClassFilter} />
              <Sel compact label="category" v={catFilter} opts={["all", ...CATEGORY_ORDER]} labels={{ all: "All categories" }} onChange={setCatFilter} />
              <Sel compact label="game" v={gameFilter} opts={["all", ...boardGames.map((x) => x.pk)]} labels={{ all: "All games", ...Object.fromEntries(boardGames.map((x) => [x.pk, x.label])) }} onChange={setGameFilter} />
              <Sel compact label="side" v={sideFilter} opts={["all", "over", "under"]} labels={{ all: "Both", over: "Over", under: "Under" }} onChange={setSideFilter} />
              {(() => { const n = [minEdge, minModel, minEV, minOdds, maxOdds, minDelta, maxDelta].filter((x) => x !== "").length + (dirAligned ? 1 : 0) + (signalFilter !== "all" ? 1 : 0); return (
                <button onClick={() => setShowMoreBoard((s) => !s)} className={`text-xs rounded px-2.5 py-1.5 border ${showMoreBoard || n ? "border-emerald-700 text-emerald-300" : "border-slate-700 text-slate-400 hover:text-slate-200"}`}>filters{n ? ` (${n})` : ""} {showMoreBoard ? "▴" : "▾"}</button>
              ); })()}
              <button onClick={() => setShowProjBar((s) => !s)} className={`text-xs rounded px-2.5 py-1.5 border ${showProjBar ? "border-sky-700 text-sky-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`} title="Toggle projection bar">proj bar {showProjBar ? "▪" : "▫"}</button>
              {Object.keys(coverage).length > 0 && (
                <button onClick={toggleShowCoverage} className={`text-xs rounded px-2.5 py-1.5 border ${showCoverage ? "border-sky-700 text-sky-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`} title="Per-game odds-feed diagnostics (raw markets returned, HR coverage, statcast source) — collapsed by default since it's mostly for debugging">
                  diagnostics ({Object.keys(coverage).length}) {showCoverage ? "▴" : "▾"}
                </button>
              )}
              {filtersActive && <button onClick={clearFilters} className="text-[11px] text-slate-400 hover:text-rose-300 border border-slate-700 rounded px-2.5 py-1.5">clear</button>}
              <div className="ml-auto text-[11px] text-slate-500" style={mono}>{Object.values(grouped).reduce((n, a) => n + a.length, 0)} plays</div>
            </div>
            {showMoreBoard && (
              <div className="flex items-end gap-3 flex-wrap mb-3 p-2.5 rounded-lg bg-slate-900/40 border border-slate-800">
                <label className="text-xs text-slate-400 flex flex-col gap-1">min edge %
                  <input value={minEdge} onChange={(e) => setMinEdge(e.target.value)} placeholder="any" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">min model %
                  <input value={minModel} onChange={(e) => setMinModel(e.target.value)} placeholder="65" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">min EV %
                  <input value={minEV} onChange={(e) => setMinEV(e.target.value)} placeholder="any" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">min proj Δ
                  <input value={minDelta} onChange={(e) => setMinDelta(e.target.value)} placeholder="e.g. 0.5" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">max proj Δ
                  <input value={maxDelta} onChange={(e) => setMaxDelta(e.target.value)} placeholder="e.g. 2.0" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">min odds
                  <input value={minOdds} onChange={(e) => setMinOdds(e.target.value)} placeholder="-300" inputMode="numeric" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">max odds
                  <input value={maxOdds} onChange={(e) => setMaxOdds(e.target.value)} placeholder="+300" inputMode="numeric" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">proj aligned
                  <button onClick={() => setDirAligned((s) => !s)} className={`text-xs rounded px-3 py-1.5 border font-medium ${dirAligned ? "border-sky-600 bg-sky-950 text-sky-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`} title="Only show plays where proj direction agrees with the bet side (proj > line for overs, proj < line for unders)">{dirAligned ? "on" : "off"}</button>
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">signal
                  <div className="flex gap-1">
                    {(["all", "moderate", "strong"] as const).map((v) => (
                      <button key={v} onClick={() => setSignalFilter(v)} className={`text-xs rounded px-2 py-1.5 border font-medium ${signalFilter === v ? (v === "strong" ? "border-emerald-600 bg-emerald-950 text-emerald-300" : v === "moderate" ? "border-yellow-600 bg-yellow-950 text-yellow-300" : "border-sky-600 bg-sky-950 text-sky-300") : "border-slate-700 text-slate-500 hover:text-slate-300"}`}>{v === "all" ? "all" : v === "moderate" ? "🟡 mod+" : "🟢 strong"}</button>
                    ))}
                  </div>
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1 ml-auto">
                  <span>&nbsp;</span>
                  <button onClick={trackAllFiltered} className="text-xs rounded px-3 py-1.5 border border-emerald-700 bg-emerald-950 text-emerald-300 hover:bg-emerald-900 font-bold" title="Track every play currently passing the Board filters as an open bet, in one click">
                    Track all filtered ({Object.values(grouped).reduce((n, a) => n + a.length, 0)})
                  </button>
                </label>
              </div>
            )}
            {trackAllMsg && <div className="text-[11px] text-emerald-400/80 mb-2">{trackAllMsg}</div>}
            {showCoverage && Object.keys(coverage).length > 0 && (
              <div className="mb-3 text-[10px] text-slate-500 space-y-1.5" style={mono}>
                {Object.values(coverage).map((c, i) => (
                  <div key={i} className="border border-slate-800 rounded-lg px-2.5 py-1.5">
                    <div>{c.game} · {c.usedBook || c.book}: <span className="text-slate-400">{c.matched.length ? c.matched.join(", ") : "no players matched"}</span></div>
                    <div className="text-slate-600">raw markets returned: {c.rawKeys && c.rawKeys.length ? c.rawKeys.join(", ") : "none"}</div>
                    <div>{c.hasHR
                      ? <span className="text-emerald-500">{meta.diagnosticsMarketKey} IS present{c.hrSample ? ` · sample → name:"${c.hrSample.name}" desc:"${c.hrSample.description}" point:${c.hrSample.point}` : ""}</span>
                      : <span className="text-amber-500">{meta.diagnosticsMarketKey} NOT returned by {c.usedBook || c.book} (book/feed didn't carry it for this game)</span>}</div>
                    {c.hrFellBack && <div className="text-sky-400">{meta.diagnosticsType} odds fell back to {BOOK_LABELS[c.hrUsedBook] || c.hrUsedBook} for this game (primary book didn't carry it)</div>}
                    {!c.hasHR && !c.hrFellBack && c.hrOverrideAvailable === false && <div className="text-amber-500">fallback book didn't carry {meta.diagnosticsType} odds for this game either</div>}
                    {c.statcast && <div className={c.statcast.verdict === "statcast_confirmed" ? "text-emerald-500" : "text-slate-600"}>statcast: {c.statcast.verdict} · EV balls {c.statcast.battedBallsWithExitVelo || 0} · xBA balls {c.statcast.battedBallsWithXBA || 0}</div>}
                    {c.statcast && c.statcast.sources && <div className="text-slate-600">source: {c.statcast.sources}</div>}
                    {c.books && c.books.length > 1 && <div className="text-slate-600">books in response: {c.books.join(", ")}</div>}
                  </div>
                ))}
              </div>
            )}
            {boardEntries.length === 0 ? (
              <div className="text-sm text-slate-500 py-10 text-center">No odds pulled yet. On the Slate tab, tap <span className="text-sky-400">get odds</span> on a game to load {book} props here, ranked by EV/edge.</div>
            ) : Object.keys(grouped).length === 0 ? (
              <div className="text-sm text-slate-500 py-10 text-center">No props pass the current filter.</div>
            ) : (
              STAT_ORDER.filter((t) => grouped[t]).map((t) => (
                <div key={t} className="mb-5">
                  <div className="text-[11px] font-bold tracking-wide text-slate-400 mb-1.5 uppercase">{t} <span className="text-slate-600">· {grouped[t].length}</span></div>
                  <div className="space-y-2">
                    {grouped[t].map((e) => <BoardRow key={e.id} e={e} tracked={myBets.some((b) => b.key === e.id)} onTrack={() => trackBet(e)} showProjBar={showProjBar} />)}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* ---------------- TRENDS ---------------- */}
        {tab === "trends" && (
          <div className="mt-3">
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <input value={trendSearch} onChange={(e) => setTrendSearch(e.target.value)} placeholder="search player or team" className="bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-sm w-44 text-slate-100" />
              <Sel compact label="prop" v={trendCatFilter} opts={["all", ...TREND_PROPS]} labels={{ all: "All props" }} onChange={setTrendCatFilter} />
              <Sel compact label="game" v={trendGameFilter} opts={["all", ...trendGames.map((g) => g.pk)]} labels={{ all: "All games", ...Object.fromEntries(trendGames.map((g) => [g.pk, g.label])) }} onChange={setTrendGameFilter} />
              <Sel compact label="side" v={trendSideFilter} opts={["all", "over", "under"]} labels={{ all: "Both" }} onChange={setTrendSideFilter} />
              <Sel compact label="split" v={trendSplit} opts={["recentForm", "vsOpp", "homeAway"]} labels={{ recentForm: "Recent Form", vsOpp: "Head to Head", homeAway: "Home/Away" }} onChange={setTrendSplit} />
              <Sel compact label="sample" v={trendRecentN} opts={[5, 8, 10, 15, 20]} labels={{ 5: "last 5", 8: "last 8", 10: "last 10", 15: "last 15", 20: "last 20" }} onChange={(v) => setTrendRecentN(+v)} />
              {(() => { const n = (trendMinHit !== "" ? 1 : 0) + (trendSourceFilter !== "all" ? 1 : 0); return (
                <button onClick={() => setShowMoreTrends((s) => !s)} className={`text-xs rounded px-2.5 py-1.5 border ${showMoreTrends || n ? "border-emerald-700 text-emerald-300" : "border-slate-700 text-slate-400 hover:text-slate-200"}`}>filters{n ? ` (${n})` : ""} {showMoreTrends ? "▴" : "▾"}</button>
              ); })()}
              {trendFiltersActive && <button onClick={clearTrendFilters} className="text-[11px] text-slate-400 hover:text-rose-300 border border-slate-700 rounded px-2.5 py-1.5">clear</button>}
              <div className="ml-auto text-[11px] text-slate-500" style={mono}>{filteredTrends.length} trends</div>
            </div>
            {showMoreTrends && (
              <div className="flex items-end gap-3 flex-wrap mb-3 p-2.5 rounded-lg bg-slate-900/40 border border-slate-800">
                <label className="text-xs text-slate-400 flex flex-col gap-1">min hit rate %
                  <input value={trendMinHit} onChange={(e) => setTrendMinHit(e.target.value)} placeholder="any" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <Sel compact label="line source" v={trendSourceFilter} opts={["all", "book", "model"]} labels={{ all: "Any", book: "Book line", model: "Model-free" }} onChange={setTrendSourceFilter} />
                <Sel compact label="sort" v={trendSort} opts={["hit_desc", "hit_asc", "name_asc"]} labels={{ hit_desc: "Hit rate ↓", hit_asc: "Hit rate ↑", name_asc: "Name A-Z" }} onChange={setTrendSort} />
              </div>
            )}
            {games.length === 0 ? (
              <div className="text-sm text-slate-500 py-10 text-center">Load a slate first (Slate tab) to build trends.</div>
            ) : trendCards.length === 0 ? (
              <div className="text-sm text-slate-500 py-10 text-center">
                {trendDebug.players === 0 ? (
                  <>No game/player data loaded yet. Trends reads the same lineup + gamelog data the Slate/Board tabs already pull ({meta.statsSource}, free — no Odds API credits needed).
                  <div className="mt-3">
                    <button onClick={() => loadTrendsForGames(games)} disabled={!!trendBulkLoading} className="bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-bold text-sm rounded-lg px-3 py-1.5">
                      {trendBulkLoading ? `Loading ${trendBulkLoading.done}/${trendBulkLoading.total}…` : "Load trends for all games"}
                    </button>
                  </div></>
                ) : (
                  <>
                    <div>Games/lineups loaded ({trendDebug.players} players), but no trend cards came out the other end.</div>
                    <div className="mt-2 text-[11px]" style={mono}>
                      gamelog this season: {trendDebug.withCurGames}/{trendDebug.players} players · with prior-season fallback: {trendDebug.withAnyGames}/{trendDebug.players} players · prop checks run: {trendDebug.propAttempts} · cards built: {trendDebug.cardsBuilt}
                    </div>
                    <div className="mt-2 max-w-xl mx-auto">
                      {trendDebug.withAnyGames === 0
                        ? "Every player's gamelog fetch came back empty — hit Refresh up top to reset, then reload trends. If it's still 0 after that, check the browser console for warnings and send those over."
                        : "Gamelogs are loading, but no player/prop cleared a line in any split — try widening the sample size above, or this slate's players genuinely have too short a history yet."}
                    </div>
                  </>
                )}
              </div>
            ) : filteredTrends.length === 0 ? (
              <div className="text-sm text-slate-500 py-10 text-center">No trends pass the current filter.</div>
            ) : (
              <div className="space-y-2">
                {filteredTrends.map((c) => {
                  const entry = c.boardEntryId ? boardEntries.find((e) => e.id === c.boardEntryId) : null;
                  return <TrendCard key={c.id} c={c} entry={entry} tracked={entry ? myBets.some((b) => b.key === entry.id) : false} onTrack={trackBet} />;
                })}
              </div>
            )}
            {games.length > 0 && (
              <div className="mt-3 flex items-center gap-2 text-[11px] text-slate-500">
                <span>
                  {games.filter((g) => detail[g.pk] && detail[g.pk].ready).length}/{games.length} games loaded for trends.
                  {trendBulkLoading && ` Loading ${trendBulkLoading.done}/${trendBulkLoading.total}…`}
                </span>
                {games.some((g) => !(detail[g.pk] && detail[g.pk].ready)) && (
                  <button onClick={() => loadTrendsForGames(games)} disabled={!!trendBulkLoading} className="text-[11px] text-emerald-400 hover:text-emerald-300 disabled:opacity-50 border border-slate-700 rounded px-2 py-1">load remaining</button>
                )}
              </div>
            )}
          </div>
        )}

        {/* ---------------- PLAYER ANALYSIS ---------------- */}
        {tab === "analysis" && (
          <div className="mt-3 space-y-3">
            <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3">
              <div className="flex items-end gap-2 flex-wrap">
                <label className="text-xs text-slate-400 flex flex-col gap-1 flex-1 min-w-[220px]">player search
                  <input
                    value={analysisQuery}
                    onChange={(e) => setAnalysisQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") runAnalysisSearch(); }}
                    placeholder={meta.searchPlaceholder}
                    className="bg-slate-950 border border-slate-700 rounded px-2.5 py-2 text-sm text-slate-100"
                  />
                </label>
                <button onClick={runAnalysisSearch} disabled={analysisSearching || !analysisQuery.trim()} className="bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-bold text-sm rounded-lg px-3 py-2">
                  {analysisSearching ? "…" : "Search"}
                </button>
                {(analysisProfile || analysisResults.length > 0 || analysisQuery) && (
                  <button onClick={() => { setAnalysisQuery(""); setAnalysisResults([]); setAnalysisProfile(null); setAnalysisErr(""); }} className="text-sm text-slate-400 hover:text-rose-300 border border-slate-700 rounded-lg px-3 py-2">
                    clear
                  </button>
                )}
              </div>
              <div className="text-[11px] text-slate-500 mt-2" style={mono}>
                {meta.analysisHint} {book} odds.
              </div>
            </div>

            {analysisErr && <div className="text-sm text-amber-300 bg-amber-950/40 border border-amber-800/50 rounded-lg px-3 py-2">{analysisErr}</div>}

            {analysisResults.length > 0 && (
              <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-2">
                <div className="text-[10px] text-slate-500 font-bold tracking-wide px-1 mb-1">SEARCH RESULTS</div>
                <div className="grid sm:grid-cols-2 gap-2">
                  {analysisResults.map((p) => {
                    const selected = analysisProfile && String(analysisProfile.player.id) === String(p.id);
                    return (
                      <button key={p.id} onClick={() => selectAnalysisPlayer(p)} className={`text-left border rounded-lg px-3 py-2 ${selected ? "border-emerald-700 bg-emerald-950/30" : "border-slate-800 bg-slate-950/50 hover:border-slate-700"}`}>
                        <div className="text-sm font-bold text-slate-100">{p.name}</div>
                        <div className="text-[11px] text-slate-500" style={mono}>{meta.searchResultLine(p)}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {!analysisProfile && !analysisLoading && analysisResults.length === 0 && (
              <PlayerAnalysisIntro games={games} boardCount={boardEntries.length} />
            )}

            {analysisLoading && <div className="py-10 text-center text-sm text-slate-500" style={mono}>loading player profile…</div>}

            {analysisProfile && !analysisLoading && (
              <PlayerProfilePanel
                profile={analysisProfile}
                spot={analysisSpot}
                detail={analysisDetail}
                projections={analysisProjections}
                boardEntries={analysisBoardEntries}
                boardGameCount={analysisBoardGameCount}
                book={book}
                oddsLoading={oddsLoading}
                oddsReady={!!(analysisSpot && (board[analysisSpot.game.pk] || []).length > 0 && coverage[analysisSpot.game.pk]?.book === book)}
                onFetchOdds={() => { if (analysisSpot) getOdds(analysisSpot.game); }}
                myBets={myBets}
                onTrack={trackBet}
                showProjBar={showProjBar}
              />
            )}
          </div>
        )}

        {/* ---------------- MY BETS ---------------- */}
        {tab === "mybets" && (
          <div className="mt-3">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <input value={betSearch} onChange={(e) => setBetSearch(e.target.value)} placeholder="search player or team" className="bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-sm w-44 text-slate-100" />
                <Sel compact label="show" v={betStatusFilter} opts={["all", "open", "settled", "won", "lost", "push", "void"]} labels={{ all: "All", open: "Open", settled: "Settled", won: "Won", lost: "Lost", push: "Push", void: "Void" }} onChange={setBetStatusFilter} />
                <Sel compact label="date" v={betDateFilter} opts={["all", ...betDates]} labels={{ all: "All dates" }} onChange={setBetDateFilter} />
                <MultiSel compact label="game" selected={betGameFilters} opts={betGames} onChange={setBetGameFilters} />
                <MultiSel compact label="category" selected={betTypeFilters} opts={betTypes} onChange={setBetTypeFilters} />
                <MultiSel compact label="book" selected={betBookFilters} opts={betBooks} labels={BOOK_LABELS} onChange={setBetBookFilters} />
                <Sel compact label="side" v={betSideFilter} opts={["all", ...betSides]} labels={{ all: "All sides" }} onChange={setBetSideFilter} />
                <Sel compact label="sort" v={betSort} opts={["recent", "game", "model_desc", "model_asc", "ev_desc", "ev_asc", "edge_desc", "edge_asc", "clv_desc", "clv_asc", "delta_desc", "delta_asc"]} labels={{ recent: "Most recent", game: "Game", model_desc: "Model % ↓", model_asc: "Model % ↑", ev_desc: "EV ↓", ev_asc: "EV ↑", edge_desc: "Edge ↓", edge_asc: "Edge ↑", clv_desc: "Line move ↓", clv_asc: "Line move ↑", delta_desc: "Proj Δ ↓", delta_asc: "Proj Δ ↑" }} onChange={setBetSort} />
                {(() => { const n = (betMinModel !== "" ? 1 : 0) + (betMinEdge !== "" ? 1 : 0) + (betMaxEdge !== "" ? 1 : 0) + (betMinOdds !== "" ? 1 : 0) + (betMaxOdds !== "" ? 1 : 0) + (betMinDelta !== "" ? 1 : 0) + (betMaxDelta !== "" ? 1 : 0) + (betDirAligned ? 1 : 0); return (
                  <button onClick={() => setShowMoreBets((s) => !s)} className={`text-xs rounded px-2.5 py-1.5 border ${showMoreBets || n ? "border-emerald-700 text-emerald-300" : "border-slate-700 text-slate-400 hover:text-slate-200"}`}>more{n ? ` (${n})` : ""} {showMoreBets ? "▴" : "▾"}</button>
                ); })()}
                {betFiltersActive && <button onClick={clearBetFilters} className="text-[11px] text-slate-400 hover:text-rose-300 border border-slate-700 rounded px-2.5 py-1.5">clear</button>}
              </div>
              <div className="flex items-center gap-2 self-end">
                <button onClick={exportCSV} disabled={myBets.length === 0} className="bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white font-bold text-sm rounded-lg px-3 py-1.5">Download CSV</button>
                <button onClick={backupBets} disabled={myBets.length === 0} className="bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white font-bold text-sm rounded-lg px-3 py-1.5" title="Save a .json backup you can restore later or on another device">Backup</button>
                <label className="bg-slate-700 hover:bg-slate-600 text-white font-bold text-sm rounded-lg px-3 py-1.5 cursor-pointer" title="Restore bets from a .json backup">Restore
                  <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => { restoreBets(e.target.files && e.target.files[0]); e.target.value = ""; }} />
                </label>
                <button onClick={refreshLines} disabled={refreshingLines} className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-bold text-sm rounded-lg px-3 py-1.5" title="Pull the current price for each open tracked bet (line movement / CLV). ~9 credits per game.">{refreshingLines ? "…" : "Refresh lines"}</button>
                <button onClick={settleBets} className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm rounded-lg px-3 py-1.5">Settle finished</button>
              </div>
            </div>
            {showMoreBets && (
              <div className="flex items-end gap-3 flex-wrap mb-3 p-2.5 rounded-lg bg-slate-900/40 border border-slate-800">
                <label className="text-xs text-slate-400 flex flex-col gap-1">min model %
                  <input value={betMinModel} onChange={(e) => setBetMinModel(e.target.value)} placeholder="any" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">min edge %
                  <input value={betMinEdge} onChange={(e) => setBetMinEdge(e.target.value)} placeholder="any" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">max edge %
                  <input value={betMaxEdge} onChange={(e) => setBetMaxEdge(e.target.value)} placeholder="any" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">min proj Δ
                  <input value={betMinDelta} onChange={(e) => setBetMinDelta(e.target.value)} placeholder="e.g. 0.5" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">max proj Δ
                  <input value={betMaxDelta} onChange={(e) => setBetMaxDelta(e.target.value)} placeholder="e.g. 2.0" inputMode="decimal" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">min odds
                  <input value={betMinOdds} onChange={(e) => setBetMinOdds(e.target.value)} placeholder="-300" inputMode="numeric" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">max odds
                  <input value={betMaxOdds} onChange={(e) => setBetMaxOdds(e.target.value)} placeholder="+300" inputMode="numeric" className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm w-20 text-slate-100" />
                </label>
                <label className="text-xs text-slate-400 flex flex-col gap-1">proj aligned
                  <button onClick={() => setBetDirAligned((s) => !s)} className={`text-xs rounded px-3 py-1.5 border font-medium ${betDirAligned ? "border-sky-600 bg-sky-950 text-sky-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`} title="Only show bets where proj direction matched the bet side">{betDirAligned ? "on" : "off"}</button>
                </label>
              </div>
            )}
            {settleMsg && <div className="text-[11px] text-slate-400 mb-2">{settleMsg}</div>}
            {lineMsg && <div className="text-[11px] text-indigo-300 mb-2">{lineMsg}</div>}
            {myBets.length > 0 && (
              <div className="text-[11px] text-slate-400 mb-2 flex items-center gap-x-3 gap-y-1 flex-wrap">
                <span>showing <b className="text-slate-200">{myBetsView.length}</b> of {myBets.length} bets</span>
                {(() => {
                  const set = myBetsView.filter((b) => b.status === "won" || b.status === "lost" || b.status === "push" || b.status === "void");
                  if (!set.length) return null;
                  const w = set.filter((b) => b.status === "won").length, l = set.filter((b) => b.status === "lost").length, p = set.filter((b) => b.status === "push").length;
                  const net = set.reduce((s, b) => s + (profitUnits(b.status, Number(b.odds), b.units != null ? b.units : 1) || 0), 0);
                  const wr = (w + l) ? (w / (w + l) * 100).toFixed(1) : "0.0";
                  return <span>· settled in view: <b className="text-slate-200">{w}-{l}{p ? `-${p}` : ""}</b> ({wr}%) · net <b className={net >= 0 ? "text-emerald-400" : "text-rose-400"}>{net >= 0 ? "+" : ""}{net.toFixed(2)}u</b></span>;
                })()}
              </div>
            )}
            {myBets.length === 0 ? (
              <div className="text-sm text-slate-500 py-10 text-center">No bets tracked. Add from the Board (<span className="text-emerald-400">track</span>) or draft one from a player on the Slate.</div>
            ) : myBetsView.length === 0 ? (
              <div className="text-sm text-slate-500 py-10 text-center">No bets match this filter.</div>
            ) : (
              <div className="space-y-2">
                {myBetsView.map((b) => <MyBetRow key={b.key} b={b} onOdds={(v) => updateBetOdds(b.key, v)} onUnits={(v) => updateBetUnits(b.key, v)} onRemove={() => removeBet(b.key)} />)}
              </div>
            )}
          </div>
        )}

        {/* ---------------- STATS ---------------- */}
        {tab === "stats" && (
          <div className="mt-3">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <div className="text-[11px] text-slate-500" style={mono}>net & ROI are stake-weighted (units per bet) · flat-1u shown for comparison</div>
              <div className="flex items-center gap-2">
                <button onClick={exportCSV} disabled={myBets.length === 0} className="bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white font-bold text-xs rounded-lg px-3 py-1.5">Download CSV</button>
                <button onClick={resetStats} disabled={myBets.length === 0} className="bg-slate-800 hover:bg-rose-700 disabled:opacity-40 border border-slate-700 text-slate-200 font-bold text-xs rounded-lg px-3 py-1.5">Reset stats</button>
              </div>
            </div>

            {/* Board Log section — calibration dataset (all board candidates, not just tracked bets) */}
            <div className="mb-4 p-3 rounded-lg bg-slate-900/60 border border-slate-800">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <div className="text-xs font-bold text-slate-300 mb-0.5">Board Snapshot Log</div>
                  <div className="text-[11px] text-slate-500">
                    Every prop shown on the board is logged here for calibration analysis — not just tracked bets.
                    {boardLogCount > 0
                      ? <span className="text-emerald-400 ml-1">{boardLogCount.toLocaleString()} candidates logged · model {MODEL_VERSION}</span>
                      : <span className="text-slate-600 ml-1">No entries yet — load a game to start logging.</span>
                    }
                  {boardLogSettleMsg && <span className="block mt-0.5 text-sky-400">{boardLogSettleMsg}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={settleFullBoardLog}
                    disabled={boardLogSettling || boardLogCount === 0}
                    className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white font-bold text-xs rounded-lg px-3 py-1.5"
                    title={`Grade every board candidate for finished games — uses free ${meta.statsSource}, no Odds API credits`}
                  >
                    {boardLogSettling ? "Settling…" : "Settle board log"}
                  </button>
                  <button
                    onClick={exportBoardLogCSV}
                    disabled={boardLogCount === 0}
                    className="bg-sky-700 hover:bg-sky-600 disabled:opacity-40 text-white font-bold text-xs rounded-lg px-3 py-1.5"
                    title="Export every board candidate with raw model probability, calibrated probability, edge, projection, and settlement result"
                  >
                    Export CSV
                  </button>
                  <button
                    onClick={() => { clearBoardLog(); setBoardLogCount(0); setBoardLogSettleMsg(""); }}
                    disabled={boardLogCount === 0}
                    className="bg-slate-800 hover:bg-rose-800 disabled:opacity-40 border border-slate-700 text-slate-400 font-bold text-xs rounded-lg px-3 py-1.5"
                    title="Permanently delete all board log entries (export first)"
                  >
                    Clear log
                  </button>
                </div>
              </div>
            </div>

            {/* Date range filter */}
            <div className="flex items-end gap-3 flex-wrap mb-4 p-2.5 rounded-lg bg-slate-900/40 border border-slate-800">
              <label className="text-xs text-slate-400 flex flex-col gap-1">start date
                <input type="date" value={statsStartDate} min={statsDates[0] || ""} max={statsEndDate || statsDates[statsDates.length - 1] || ""} onChange={(e) => setStatsStartDate(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-100 w-36" />
              </label>
              <label className="text-xs text-slate-400 flex flex-col gap-1">end date
                <input type="date" value={statsEndDate} min={statsStartDate || statsDates[0] || ""} max={statsDates[statsDates.length - 1] || ""} onChange={(e) => setStatsEndDate(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-100 w-36" />
              </label>
              {(statsStartDate || statsEndDate) && (
                <button onClick={() => { setStatsStartDate(""); setStatsEndDate(""); }} className="text-[11px] text-slate-400 hover:text-rose-300 border border-slate-700 rounded px-2.5 py-1.5">clear</button>
              )}
              <div className="text-[11px] text-slate-500 self-end pb-1.5" style={mono}>
                {statsStartDate || statsEndDate
                  ? `${statsStartDate || statsDates[0] || "…"} → ${statsEndDate || statsDates[statsDates.length - 1] || "…"}`
                  : "all time"}
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
              <StatCard label="Settled" v={stats.overall.n} />
              <StatCard label="Win %" v={stats.overall.winPct != null ? pct(stats.overall.winPct) : "—"} good={stats.overall.winPct != null && stats.overall.winPct >= 0.524} />
              <StatCard label="Net (units)" v={`${stats.overall.net >= 0 ? "+" : ""}${stats.overall.net.toFixed(2)}u`} good={stats.overall.net >= 0} />
              <StatCard label="ROI" v={stats.overall.roi != null ? `${stats.overall.roi >= 0 ? "+" : ""}${(stats.overall.roi * 100).toFixed(1)}%` : "—"} good={stats.overall.roi != null && stats.overall.roi >= 0} />
            </div>
            <div className="text-[11px] text-slate-500 mb-3" style={mono}>
              record {stats.overall.w}-{stats.overall.l}{stats.overall.ps ? `-${stats.overall.ps}` : ""}{stats.overall.v ? ` · ${stats.overall.v} void` : ""} · {stats.overall.staked.toFixed(2)}u staked · {stats.openCount} open · break-even ≈ 52.4% at −110
            </div>
            <div className="text-[11px] mb-3 px-3 py-2 rounded-lg bg-slate-900/70 border border-slate-800" style={mono}>
              <span className="text-slate-500">strategy compare · </span>
              <span className="text-slate-300">staked: <span className={stats.overall.net >= 0 ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>{stats.overall.net >= 0 ? "+" : ""}{stats.overall.net.toFixed(2)}u</span> ({stats.overall.roi != null ? `${(stats.overall.roi * 100).toFixed(1)}%` : "—"} ROI)</span>
              <span className="text-slate-600"> vs </span>
              <span className="text-slate-300">flat 1u: <span className={stats.overall.flatNet >= 0 ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>{stats.overall.flatNet >= 0 ? "+" : ""}{stats.overall.flatNet.toFixed(2)}u</span> ({stats.overall.flatRoi != null ? `${(stats.overall.flatRoi * 100).toFixed(1)}%` : "—"} ROI)</span>
            </div>
            {Object.keys(stats.byType).length === 0 ? (
              <div className="text-sm text-slate-500 py-8 text-center">No settled bets yet. Track bets, then hit “Settle finished” after games end.</div>
            ) : (
              <div className="space-y-2">
                {STAT_ORDER.filter((t) => stats.byType[t]).map((t) => { const s = stats.byType[t]; return (
                  <div key={t} className="flex items-center gap-3 bg-slate-900/70 border border-slate-800 rounded-xl px-4 py-2.5 text-[12px]" style={mono}>
                    <div className="flex-1 font-semibold">{t}</div>
                    <div className="text-slate-400">{s.w}-{s.l}{s.ps ? `-${s.ps}` : ""}</div>
                    <div className="text-slate-300 w-16 text-right">{s.winPct != null ? pct(s.winPct) : "—"}</div>
                    <div className={`w-20 text-right font-bold ${s.net >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{s.net >= 0 ? "+" : ""}{s.net.toFixed(2)}u</div>
                  </div>); })}
              </div>
            )}
            <div className="mt-5 text-[11px] text-slate-600 leading-relaxed">
              Net/ROI use each bet’s unit stake; the flat-1u line shows what the same bets return at a flat stake, so you can see whether the ¼-Kelly suggestion actually beats flat. Kelly only helps if the model’s edges are real, so trust the comparison over many bets, not a handful. Once there’s a real sample, also compare win% by edge bucket to tune the priors (RECENT_WEIGHT, NB_PHI, shrinkage).
            </div>
          </div>
        )}
      </div>

      {/* DRAFT TRAY (manual bet) */}
      {draft && (
        <div className="fixed inset-x-0 bottom-0 bg-slate-900 border-t border-slate-700 z-30">
          <div className="max-w-5xl mx-auto px-4 py-3 flex flex-wrap items-end gap-3">
            <div className="text-sm font-bold">{draft.name} <span className="text-slate-500 text-[10px] font-normal">{meta.draftKindLabel(draft.ctxKind)} · manual</span></div>
            <Sel label="Type" v={draft.type} opts={sport.propsForKind(draft.ctxKind)} onChange={(v) => setDraft((p) => ({ ...p, type: v, line: DEFAULT_LINE[v] || "0.5" }))} />
            <NumIn label="Line" v={draft.line} onChange={(v) => setDraft((p) => ({ ...p, line: v }))} placeholder="0.5" />
            <Sel label="Side" v={draft.side} opts={["over", "under"]} onChange={(v) => setDraft((p) => ({ ...p, side: v }))} />
            <NumIn label="Odds" v={draft.odds} onChange={(v) => setDraft((p) => ({ ...p, odds: v }))} placeholder="-115" />
            <button onClick={addManualBet} className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm rounded px-3 py-1.5">Track bet</button>
            <button onClick={() => setDraft(null)} className="text-slate-400 hover:text-slate-200 text-sm">cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
