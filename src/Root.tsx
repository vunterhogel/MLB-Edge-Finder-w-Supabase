import React, { useState } from "react";
import MLBApp from "./App";
import NFLApp from "./nfl/NFLApp";

/* Root — the ONLY new top-level wiring this integration needs (see INTEGRATION.md).
   A tiny sport switcher above the existing MLB app; MLB's App.tsx is untouched. */
export default function Root() {
  const [sport, setSport] = useState<"mlb" | "nfl">("mlb");
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
      </div>
      {sport === "mlb" ? <MLBApp /> : <NFLApp />}
    </div>
  );
}
