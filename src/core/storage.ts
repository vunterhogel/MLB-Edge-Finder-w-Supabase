/* Per-sport persistence (bets, credits, book overrides, board log in IndexedDB). EVERY sport uses this one
   module, so tracked bets, the board log and their exports behave identically sport to sport; only the
   key prefix differs, so sports never share data.
   createStorage("mlbef", ...) -> mlbef_mybets_v1, mlbef_boardlog_db, etc. (MLB's original keys). */
export function createStorage(prefix, MODEL_VERSION, DEFAULT_BOOK_OVERRIDES = {}) {
  const LS_BETS = `${prefix}_mybets_v1`;
  const LS_CREDITS = `${prefix}_credits_v1`;
  const LS_SHOW_COVERAGE = `${prefix}_showcoverage_v1`;
  const LS_BOOK_OVERRIDES = `${prefix}_bookoverrides_v1`;
  const LS_BOARD_LOG = `${prefix}_boardlog_v1`;
  const BOARD_LOG_MAX_ROWS = 300000;
  const BOARD_LOG_RETENTION_DAYS = 730;
  const BOARD_DB_NAME = `${prefix}_boardlog_db`;
  const BOARD_DB_STORE = "kv";
  const BOARD_DB_KEY = "boardLog";
  // every tracked bet carries its slate key in `date` (old NFL bets stored it as `week`)
  function loadBets() { try { return (JSON.parse(localStorage.getItem(LS_BETS)) || []).map((b) => (b && b.date == null && b.week != null ? { ...b, date: b.week } : b)); } catch { return []; } }
  function saveBets(b) { try { localStorage.setItem(LS_BETS, JSON.stringify(b)); } catch { /* storage unavailable */ } }
  function loadCredits() { try { const v = localStorage.getItem(LS_CREDITS); return v == null || v === "" ? null : +v; } catch { return null; } }
  function loadShowCoverage() { try { const v = localStorage.getItem(LS_SHOW_COVERAGE); return v == null ? false : v === "1"; } catch { return false; } }
  function saveShowCoverage(v) { try { localStorage.setItem(LS_SHOW_COVERAGE, v ? "1" : "0"); } catch { /* storage unavailable */ } }
  // per-market book overrides: some books (DraftKings, notably) frequently omit
  // specific prop markets from the-odds-api's feed — Home Run is the recurring
  // offender. Rather than switching the WHOLE board to another book just to see
  // that one market, each prop type can independently source its odds from a
  // different book than the main "book" selector. Defaults to ESPN BET for Home
  // Run (matching the workaround users were already doing by hand) and "same as
  // main book" for everything else.
  function loadBookOverrides() { try { const v = JSON.parse(localStorage.getItem(LS_BOOK_OVERRIDES)); return v && typeof v === "object" ? v : { ...DEFAULT_BOOK_OVERRIDES }; } catch { return { ...DEFAULT_BOOK_OVERRIDES }; } }
  function saveBookOverrides(o) { try { localStorage.setItem(LS_BOOK_OVERRIDES, JSON.stringify(o)); } catch { /* storage unavailable */ } }

  /* ---- Board Snapshot Logger ----
   * Logs EVERY board candidate (not just tracked bets) on each board load.
   * This is the foundational data layer for calibration analysis, CLV measurement,
   * and training residual models. Without full-board logging we only have selection-
   * biased data from manually tracked bets, which is useless for model evaluation.
   *
   * Schema: one row per (player × prop type × line × side × slate × model version).
   * Settlement update: when settleBets() runs, actual results are written back.
   * Retention: last 730 days / 300k rows, enforced on every append.
   */

  /* Board log storage: IndexedDB (localStorage's ~5MB quota silently dropped rows past ~10.5k).
     An in-memory cache keeps all readers synchronous; writes persist async to IndexedDB. */

  let boardLogCache = [];
  let boardLogSaveError = null; // surfaced in UI — never silently drop data again

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(BOARD_DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(BOARD_DB_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGet(key) {
    const db = await idbOpen();
    try {
      return await new Promise((resolve, reject) => {
        const req = db.transaction(BOARD_DB_STORE, "readonly").objectStore(BOARD_DB_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally { db.close(); }
  }
  async function idbSet(key, val) {
    const db = await idbOpen();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(BOARD_DB_STORE, "readwrite");
        tx.objectStore(BOARD_DB_STORE).put(val, key);
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
      });
    } finally { db.close(); }
  }
  async function idbDel(key) {
    const db = await idbOpen();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(BOARD_DB_STORE, "readwrite");
        tx.objectStore(BOARD_DB_STORE).delete(key);
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }

  // One-time init: load from IndexedDB; if empty, migrate any legacy localStorage log.
  const boardLogReady = (async () => {
    try {
      let rows = await idbGet(BOARD_DB_KEY);
      if (!Array.isArray(rows) || !rows.length) {
        try {
          const legacy = JSON.parse(localStorage.getItem(LS_BOARD_LOG) || "null");
          if (Array.isArray(legacy) && legacy.length) {
            rows = legacy;
            await idbSet(BOARD_DB_KEY, rows);
            localStorage.removeItem(LS_BOARD_LOG); // frees ~5MB of localStorage quota
          }
        } catch { /* corrupted legacy data — start fresh */ }
      }
      boardLogCache = Array.isArray(rows) ? rows : [];
    } catch (err) {
      boardLogSaveError = `Board log storage unavailable: ${String((err && err.message) || err)}`;
    }
    return boardLogCache;
  })();

  function loadBoardLog() {
    return boardLogCache;
  }
  function saveBoardLog(log) {
    boardLogCache = log;
    idbSet(BOARD_DB_KEY, log)
      .then(() => { boardLogSaveError = null; })
      .catch((err) => { boardLogSaveError = `Board log save FAILED: ${String((err && err.message) || err)}`; });
  }
  function resetBoardLogCache() { boardLogCache = []; }
  function getBoardLogSaveError() {
    return boardLogSaveError;
  }
  /* ---- one board-log row schema for every sport ----
     logId = `${slate}|${modelVersion}|${betId}`: the slate key (a date for MLB/NBA/NHL, a week key like
     "2026-2-8" for NFL) plus the model version, so a new model version logs its own snapshot of the same
     bet next to the old one (champion/challenger on identical games) instead of being deduped away.
     Older rows keep the ids they were written with; dedupe reads both forms so the switch never logs a
     duplicate. `date` always holds the slate key (old NFL rows stored it as `week`). */
  const slateOf = (row) => (row.date ?? row.week ?? "");
  function dedupeKey(row) {
    const parts = String(row.logId || "").split("|");
    if (parts.length >= 3) return row.logId;                       // already slate|version|bet
    return `${slateOf(row)}|${row.modelVersion || ""}|${parts[parts.length - 1]}`; // legacy slate|bet
  }
  async function appendBoardLog(entries, modelVersion, slate) {
    if (!entries || !entries.length) return;
    await boardLogReady; // never append before the persisted log has loaded
    const existing = loadBoardLog();
    const existingByKey = new Map(existing.map((e) => [dedupeKey(e), e]));
    const now = new Date().toISOString();
    const cutoffMs = Date.now() - BOARD_LOG_RETENTION_DAYS * 86400000;

    // Rows freeze at first-seen (that's what makes them useful for calibration/CLV research), so a
    // field added after a bet was first logged (gameTimeIso) can only reach the row by this backfill.
    // Never the frozen calibration numbers.
    let backfilled = 0;
    for (const e of entries) {
      const already = existingByKey.get(`${slate}|${modelVersion}|${e.id}`);
      if (already && !already.gameTimeIso && e.gameTimeIso) { already.gameTimeIso = e.gameTimeIso; backfilled++; }
    }

    const newRows = entries
      .filter((e) => e.modelP != null && e.novig != null)
      .map((e) => ({
        logId: `${slate}|${modelVersion}|${e.id}`,
        loggedAt: now,
        modelVersion,
        date: slate,
        // market
        game: e.game,
        gameTimeIso: e.gameTimeIso || null,
        gamePk: String(e.gamePk),
        playerId: String(e.playerId ?? ""),
        name: e.name,
        type: e.type,
        line: e.line,
        side: e.side,
        odds: e.odds,
        novig: e.novig != null ? +e.novig.toFixed(4) : null,
        // model
        rawModelP: e.rawModelP != null ? +e.rawModelP.toFixed(4) : null,
        calibratedP: e.modelP != null ? +e.modelP.toFixed(4) : null,
        edge: e.edge != null ? +e.edge.toFixed(4) : null,
        ev: e.ev != null ? +e.ev.toFixed(4) : null,
        proj: e.proj != null ? +e.proj.toFixed(3) : null,
        // snapshot context
        live: !!(e.calc && (e.calc.live || /live/i.test(String(e.calc.dist || "")))),
        preStart: e.gameTimeIso ? Date.parse(now) < Date.parse(e.gameTimeIso) : null,
        suppressed: e.suppressNote || (e.outsSanityFailed ? "stale IP data" : null), // edge forced to market by a sanity gate
        // settlement (filled later)
        settled: false,
        actualStat: null,
        result: null,        // "won" | "lost" | "push" | "void"
        closingNovig: null,  // from refreshLines() when bet started
        clv: null,           // closingNovig - novig (positive = we beat the close)
      }))
      .filter((e) => !existingByKey.has(e.logId));

    if (!newRows.length) { if (backfilled) saveBoardLog(existing); return; }

    // Merge, apply retention window, enforce row cap
    const merged = [...existing, ...newRows]
      .filter((e) => {
        try { return Date.parse(e.loggedAt) >= cutoffMs; } catch { return true; }
      });
    saveBoardLog(merged.length > BOARD_LOG_MAX_ROWS ? merged.slice(-BOARD_LOG_MAX_ROWS) : merged);
  }
  async function settleBoardLog(settledBets) {
    // Called after settleBets() resolves; writes actual results back into board log rows.
    if (!settledBets || !settledBets.length) return;
    await boardLogReady;
    const log = loadBoardLog();
    if (!log.length) return;
    // Build lookup: slate|gamePk|playerId|type|line|side -> { actual, status }
    const lookup = {};
    for (const b of settledBets) {
      if (b.status === "open") continue;
      const key = `${slateOf(b)}|${b.gamePk}|${b.playerId}|${b.type}|${b.line}|${b.side}`;
      lookup[key] = { actual: b.actual, result: b.status };
    }
    let changed = false;
    const updated = log.map((e) => {
      if (e.settled) return e;
      const key = `${slateOf(e)}|${e.gamePk}|${e.playerId}|${e.type}|${e.line}|${e.side}`;
      const hit = lookup[key];
      if (!hit) return e;
      changed = true;
      return { ...e, settled: true, actualStat: hit.actual, result: hit.result };
    });
    if (changed) saveBoardLog(updated);
  }

  return { MODEL_VERSION, LS_BETS, LS_CREDITS, LS_BOARD_LOG, BOARD_DB_KEY, loadBets, saveBets, loadCredits, loadShowCoverage, saveShowCoverage, loadBookOverrides, saveBookOverrides, idbDel, boardLogReady, loadBoardLog, saveBoardLog, resetBoardLogCache, getBoardLogSaveError, appendBoardLog, settleBoardLog };
}
