import React, { useEffect, useState } from "react";
import { CalendarCheck, Layers, Moon, PanelLeftClose, PanelLeftOpen, RotateCcw, Sun, Ticket, TrendingUp } from "lucide-react";
import MLBApp from "./App";
import NFLApp from "./sports/nfl/Page";
import NBAApp from "./sports/nba/Page";
import NHLApp from "./sports/nhl/Page";
import ParlayBuilder from "./parlay/ParlayBuilder";
import Today from "./hub/Today";
import MyBets from "./hub/MyBets";
import MyStats from "./hub/MyStats";
import { useHubBets } from "./hub/useHubBets";
import { HUB_SPORTS } from "./hub/sports";
import { useParlays } from "./parlay/store";
import { SPORT_PAGES, resetSportTabs, useRoute } from "./core/route";
import { clearAllLive, getBoard, getCredits, getSlate, useLive } from "./core/live";
import { Btn, DialogHost, Logo, SportIcon, Toasts, confirmDialog, cx, setNavMin, setNavOpen, setTheme, todayYmd, useChrome } from "./ui/kit";

/* Root: the app frame. A sidebar (a slide-out menu on phones) switches pages, and the page address
   (#/mlb/board, #/parlay) says which page is showing. Every sport renders through the shared
   SportApp shell. A page stays mounted after its first visit and is only hidden when you switch
   away, so a loaded slate and pulled odds survive switching sports. */
const HUB = [
  { page: "today", label: "Today", Icon: CalendarCheck },
  { page: "bets", label: "My bets", Icon: Ticket },
  { page: "stats", label: "My stats", Icon: TrendingUp },
  { page: "parlay", label: "Parlay builder", Icon: Layers },
];
const SPORTS = HUB_SPORTS.map((s) => ({ page: s.id, label: s.label }));
const LABEL = Object.fromEntries([...HUB, ...SPORTS].map((i) => [i.page, i.label]));
const TAB_LABEL = { slate: "Slate", board: "Board", trends: "Trends", analysis: "Players", log: "Model" };

function Sidebar({ route, navigate, onFreshSports }) {
  const c = useChrome();
  useLive();
  // open tracked bets across every sport, shown next to My bets
  const all = useHubBets();
  const parlays = useParlays();
  const open = Object.values(all).reduce((n, bets) => n + bets.filter((b) => b.status === "open").length, 0) + parlays.filter((p) => p.status === "open").length;
  const credits = getCredits() ?? HUB_SPORTS.map((s) => s.sport.storage.loadCredits()).find((v) => v != null) ?? null;
  const today = todayYmd();
  const go = (page) => { navigate(page); setNavOpen(false); };
  return (
    <nav className="side" aria-label="Main">
      <div className="brand"><Logo /><b>Edge Finder</b></div>
      <div className="nav">
        <h3>Hub</h3>
        {HUB.map(({ page, label, Icon }) => (
          <button type="button" key={page} className={cx("nav-item", route.page === page && "on")} title={label} onClick={() => go(page)}>
            <Icon /><span>{label}</span>{page === "bets" && open > 0 ? <span className="count num" title={`${open} open tracked bets and parlays`}>{open}</span> : null}
          </button>
        ))}
        <h3>Sports</h3>
        {SPORTS.map(({ page, label }) => {
          const slate = getSlate(page), mine = slate && slate.date === today ? slate.games : null;
          const live = mine ? mine.some((g) => g.status === "LIVE") : false;
          const b = getBoard(page), pulled = b && b.board ? Object.keys(b.board).length : 0;
          return (
            <button type="button" key={page} className={cx("nav-item", route.page === page && "on")} title={label} onClick={() => go(page)}>
              <SportIcon sport={page} /><span>{label}</span>
              {live ? <i className="livedot" title="Games in progress" /> : mine ? <span className="count num" title={`${mine.length} games today${pulled ? `, odds pulled for ${pulled}` : ""}`}>{mine.length}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="side-foot">
        <div className="credits" title="Odds credits left this month"><span>Odds credits</span><b className={cx("num", credits != null && credits < 1000 && "warn")}>{credits != null ? credits.toLocaleString() : "–"}</b></div>
        <button type="button" className="ghostline row" onClick={onFreshSports} title="Every sport back to today's slate: clears loaded games, pulled odds and filters. Tracked bets, stats and board logs are kept."><RotateCcw size={14} />Fresh start, all sports</button>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <Btn sm icon kind="ghost" aria-label={c.theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme"} title="Switch theme" onClick={() => setTheme(c.theme === "dark" ? "light" : "dark")}>{c.theme === "dark" ? <Sun /> : <Moon />}</Btn>
          <Btn sm icon kind="ghost" className="hide-s" aria-label={c.navMin ? "Expand the sidebar" : "Collapse the sidebar"} title={c.navMin ? "Expand the sidebar" : "Collapse the sidebar"} onClick={() => setNavMin(!c.navMin)}>{c.navMin ? <PanelLeftOpen /> : <PanelLeftClose />}</Btn>
        </div>
      </div>
    </nav>
  );
}

export default function Root() {
  const c = useChrome();
  const [route, navigate] = useRoute();
  const [visited, setVisited] = useState(() => new Set([route.page]));
  // bumping this reloads every sport page from scratch (today's slate, nothing loaded, default filters).
  // Tracked bets, stats, board logs and saved book overrides live in storage, so they're untouched.
  const [sportEpoch, setSportEpoch] = useState(0);
  function freshSports() {
    confirmDialog({
      title: "Fresh start for all sports?", confirm: "Start fresh",
      body: "Every sport goes back to today's slate with loaded games, pulled odds and search cleared. Pulling odds again uses credits. Tracked bets, stats and board logs are kept.",
      onConfirm: () => {
        resetSportTabs();
        clearAllLive(SPORT_PAGES);
        // sports you're not on are unloaded entirely and load fresh on your next visit
        setVisited((v) => new Set([...v].filter((k) => !SPORT_PAGES.includes(k) || k === route.page)));
        setSportEpoch((e) => e + 1);
        if (SPORT_PAGES.includes(route.page)) navigate(route.page, "slate");
      },
    });
  }
  useEffect(() => { setVisited((v) => (v.has(route.page) ? v : new Set([...v, route.page]))); }, [route.page]);
  useEffect(() => {
    document.title = `Edge Finder: ${LABEL[route.page] || ""}${route.tab ? `, ${TAB_LABEL[route.tab] || route.tab}` : ""}`;
  }, [route]);

  const page = (key, el) => (visited.has(key) ? <div key={SPORT_PAGES.includes(key) ? `${key}:${sportEpoch}` : key} className={cx("pagewrap", route.page !== key && "off")}>{el}</div> : null);
  const tabProps = (key) => ({ tab: route.page === key ? route.tab : null, onTabChange: (t) => navigate(key, t) });

  return (
    <div className={cx("app", c.navMin && "nav-min", c.navOpen && "nav-open")}>
      <Sidebar route={route} navigate={navigate} onFreshSports={freshSports} />
      <div className="main" onClick={() => { if (c.navOpen) setNavOpen(false); }}>
        {page("mlb", <MLBApp {...tabProps("mlb")} />)}
        {page("nfl", <NFLApp {...tabProps("nfl")} />)}
        {page("nba", <NBAApp {...tabProps("nba")} />)}
        {page("nhl", <NHLApp {...tabProps("nhl")} />)}
        {page("today", <Today active={route.page === "today"} navigate={navigate} />)}
        {page("bets", <MyBets active={route.page === "bets"} />)}
        {page("stats", <MyStats active={route.page === "stats"} />)}
        {page("parlay", <ParlayBuilder active={route.page === "parlay"} navigate={navigate} />)}
      </div>
      <Toasts /><DialogHost />
    </div>
  );
}
