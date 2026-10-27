/* Shared tracked-bet store, one per sport. The sport page and the hub (My Bets / My Stats) read and
   change the SAME bets through it, so neither can overwrite the other with a stale copy.
   Storage is unchanged: each sport's bets stay under its own key (mlbef_mybets_v1, nfief_..., etc.),
   loaded and saved with that sport's storage module. Every change is saved immediately and settled
   results are written back into that sport's board log, exactly what the sport page used to do
   after each change. */
import { useSyncExternalStore } from "react";

const stores = new Map(); // sport.id -> { bets, listeners }

function storeFor(sport) {
  let s = stores.get(sport.id);
  if (!s) {
    s = { bets: sport.storage.loadBets(), listeners: new Set() };
    stores.set(sport.id, s);
    // the sport page used to run this once on mount with the loaded bets; same here, once per store
    void sport.storage.settleBoardLog(s.bets);
  }
  return s;
}

export function getBets(sport) { return storeFor(sport).bets; }

// same contract as a React state setter: a new array, or an updater (prev) => next
export function setBets(sport, next) {
  const s = storeFor(sport);
  const value = typeof next === "function" ? next(s.bets) : next;
  if (value === s.bets) return;
  s.bets = value;
  sport.storage.saveBets(value);
  void sport.storage.settleBoardLog(value);
  for (const fn of s.listeners) fn();
}

export function subscribeBets(sport, fn) {
  const s = storeFor(sport);
  s.listeners.add(fn);
  return () => s.listeners.delete(fn);
}

// React hook: [bets, setBets] for one sport, kept in sync across every page using it
export function useBets(sport) {
  const bets = useSyncExternalStore((fn) => subscribeBets(sport, fn), () => getBets(sport));
  return [bets, (next) => setBets(sport, next)];
}
