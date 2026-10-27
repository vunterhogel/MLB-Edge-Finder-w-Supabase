/* Hub access to every sport's tracked bets (each sport stays in its own store and storage key). */
import { useSyncExternalStore } from "react";
import { getBets, setBets, subscribeBets } from "../core/betStore";
import { HUB_SPORTS } from "./sports";

// { mlb: bets[], nfl: bets[], nba: bets[], nhl: bets[] }, re-rendering when any sport's bets change
export function useHubBets() {
  const out = {};
  for (const s of HUB_SPORTS) {
    // fixed list and order, so calling the hook in this loop is stable across renders
    // eslint-disable-next-line react-hooks/rules-of-hooks
    out[s.id] = useSyncExternalStore((fn) => subscribeBets(s.sport, fn), () => getBets(s.sport));
  }
  return out;
}
export const setSportBets = (id, next) => setBets(HUB_SPORTS.find((s) => s.id === id).sport, next);

// the bets in scope for a sport filter, tagged with their sport. One sport: that sport's list in its own
// order (exactly what its My Bets tab showed). All: every sport merged, newest slate date first.
export function scopedBets(all, sportFilter) {
  const tag = (id) => all[id].map((b) => ({ ...b, _sport: id }));
  if (sportFilter !== "all") return tag(sportFilter);
  const merged = HUB_SPORTS.flatMap((s) => tag(s.id));
  return merged
    .map((b, i) => [b, i])
    .sort((x, y) => String(y[0].date || "").localeCompare(String(x[0].date || "")) || x[1] - y[1])
    .map(([b]) => b);
}
