/* Hub · Today: one screen for the day across every sport. Open bets, recent results, each sport's slate,
   the best plays on the boards you have pulled, and what still needs doing. It reads the same stores the
   other pages use and owns no sport logic: schedules come from each sport's adapter, boards from the odds
   you pulled on the sport pages, results from the shared settle code. Nothing here pulls odds. */
import React, { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, Plus, RefreshCw } from "lucide-react";
import { suggestedUnits } from "../core/math";
import { fetchOpenBetResults, gradeOpenBets } from "../core/bets";
import { betFromEntry, getBoard, getCredits, getSlate, setSlate, useLive } from "../core/live";
import { settleBoardLog } from "../core/boardlog";
import { getParlays, syncParlayResults, useParlays } from "../parlay/store";
import { HUB_SPORT, HUB_SPORTS } from "./sports";
import { setSportBets, useHubBets } from "./useHubBets";
import { HubTop, betNet, betUnits, dailySeries, isSettled } from "./common";
import { Badge, Banner, Btn, Empty, Panel, SportIcon, SportTag, Stat, cx, fDay, fNum, fOdds, fPct, fSigned, fTime, fUnits, pickLabel, toast, todayYmd, tone } from "../ui/kit";
import { Spark } from "../ui/charts";

const dayOffset = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const rec = (list) => { const s = list.filter(isSettled); const w = s.filter((b) => b.status === "won").length, l = s.filter((b) => b.status === "lost").length, p = s.filter((b) => b.status === "push").length; const staked = s.filter((b) => b.status === "won" || b.status === "lost").reduce((a, b) => a + betUnits(b), 0), net = s.reduce((a, b) => a + betNet(b), 0); return { n: s.length, w, l, p, net, roi: staked ? net / staked : null }; };
const started = (g) => g.status === "LIVE" || g.status === "FINAL" || (g.gameTimeIso && Date.parse(g.gameTimeIso) <= Date.now());

export default function Today({ active = true, navigate }) {
  useLive();
  const all = useHubBets();
  const parlays = useParlays();
  const today = todayYmd();
  const [loadErr, setLoadErr] = useState({});       // sport id -> schedule error
  const [logOpen, setLogOpen] = useState({});       // sport id -> unsettled board-log rows
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  // today's schedule for a sport: the sport page's copy if it has today loaded, otherwise fetched here (free)
  async function loadSlates(force = false) {
    for (const s of HUB_SPORTS) {
      const have = getSlate(s.id);
      if (!force && have && have.date === today) continue;
      try { const games = await s.sport.api.fetchSchedule(today); if (!getSlate(s.id) || getSlate(s.id).date !== today || force) setSlate(s.id, { date: today, games }); setLoadErr((e) => ({ ...e, [s.id]: null })); }
      catch (e) { setLoadErr((x) => ({ ...x, [s.id]: String((e && e.message) || e) })); }
    }
  }
  async function countLogs() {
    const out = {};
    for (const s of HUB_SPORTS) { try { await s.sport.storage.boardLogReady; out[s.id] = s.sport.storage.loadBoardLog().filter((r) => !r.settled).length; } catch { out[s.id] = 0; } }
    setLogOpen(out);
  }
  useEffect(() => { if (active) { void loadSlates(); void countLogs(); void syncParlayResults(HUB_SPORTS); } /* eslint-disable-next-line */ }, [active]);

  const slates = HUB_SPORTS.map((s) => { const sl = getSlate(s.id), b = getBoard(s.id); return { s, games: sl && sl.date === today ? sl.games : null, board: b && b.date === today && b.board ? b.board : {} }; });
  const gameOf = (id, pk) => { const sl = slates.find((x) => x.s.id === id); return sl && sl.games ? sl.games.find((g) => String(g.pk) === String(pk)) : null; };
  const bets = useMemo(() => HUB_SPORTS.flatMap((s) => all[s.id].map((b) => ({ ...b, _sport: s.id }))), [all]);
  const open = bets.filter((b) => b.status === "open");
  const openParlays = parlays.filter((p) => p.status === "open").length;
  const atRisk = open.reduce((a, b) => a + betUnits(b), 0);
  const y = rec(bets.filter((b) => b.date === dayOffset(-1)));
  const weekBets = bets.filter((b) => b.date && b.date >= dayOffset(-6) && isSettled(b)), w = rec(weekBets), ser = dailySeries(weekBets);
  const credits = getCredits() ?? HUB_SPORTS.map((s) => s.sport.storage.loadCredits()).find((v) => v != null) ?? null;
  const trackedKeys = useMemo(() => Object.fromEntries(HUB_SPORTS.map((s) => [s.id, new Set(all[s.id].map((b) => b.key))])), [all]);

  // best plays: one side per market, model at 50% or better, highest expected return first
  const best = useMemo(() => {
    const top = new Map();
    for (const { s, board } of slates) for (const e of Object.values(board).flat()) {
      if (e.modelP == null || e.modelP < 0.5 || e.modelP >= 0.999 || e.ev == null || e.outsSanityFailed || e.suppressNote || s.rowCfg.isLineType(e.type)) continue;
      const k = `${s.id}|${e.gamePk}|${e.playerId}|${e.type}|${e.line}`, c = top.get(k);
      if (!c || e.ev > c.e.ev) top.set(k, { e, id: s.id });
    }
    return [...top.values()].sort((a, b) => b.e.ev - a.e.ev).slice(0, 8);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slates.map((x) => Object.values(x.board).reduce((n, l) => n + l.length, 0)).join("|")]);
  function track(id, e) {
    const g = gameOf(id, e.gamePk), sug = suggestedUnits(e.modelP, Number(e.odds));
    const r = betFromEntry(e, today, 1, sug, !!((e.calc && e.calc.live) || (g && g.status === "LIVE")));
    setSportBets(id, (p) => (p.some((b) => b.key === r.key) ? p : [r, ...p]));
  }
  function untrack(id, e) {
    const bet = all[id].find((b) => b.key === e.id);
    if (!bet) return;
    if (bet.status !== "open") { toast("That bet has already settled. Remove it from My bets if you need to."); return; }
    setSportBets(id, (p) => p.filter((b) => b.key !== bet.key));
    toast(`Removed ${bet.name} from My bets.`, () => setSportBets(id, (p) => (p.some((b) => b.key === bet.key) ? p : [bet, ...p])));
  }

  const unpulled = slates.map(({ s, games, board }) => [s, (games || []).filter((g) => !g.manual && g.status !== "FINAL" && !(board[g.pk] || []).length).length]).filter((x) => x[1]);
  const todays = open.filter((b) => b.date === today).map((b) => ({ b, g: gameOf(b._sport, b.gamePk) }));
  const underway = todays.filter((x) => x.g && x.g.status === "LIVE").length;
  const finished = open.filter((b) => { if (b.date < today) return true; const g = gameOf(b._sport, b.gamePk); return !!(g && g.status === "FINAL"); }).length;
  const soon = todays.filter((x) => x.g && !started(x.g)).sort((a, b) => String(a.g.gameTimeIso || "").localeCompare(String(b.g.gameTimeIso || ""))).slice(0, 8);
  const noLine = open.filter((b) => b.lineMissing).length;
  const logTotal = Object.values(logOpen).reduce((a, n) => a + n, 0);

  // Settle everything: tracked bets and board logs for every sport, then parlays. Free stats calls only.
  async function settleEverything() {
    setBusy(true); setMsg("Settling.");
    const parts = [];
    for (const s of HUB_SPORTS) {
      const bits = [];
      try {
        if (all[s.id].some((b) => b.status === "open")) {
          const { results } = await fetchOpenBetResults(s.sport, all[s.id]);
          let graded = 0;
          setSportBets(s.id, (prev) => { const r = gradeOpenBets(s.sport, prev, results); graded = r.graded; return r.next; });
          bits.push(`${graded} bet${graded === 1 ? "" : "s"}`);
        }
        if (logOpen[s.id]) { const r = await settleBoardLog(s.sport); bits.push(`${r.graded.toLocaleString()} logged play${r.graded === 1 ? "" : "s"}`); }
      } catch (e) { bits.push(`failed (${String((e && e.message) || e)})`); }
      if (bits.length) parts.push(`${s.label}: ${bits.join(", ")}`);
    }
    let legs = 0;
    if (getParlays().some((p) => p.status === "open")) { legs = await syncParlayResults(HUB_SPORTS); parts.push(`Parlays: ${legs} leg${legs === 1 ? "" : "s"}`); }
    await countLogs();
    setMsg(parts.length ? `Settled. ${parts.join(". ")}. Games still in progress stay open.` : "Nothing to settle: no open bets and nothing waiting in the board logs.");
    setBusy(false);
  }

  const attention = [
    unpulled.length ? [`${unpulled.reduce((a, x) => a + x[1], 0)} upcoming games have no odds pulled`, unpulled.map((x) => `${x[0].label} ${x[1]}`).join(", "), "Open slate", () => navigate(unpulled[0][0].id, "slate")] : null,
    finished ? [`${finished} open bet${finished === 1 ? " is" : "s are"} on games that have finished`, "Settling grades them from the final box scores", "Settle", settleEverything] : null,
    underway ? [`${underway} tracked bet${underway === 1 ? " is" : "s are"} in games under way`, "They settle once those games go final", "View bets", () => navigate("bets")] : null,
    noLine ? [`${noLine} open bet${noLine === 1 ? " has" : "s have"} no current line`, "The market was pulled or the line moved off your number", "View bets", () => navigate("bets")] : null,
    logTotal ? [`${logTotal.toLocaleString()} board-log plays are waiting on results`, HUB_SPORTS.filter((s) => logOpen[s.id]).map((s) => `${s.label} ${logOpen[s.id].toLocaleString()}`).join(", "), "Settle", settleEverything] : null,
  ].filter(Boolean);

  return (
    <>
      <HubTop title="Today">
        <span className="mid hide-s">{fDay(today)}</span>
        <Btn onClick={() => { void loadSlates(true); void countLogs(); }} title="Reload today's schedules. Uses no odds credits."><RefreshCw /><span className="hide-s">Refresh</span></Btn>
        <Btn kind="primary" disabled={busy} onClick={settleEverything} title="Settle tracked bets, parlays and board logs for every sport. Uses no odds credits."><Check /><span className="hide-s">{busy ? "Settling" : "Settle everything"}</span></Btn>
      </HubTop>
      {msg ? <Banner kind="info" onClose={() => setMsg("")}>{msg}</Banner> : null}
      <div className="scroll"><div className="page" style={{ display: "grid", gap: 16 }}>
        <div className="stats">
          <Stat k="Open bets" v={<span className="num">{open.length}</span>} s={`${fNum(atRisk, 2)} units at risk${openParlays ? `, ${openParlays} open parlay${openParlays === 1 ? "" : "s"}` : ""}`} />
          <Stat k="Yesterday" v={<span className="num">{y.n ? `${y.w}-${y.l}${y.p ? `-${y.p}` : ""}` : "–"}</span>} s={y.n ? <span className={cx("num", tone(y.net))}>{fUnits(y.net)}</span> : "Nothing settled"} />
          <div className="stat"><div className="k">Last 7 days</div><div className="row" style={{ justifyContent: "space-between" }}><div className={cx("v num", tone(w.net))}>{w.n ? fUnits(w.net) : "–"}</div><Spark values={ser.staked} /></div><div className="s num">{w.n ? `${w.w}-${w.l}, ${fSigned(w.roi)} return` : "Nothing settled"}</div></div>
          <Stat k="Odds credits left" v={<span className={cx("num", credits != null && credits < 1000 && "warn")}>{credits != null ? credits.toLocaleString() : "–"}</span>} s={credits != null ? `About ${Math.floor(credits / 9).toLocaleString()} game pulls` : "Shown after the first odds call"} />
        </div>
        <div className="grid g-3-2">
          <div className="grid" style={{ alignContent: "start" }}>
            <Panel title="Today's slates" sub={fDay(today)} flush>
              <table className="tbl inset">
                <thead><tr><th>Sport</th><th className="r">Games</th><th className="hide-s">Next start</th><th className="r">Odds pulled</th><th className="r hide-s">+EV on the board</th><th className="r">Tracked</th><th /></tr></thead>
                <tbody>{slates.map(({ s, games, board }) => {
                  const g = games || [], live = g.filter((x) => x.status === "LIVE").length, next = g.filter((x) => !started(x)).sort((a, b) => String(a.gameTimeIso || "").localeCompare(String(b.gameTimeIso || "")))[0];
                  const up = g.filter((x) => x.status !== "FINAL" && !x.manual).length, pulled = g.filter((x) => (board[x.pk] || []).length).length;
                  const ev = Object.values(board).flat().filter((e) => e.ev != null && e.ev > 0 && e.modelP < 0.999).length;
                  return (
                    <tr key={s.id} style={{ cursor: "pointer" }} onClick={() => navigate(s.id, "slate")}>
                      <td><span className="row name" style={{ gap: 8 }}><span className="mid" style={{ display: "inline-grid" }}><SportIcon sport={s.id} /></span>{s.label}{live ? <Badge kind="live"><span className="dot" />{live} live</Badge> : null}</span></td>
                      <td className="r num">{games ? g.length : loadErr[s.id] ? <span className="warn" title={loadErr[s.id]}>Not loaded</span> : <span className="dim">Loading</span>}</td>
                      <td className="hide-s mid">{!games ? "" : !g.length ? "No games today" : next ? `${next.away} at ${next.home}, ${next.time}` : "All started"}</td>
                      <td className="r num">{games && g.length ? `${pulled} of ${Math.max(up, pulled)}` : ""}</td><td className="r num hide-s">{ev || ""}</td>
                      <td className="r num">{all[s.id].filter((b) => b.date === today).length || ""}</td><td className="r"><ArrowRight size={15} className="dim" /></td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </Panel>
            <Panel title="Best plays on the board" sub="Highest expected return across every sport: model at 50% or better, one side per market" flush>
              {best.length ? (
                <table className="tbl inset">
                  <thead><tr><th><span className="sr">Sport</span></th><th>Player</th><th>Pick</th><th className="r">Odds</th><th className="r hide-s">Model</th><th className="r">EV</th><th /></tr></thead>
                  <tbody>{best.map(({ e, id }) => { const on = trackedKeys[id].has(e.id); return (
                    <tr key={`${id}:${e.id}`}>
                      <td><SportTag icon sport={id} label={HUB_SPORT[id].label} /></td><td className="name">{e.name}</td><td className="pick"><b>{pickLabel(e, HUB_SPORT[id].rowCfg)}</b> <span className="mid">{e.type}</span></td>
                      <td className="r num">{fOdds(e.odds)}</td><td className="r num hide-s">{fPct(e.modelP)}</td><td className={cx("r num", tone(e.ev))} style={{ fontWeight: 620 }}>{fSigned(e.ev)}</td>
                      <td className="r">{on ? <Btn sm icon on aria-label="Tracked" title="Tracked. Click to remove it from My bets." onClick={() => untrack(id, e)}><Check /></Btn> : <Btn sm icon aria-label="Track this play" title="Track this play" onClick={() => track(id, e)}><Plus /></Btn>}</td>
                    </tr>); })}</tbody>
                </table>
              ) : <Empty title="No odds pulled today">Pull odds on a sport's Slate and the best plays across every sport show up here.</Empty>}
            </Panel>
          </div>
          <div className="grid" style={{ alignContent: "start" }}>
            <Panel title="Needs attention" flush>
              {attention.length ? (
                <div style={{ padding: "4px 14px" }}>
                  {attention.map(([t, sub, label, fn], i) => (
                    <div className="row" key={i} style={{ padding: "10px 0", borderBottom: i < attention.length - 1 ? "1px solid var(--line)" : 0 }}><div className="grow"><div style={{ fontWeight: 560 }}>{t}</div><div className="note">{sub}</div></div><Btn sm disabled={busy && label === "Settle"} onClick={fn}>{label}</Btn></div>
                  ))}
                </div>
              ) : <Empty title="All caught up">Nothing is waiting on you right now.</Empty>}
            </Panel>
            <Panel title="Starting soon" sub="Your open bets today, by start time" flush actions={<Btn sm onClick={() => navigate("bets")}>All bets</Btn>}>
              {soon.length ? (
                <table className="tbl inset">
                  <tbody>{soon.map(({ b, g }) => { const cfg = HUB_SPORT[b._sport].rowCfg; return (
                    <tr key={`${b._sport}:${b.key}`}><td className="num mid" style={{ width: 76 }}>{g.gameTimeIso ? fTime(g.gameTimeIso) : g.time}</td>
                      <td className="trunc" style={{ maxWidth: 0, width: "100%" }}>{cfg.isLineType(b.type) ? <span className="mid">{String(b.game).replace("@", " at ")}</span> : <span className="name">{b.name}</span>} <span className="pick"><b>{pickLabel(b, cfg)}</b> <span className="mid">{b.type}</span></span></td>
                      <td className="r num">{fOdds(Number(b.odds))}</td><td className="r num mid">{betUnits(b)}u</td></tr>); })}</tbody>
                </table>
              ) : <Empty title="Nothing waiting">{todays.length ? "Every bet you have open today is already under way." : "No open bets on today's games yet."}</Empty>}
            </Panel>
          </div>
        </div>
      </div></div>
    </>
  );
}
