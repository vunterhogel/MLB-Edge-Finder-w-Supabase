/* Board log actions shared by each sport's Model page and the hub's Today page: grade every logged play
   against final results, download the log as a CSV, and clear it. Moved out of the SportApp shell
   unchanged, so every page runs the same code. */

// Grades EVERY board log candidate for every finished game, not just tracked bets. Uses the sport's free
// stats API (no odds credits). -> { graded, games, settled, total, message }
export async function settleBoardLog(sport, onProgress = null) {
  const { boardLogReady, loadBoardLog, saveBoardLog } = sport.storage;
  const { fetchGameResult } = sport.api;
  const isLineType = sport.config.isLineType;
  await boardLogReady;
  const log = loadBoardLog();
  const unsettled = log.filter((e) => !e.settled);
  if (!unsettled.length) return { graded: 0, games: 0, settled: log.length, total: log.length, message: "Everything in the log is already settled." };
  const pks = [...new Set(unsettled.map((e) => e.gamePk))];
  if (onProgress) onProgress(`Fetching results for ${pks.length} game${pks.length === 1 ? "" : "s"}`);
  const results = {};
  for (const pk of pks) results[pk] = await fetchGameResult(Number(pk));
  if (sport.augmentResults) await sport.augmentResults(unsettled, results);
  let graded = 0;
  const updated = log.map((e) => {
    if (e.settled) return e;
    const res = results[e.gamePk];
    if (res && res.canceled) { graded++; return { ...e, settled: true, actualStat: null, result: "void" }; }
    if (!res || !res.final) return e; // game still in progress: leave unsettled
    // game lines (moneyline / total / spread)
    if (isLineType(e.type)) {
      const { status, actual } = sport.gradeLineResult(e.type, e.side, parseFloat(e.line || "0"), res);
      if (!status) return e;
      graded++;
      return { ...e, settled: true, actualStat: actual, result: status };
    }
    // player props: did not play -> void; otherwise graded off the box score
    const r = sport.gradeLogProp(e, res);
    if (r == null) return e;
    graded++;
    return { ...e, settled: true, actualStat: r.actual, result: r.status };
  });
  saveBoardLog(updated);
  const settled = updated.filter((e) => e.settled).length;
  return { graded, games: pks.length, settled, total: updated.length, message: `Graded ${graded.toLocaleString()} logged play${graded === 1 ? "" : "s"} across ${pks.length} game${pks.length === 1 ? "" : "s"}. ${settled.toLocaleString()} of ${updated.length.toLocaleString()} are now settled.` };
}

// Every candidate ever shown on the board, as a CSV download. -> false when the log is empty
export function downloadBoardLogCsv(sport) {
  const log = sport.storage.loadBoardLog();
  if (!log.length) return false;
  const esc = (v) => { if (v == null) return ""; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const headers = ["logId","loggedAt","modelVersion","date","game","gameTimeIso","gamePk","playerId","name","type","line","side","odds","novig","rawModelP","calibratedP","edge","ev","proj","settled","actualStat","result","closingNovig","clv","live","tag"];
  const rows = [headers.join(",")];
  for (const e of log) {
    rows.push([
      esc(e.logId), esc(e.loggedAt), esc(e.modelVersion), esc(e.date),
      esc(e.game), esc(e.gameTimeIso), esc(e.gamePk), esc(e.playerId), esc(e.name),
      esc(e.type), esc(e.line), esc(e.side), esc(e.odds),
      e.novig ?? "", e.rawModelP ?? "", e.calibratedP ?? "",
      e.edge ?? "", e.ev ?? "", e.proj ?? "",
      e.settled ? "true" : "false",
      e.actualStat ?? "", esc(e.result), e.closingNovig ?? "", e.clv ?? "", e.live == null ? "" : (e.live ? "true" : "false"), esc(e.tag),
    ].join(","));
  }
  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url; a.download = `${sport.meta.boardLogCsvPrefix}-${stamp}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

export function clearBoardLog(sport) {
  const { resetBoardLogCache, idbDel, BOARD_DB_KEY, LS_BOARD_LOG } = sport.storage;
  resetBoardLogCache();
  void idbDel(BOARD_DB_KEY);
  try { localStorage.removeItem(LS_BOARD_LOG); } catch { /* ignore */ }
}
