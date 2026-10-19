/* ---------------------- persistence ---------------------- */
// Bump MODEL_VERSION whenever a structural change is made to the prediction engine.
// Every board log entry is tagged with this string so historical CSV exports remain
// stratifiable by model version for calibration analysis.
// Bump on EVERY model change so board-log rows can be segmented by the model that produced them.
// (v4.2 label was never bumped through the Jul-Sep calibration edits; v4.3 marks rows from 2026-10-18 on.)
export const MODEL_VERSION = "v4.3-2026-10-18";
export const LS_BETS = "mlbef_mybets_v1";
export function loadBets() { try { return JSON.parse(localStorage.getItem(LS_BETS)) || []; } catch { return []; } }
export function saveBets(b) { try { localStorage.setItem(LS_BETS, JSON.stringify(b)); } catch { /* storage unavailable */ } }
export const LS_CREDITS = "mlbef_credits_v1";
export function loadCredits() { try { const v = localStorage.getItem(LS_CREDITS); return v == null || v === "" ? null : +v; } catch { return null; } }
export const LS_SHOW_COVERAGE = "mlbef_showcoverage_v1";
export function loadShowCoverage() { try { const v = localStorage.getItem(LS_SHOW_COVERAGE); return v == null ? false : v === "1"; } catch { return false; } }
export function saveShowCoverage(v) { try { localStorage.setItem(LS_SHOW_COVERAGE, v ? "1" : "0"); } catch { /* storage unavailable */ } }
// per-market book overrides: some books (DraftKings, notably) frequently omit
// specific prop markets from the-odds-api's feed — Home Run is the recurring
// offender. Rather than switching the WHOLE board to another book just to see
// that one market, each prop type can independently source its odds from a
// different book than the main "book" selector. Defaults to ESPN BET for Home
// Run (matching the workaround users were already doing by hand) and "same as
// main book" for everything else.
export const LS_BOOK_OVERRIDES = "mlbef_bookoverrides_v1";
export const DEFAULT_BOOK_OVERRIDES = { "Home Run": "espnbet" };
export function loadBookOverrides() { try { const v = JSON.parse(localStorage.getItem(LS_BOOK_OVERRIDES)); return v && typeof v === "object" ? v : { ...DEFAULT_BOOK_OVERRIDES }; } catch { return { ...DEFAULT_BOOK_OVERRIDES }; } }
export function saveBookOverrides(o) { try { localStorage.setItem(LS_BOOK_OVERRIDES, JSON.stringify(o)); } catch { /* storage unavailable */ } }

/* ---- Board Snapshot Logger ----
 * Logs EVERY board candidate (not just tracked bets) on each board load.
 * This is the foundational data layer for calibration analysis, CLV measurement,
 * and training residual models. Without full-board logging we only have selection-
 * biased data from manually tracked bets, which is useless for model evaluation.
 *
 * Schema: one row per (player × prop type × line × side × date).
 * Settlement update: when settleBets() runs, actual results are written back.
 * Retention: last 60 days / 100k rows, enforced on every append.
 */
export const LS_BOARD_LOG = "mlbef_boardlog_v1"; // legacy localStorage key (auto-migrated to IndexedDB)
export const BOARD_LOG_MAX_ROWS = 300000;
export const BOARD_LOG_RETENTION_DAYS = 730; // was 60: everything before Sep 8 had already aged out of the research log

/* Board log storage: IndexedDB (localStorage's ~5MB quota silently dropped rows past ~10.5k).
   An in-memory cache keeps all readers synchronous; writes persist async to IndexedDB. */
export const BOARD_DB_NAME = "mlbef_boardlog_db";
export const BOARD_DB_STORE = "kv";
export const BOARD_DB_KEY = "boardLog";

export let boardLogCache = [];
export let boardLogSaveError = null; // surfaced in UI — never silently drop data again

export function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BOARD_DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(BOARD_DB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function idbGet(key) {
  const db = await idbOpen();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(BOARD_DB_STORE, "readonly").objectStore(BOARD_DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}
export async function idbSet(key, val) {
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
export async function idbDel(key) {
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
export const boardLogReady = (async () => {
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

export function loadBoardLog() {
  return boardLogCache;
}
export function saveBoardLog(log) {
  boardLogCache = log;
  idbSet(BOARD_DB_KEY, log)
    .then(() => { boardLogSaveError = null; })
    .catch((err) => { boardLogSaveError = `Board log save FAILED: ${String((err && err.message) || err)}`; });
}
export function resetBoardLogCache() { boardLogCache = []; }
export function getBoardLogSaveError() {
  return boardLogSaveError;
}
export async function appendBoardLog(entries, modelVersion, date) {
  if (!entries || !entries.length) return;
  await boardLogReady; // never append before the persisted log has loaded
  const existing = loadBoardLog();
  const existingIds = new Set(existing.map((e) => e.logId));
  const now = new Date().toISOString();
  const cutoffMs = Date.now() - BOARD_LOG_RETENTION_DAYS * 86400000;
  const existingById = new Map(existing.map((e) => [e.logId, e]));

  // logId is deterministic (date + game + player + market + line + side, no timestamp) BY
  // DESIGN — once a bet is logged today, its model%/novig/edge/EV snapshot is meant to freeze
  // at first-seen, not get overwritten on every board refresh (that's what makes it useful for
  // calibration/CLV research later). But that means a field added AFTER a bet was already
  // logged today (gameTimeIso, added for the Parlay Builder's kickoff filter) can never reach
  // an already-logged row through the normal "new row" path below — it'd just get silently
  // deduped away forever. Backfill ONLY that kind of previously-missing metadata in place,
  // never the frozen calibration numbers.
  let backfilled = 0;
  for (const e of entries) {
    const already = existingById.get(`${date}|${e.id}`);
    if (already && !already.gameTimeIso && e.gameTimeIso) { already.gameTimeIso = e.gameTimeIso; backfilled++; }
  }

  const newRows = entries
    .filter((e) => e.modelP != null && e.novig != null)
    .map((e) => {
      const logId = `${date}|${e.id}`;
      return {
        logId,
        loggedAt: now,
        modelVersion,
        date,
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
        // in-game snapshot? (live and pregame rows were previously indistinguishable in the log)
        live: !!(e.calc && (e.calc.live || /live/i.test(String(e.calc.dist || "")))),
        // settlement (filled later)
        settled: false,
        actualStat: null,
        result: null,        // "won" | "lost" | "push" | "void"
        closingNovig: null,  // from refreshLines() when bet started
        clv: null,           // closingNovig - novig (positive = we beat the close)
      };
    })
    .filter((e) => !existingIds.has(e.logId));

  if (!newRows.length) { if (backfilled) saveBoardLog(existing); return; }

  // Merge, apply retention window, enforce row cap
  const merged = [...existing, ...newRows]
    .filter((e) => {
      try { return Date.parse(e.loggedAt) >= cutoffMs; } catch { return true; }
    });
  saveBoardLog(merged.length > BOARD_LOG_MAX_ROWS ? merged.slice(-BOARD_LOG_MAX_ROWS) : merged);
}
export async function settleBoardLog(settledBets) {
  // Called after settleBets() resolves; writes actual results back into board log rows.
  if (!settledBets || !settledBets.length) return;
  await boardLogReady;
  const log = loadBoardLog();
  if (!log.length) return;
  // Build lookup: date|gamePk|playerId|type|line|side -> { actual, status }
  const lookup = {};
  for (const b of settledBets) {
    if (b.status === "open") continue;
    const key = `${b.date}|${b.gamePk}|${b.playerId}|${b.type}|${b.line}|${b.side}`;
    lookup[key] = { actual: b.actual, result: b.status };
  }
  let changed = false;
  const updated = log.map((e) => {
    if (e.settled) return e;
    const key = `${e.date}|${e.gamePk}|${e.playerId}|${e.type}|${e.line}|${e.side}`;
    const hit = lookup[key];
    if (!hit) return e;
    changed = true;
    return { ...e, settled: true, actualStat: hit.actual, result: hit.result };
  });
  if (changed) saveBoardLog(updated);
}
