/* NFL persistence for the shared shell.
   Uses the shared createStorage with the SAME keys the old NFL page used (nfief_mybets_v1,
   nfief_credits_v1, IndexedDB nfief_boardlog_db), so existing tracked bets and the board log carry
   over untouched. Two NFL-specific differences from the shared logger are kept on purpose:
     - board-log ids are `${weekKey}|${modelVersion}|${betId}` and rows carry `week`, `preStart` and
       `roleCheck` (the old NFL schema; the Parlay Builder and calibration exports read `week`);
     - old tracked bets stored their slate as `week`; the shell reads `date`, so bets are normalized on
       load (date = week). Nothing is rewritten in place until the next save. */
import { createStorage } from "../../core/storage";

export const MODEL_VERSION = "nfl-v2-2026-10-18";

const BOARD_LOG_MAX_ROWS = 300000;
const BOARD_LOG_RETENTION_DAYS = 730;

const base = createStorage("nfief", MODEL_VERSION, {});

function loadBets() {
  return base.loadBets().map((b) => (b && b.date == null && b.week != null ? { ...b, date: b.week } : b));
}

// logId has no timestamp component (it's deterministic per week+version+bet), so a bet already
// logged this week is frozen at its first-seen snapshot rather than overwritten on every refresh.
// The only exception is metadata that didn't exist when the row was first logged (gameTimeIso).
async function appendBoardLog(entries, modelVersion, weekKey) {
  if (!entries || !entries.length) return;
  await base.boardLogReady;
  const existing = base.loadBoardLog();
  const existingIds = new Set(existing.map((e) => e.logId));
  const now = new Date().toISOString();
  const cutoffMs = Date.now() - BOARD_LOG_RETENTION_DAYS * 86400000;
  const existingById = new Map(existing.map((e) => [e.logId, e]));
  let backfilled = 0;
  for (const e of entries) {
    const already = existingById.get(`${weekKey}|${modelVersion}|${e.id}`);
    if (already && !already.gameTimeIso && e.gameTimeIso) { already.gameTimeIso = e.gameTimeIso; backfilled++; }
  }
  const newRows = entries.filter((e) => e.modelP != null && e.novig != null).map((e) => {
    const logId = `${weekKey}|${modelVersion}|${e.id}`;
    return {
      logId, loggedAt: now, modelVersion, week: weekKey,
      preStart: e.gameTimeIso ? Date.parse(now) < Date.parse(e.gameTimeIso) : null,
      roleCheck: !!e.roleCheck,
      game: e.game, gameTimeIso: e.gameTimeIso || null, gamePk: String(e.gamePk), playerId: String(e.playerId ?? ""), name: e.name, type: e.type, line: e.line, side: e.side, odds: e.odds,
      novig: e.novig != null ? +e.novig.toFixed(4) : null, rawModelP: e.rawModelP != null ? +e.rawModelP.toFixed(4) : null,
      calibratedP: e.modelP != null ? +e.modelP.toFixed(4) : null, edge: e.edge != null ? +e.edge.toFixed(4) : null, ev: e.ev != null ? +e.ev.toFixed(4) : null, proj: e.proj != null ? +e.proj.toFixed(3) : null,
      settled: false, actualStat: null, result: null,
    };
  }).filter((e) => !existingIds.has(e.logId));
  if (!newRows.length) { if (backfilled) base.saveBoardLog(existing); return; }
  const merged = [...existing, ...newRows].filter((e) => { try { return Date.parse(e.loggedAt) >= cutoffMs; } catch { return true; } });
  base.saveBoardLog(merged.length > BOARD_LOG_MAX_ROWS ? merged.slice(-BOARD_LOG_MAX_ROWS) : merged);
}

// tracked bets that settle write their result back into matching board-log rows
async function settleBoardLog(settledBets) {
  if (!settledBets || !settledBets.length) return;
  await base.boardLogReady;
  const log = base.loadBoardLog();
  if (!log.length) return;
  const lookup = {};
  for (const b of settledBets) {
    if (b.status === "open") continue;
    lookup[`${b.date ?? b.week}|${b.gamePk}|${b.playerId}|${b.type}|${b.line}|${b.side}`] = { actual: b.actual, result: b.status };
  }
  let changed = false;
  const updated = log.map((e) => {
    if (e.settled) return e;
    const hit = lookup[`${e.week ?? e.date}|${e.gamePk}|${e.playerId}|${e.type}|${e.line}|${e.side}`];
    if (!hit) return e;
    changed = true;
    return { ...e, settled: true, actualStat: hit.actual, result: hit.result };
  });
  if (changed) base.saveBoardLog(updated);
}

export const storage = { ...base, MODEL_VERSION, loadBets, appendBoardLog, settleBoardLog };
