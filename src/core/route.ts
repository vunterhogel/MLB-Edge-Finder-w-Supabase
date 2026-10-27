/* Page addresses for the app frame: #/<page>[/<tab>], e.g. #/mlb/board, #/parlay.
   The address drives what's shown, so a refresh or the back button keeps your place. The last page
   is remembered (and each sport's last tab), and the app reopens there when no address is given. */
import { useEffect, useRef, useState } from "react";

export const SPORT_PAGES = ["mlb", "nfl", "nba", "nhl"];
export const HUB_PAGES = ["parlay"];
export const SPORT_TABS = ["slate", "board", "trends", "analysis", "mybets", "stats"];
const DEFAULT_ROUTE = { page: "mlb", tab: "slate" };
const LS_LAST = "ef_last_route_v1";
const LS_TABS = "ef_sport_tabs_v1";

const readJson = (k, fb) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; } catch { return fb; } };
const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };

const sportTabs = readJson(LS_TABS, {});

function valid(r) {
  if (!r || !r.page) return null;
  if (HUB_PAGES.includes(r.page)) return { page: r.page, tab: null };
  if (SPORT_PAGES.includes(r.page)) return { page: r.page, tab: SPORT_TABS.includes(r.tab) ? r.tab : (sportTabs[r.page] || "slate") };
  return null;
}
function parseHash(h) {
  const [page, tab] = String(h || "").replace(/^#\/?/, "").split("/");
  return valid({ page, tab });
}
const toHash = (r) => `#/${r.page}${r.tab ? `/${r.tab}` : ""}`;

function initialRoute() {
  return parseHash(window.location.hash) || valid(readJson(LS_LAST, null)) || DEFAULT_ROUTE;
}

export function useRoute() {
  const [route, setRoute] = useState(initialRoute);
  const cur = useRef(route);
  cur.current = route;
  useEffect(() => {
    if (toHash(route) !== window.location.hash) window.history.replaceState(null, "", toHash(route));
    // an unknown address keeps the current page and corrects the address bar
    const onHash = () => { const r = parseHash(window.location.hash); if (r) setRoute(r); else window.history.replaceState(null, "", toHash(cur.current)); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    writeJson(LS_LAST, route);
    if (route.tab && SPORT_PAGES.includes(route.page)) { sportTabs[route.page] = route.tab; writeJson(LS_TABS, sportTabs); }
  }, [route]);
  function navigate(page, tab = null) {
    const r = valid({ page, tab });
    if (!r) return;
    if (toHash(r) !== window.location.hash) window.location.hash = toHash(r); // pushes history; hashchange sets the route
    setRoute(r);
  }
  return [route, navigate];
}
