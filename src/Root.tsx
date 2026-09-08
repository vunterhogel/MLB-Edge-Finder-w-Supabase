import React, { useState } from "react";
import MLBApp from "./App";
import NFLApp from "./nfl/NFLApp";
import NBAApp from "./nba/NBAApp";
import ParlayBuilder from "./parlay/ParlayBuilder";

/* Root — the ONLY new top-level wiring the NFL/NBA integrations needed (see
   INTEGRATION.md / NBA_INTEGRATION.md). A tiny sport switcher above the existing
   apps; MLB's App.tsx and NFL's NFLApp.tsx are untouched by the NBA addition.
   Parlay Builder is a 4th, sport-agnostic tab — it doesn't touch any of the
   three app files either, it just reads the CSVs they already export. */
export default function Root() {
  const [sport, setSport] = useState<"mlb" | "nfl" | "nba" | "parlay">("mlb");
  return (
    <div>
      <div className="flex gap-1 p-2 bg-slate-950 border-b border-slate-800">
        <button
          onClick={() => setSport("mlb")}
          className={`px-3 py-1.5 rounded text-xs font-bold ${sport === "mlb" ? "bg-emerald-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
        >⚾ MLB Edge Finder</button>
        <button
          onClick={() => setSport("nfl")}
          className={`px-3 py-1.5 rounded text-xs font-bold ${sport === "nfl" ? "bg-emerald-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
        >🏈 NFL Edge Finder</button>
        <button
          onClick={() => setSport("nba")}
          className={`px-3 py-1.5 rounded text-xs font-bold ${sport === "nba" ? "bg-emerald-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
        >🏀 NBA Edge Finder</button>
        <button
          onClick={() => setSport("parlay")}
          className={`px-3 py-1.5 rounded text-xs font-bold ${sport === "parlay" ? "bg-emerald-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
        >🧩 Parlay Builder</button>
      </div>
      {sport === "mlb" ? <MLBApp /> : sport === "nfl" ? <NFLApp /> : sport === "nba" ? <NBAApp /> : <ParlayBuilder />}
    </div>
  );
}