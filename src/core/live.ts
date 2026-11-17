/* What each sport page has loaded right now, shared with the rest of the app.
     slate: the date and games on screen (memory only), so the hub's Today page can read them.
     board: the odds pulled for one date. Kept in memory and in this browser tab's session storage, so a
            Refresh or a page reload does not throw away odds that cost credits to pull.
   Session storage is separate from where bets are saved, so a full cache can never crowd them out. */
import { useSyncExternalStore } from "react";

const KEY = (id) => `ef_board_cache_v1_${id}`;
const slates = {};   // sport id -> { date, games }
const boards = {};   // sport id -> { date, book, board: { pk: entries[] }, coverage, pulledAt: { pk: iso } }
const subs = new Set();
let version = 0;
const bump = () => { version++; subs.forEach((f) => f()); };

// entries carry the model context they were priced from; it is large and nothing reads it afterwards
const slim = (board) => Object.fromEntries(Object.entries(board).map(([pk, list]) => [pk, list.map(({ ctx: _ctx, ...e }) => e)]));

export function getBoard(id) {
  if (boards[id] === undefined) {
    try { boards[id] = JSON.parse(sessionStorage.getItem(KEY(id)) || "null"); } catch { boards[id] = null; }
  }
  return boards[id];
}
export function saveBoard(id, rec) {
  boards[id] = rec;
  try { sessionStorage.setItem(KEY(id), JSON.stringify({ ...rec, board: slim(rec.board) })); }
  catch { try { sessionStorage.removeItem(KEY(id)); } catch { /* storage unavailable */ } }   // too big to keep through a reload; memory still has it
  bump();
}
export function clearBoard(id) {
  boards[id] = null;
  try { sessionStorage.removeItem(KEY(id)); } catch { /* storage unavailable */ }
  bump();
}
export const getSlate = (id) => slates[id] || null;
export function setSlate(id, rec) { slates[id] = rec; bump(); }
export function clearAllLive(ids) { for (const id of ids) { delete slates[id]; clearBoard(id); } }
// re-render when any sport's slate or board changes
export function useLive() { return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => version); }

// odds credits left, as last reported by any odds call (every sport shares one odds account)
let credits = null;
export const getCredits = () => credits;
export function setLiveCredits(n) { if (n == null || n === credits) return; credits = n; bump(); }

// the tracked-bet record for a board play: one shape, used by every page that can track
export function betFromEntry(e, date, units, suggested, live) {
  return { key: e.id, date, gamePk: e.gamePk, game: e.game, playerId: e.playerId, name: e.name, type: e.type, line: e.line, side: e.side, odds: e.odds, book: e.book, modelP: e.modelP, proj: e.proj, novig: e.novig, units, suggested, status: "open", actual: null, live };
}
