import React, { useEffect, useState } from "react";
import MLBApp from "./App";
import NFLApp from "./sports/nfl/Page";
import NBAApp from "./sports/nba/Page";
import NHLApp from "./sports/nhl/Page";
import ParlayBuilder from "./parlay/ParlayBuilder";
import { useRoute } from "./core/route";

/* Root: the app frame. A sidebar (a slide-out menu on phones) switches pages, and the page address
   (#/mlb/board, #/parlay) says which page is showing. Every sport renders through the shared
   SportApp shell. A page stays mounted after its first visit and is only hidden when you switch
   away, so a loaded slate and pulled odds survive switching sports. */
const NAV = [
  { section: "HUB", items: [{ page: "parlay", label: "Parlay Builder", icon: "🧩" }] },
  { section: "EDGE FINDER", items: [
    { page: "mlb", label: "MLB", icon: "⚾" },
    { page: "nfl", label: "NFL", icon: "🏈" },
    { page: "nba", label: "NBA", icon: "🏀" },
    { page: "nhl", label: "NHL", icon: "🏒" },
  ] },
];
const LABEL = Object.fromEntries(NAV.flatMap((s) => s.items).map((i) => [i.page, i]));
const TAB_LABEL = { slate: "Slate", board: "Board", trends: "Trends", analysis: "Player Analysis", mybets: "My Bets", stats: "Stats" };

function Sidebar({ route, navigate, onPick }) {
  return (
    <nav className="flex flex-col h-full">
      <div className="px-4 pt-5 pb-4 border-b border-slate-800">
        <div className="text-lg font-black tracking-tight leading-none"><span className="text-emerald-400">EDGE</span> FINDER</div>
      </div>
      <div className="flex-1 overflow-y-auto py-3">
        {NAV.map((s) => (
          <div key={s.section} className="mb-4">
            <div className="px-4 mb-1 text-[10px] font-bold tracking-wider text-slate-500">{s.section}</div>
            {s.items.map((i) => {
              const active = route.page === i.page;
              return (
                <button
                  key={i.page}
                  onClick={() => { navigate(i.page); onPick && onPick(); }}
                  className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm font-semibold text-left border-l-2 ${active ? "border-emerald-400 bg-slate-900 text-emerald-400" : "border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-900/60"}`}
                >
                  <span className="w-5 text-center">{i.icon}</span>{i.label}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}

export default function Root() {
  const [route, navigate] = useRoute();
  const [visited, setVisited] = useState(() => new Set([route.page]));
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => { setVisited((v) => (v.has(route.page) ? v : new Set([...v, route.page]))); }, [route.page]);
  useEffect(() => {
    const i = LABEL[route.page];
    document.title = `Edge Finder · ${i ? i.label : ""}${route.tab ? ` · ${TAB_LABEL[route.tab] || route.tab}` : ""}`;
  }, [route]);

  const page = (key, el) => (visited.has(key) ? <div key={key} className={route.page === key ? "" : "hidden"}>{el}</div> : null);
  const tabProps = (key) => ({ tab: route.page === key ? route.tab : null, onTabChange: (t) => navigate(key, t) });
  const cur = LABEL[route.page];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 md:flex">
      {/* desktop sidebar */}
      <aside className="hidden md:block w-52 shrink-0 bg-slate-950 border-r border-slate-800 sticky top-0 h-screen z-20">
        <Sidebar route={route} navigate={navigate} />
      </aside>
      {/* phone: top bar (scrolls away so the sport page's own sticky header keeps the top) + slide-out menu */}
      <div className="md:hidden flex items-center gap-3 px-3 py-2 border-b border-slate-800 bg-slate-950">
        <button onClick={() => setMenuOpen(true)} className="text-slate-300 text-xl leading-none px-1" aria-label="Open menu">☰</button>
        <div className="text-sm font-bold">{cur ? `${cur.icon} ${cur.label}` : ""}</div>
      </div>
      {menuOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div className="w-60 bg-slate-950 border-r border-slate-800 h-full"><Sidebar route={route} navigate={navigate} onPick={() => setMenuOpen(false)} /></div>
          <div className="flex-1 bg-black/60" onClick={() => setMenuOpen(false)} />
        </div>
      )}
      <main className="flex-1 min-w-0">
        {page("mlb", <MLBApp {...tabProps("mlb")} />)}
        {page("nfl", <NFLApp {...tabProps("nfl")} />)}
        {page("nba", <NBAApp {...tabProps("nba")} />)}
        {page("nhl", <NHLApp {...tabProps("nhl")} />)}
        {page("parlay", <ParlayBuilder />)}
      </main>
    </div>
  );
}
