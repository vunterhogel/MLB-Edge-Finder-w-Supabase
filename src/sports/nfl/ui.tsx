/* NFL-specific UI for the shared shell: week navigator, status chip, score line, slate detail
   (weather, model game line, featured players) and the Player Analysis panel. Moved from the old
   NFLApp.tsx; Board / Trends / My Bets rows are the shared components every sport uses. */
import { useState } from "react";
import { pct, probToAmerican } from "../../core/math";
import { Env, mono } from "../../core/ui";
import { BoardRow as CoreBoardRow, MathPanel, MyBetRow as CoreMyBetRow, TrendCard as CoreTrendCard } from "../../core/cards";
import { isLineType } from "./config";
import { GAMELOG_ROWS, fetchCurrentWeek } from "./data";
import { gameProbs } from "./engine";
import { analysisCtx } from "./context";

/* ---------------- shared rows (core components, NFL config) ---------------- */
export const getDeltaSignal = () => null;   // no NFL delta thresholds until there is settled data to fit them
export function BoardRow(props) { return <CoreBoardRow {...props} isLineType={isLineType} getDeltaSignal={getDeltaSignal} />; }
export function MyBetRow(props) { return <CoreMyBetRow {...props} isLineType={isLineType} />; }
export function TrendCard(props) { return <CoreTrendCard {...props} />; }

/* ---------------- week navigator (the shell's date picker, for an NFL week) ---------------- */
const SEASON_TYPE_LABEL = { 1: "Preseason", 2: "Regular Season", 3: "Postseason" };
const MAX_WEEK = { 1: 4, 2: 18, 3: 5 };
export function WeekNav({ value, onChange }) {
  const [y, st, w] = String(value).split("-").map(Number);
  const set = (next) => onChange(`${next.year ?? y}-${next.seasonType ?? st}-${next.week ?? w}`);
  const step = (n) => set({ week: Math.min(MAX_WEEK[st] || 22, Math.max(1, w + n)) });
  const [busy, setBusy] = useState(false);
  async function current() {
    setBusy(true);
    try { const c = await fetchCurrentWeek(); onChange(`${c.year}-${c.seasonType}-${c.week}`); } catch { /* keep the selected week */ }
    setBusy(false);
  }
  const box = "bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm";
  return (
    <div className="flex items-center gap-1">
      <select value={st} onChange={(e) => set({ seasonType: +e.target.value, week: 1 })} className={box}>
        {[1, 2, 3].map((k) => <option key={k} value={k}>{SEASON_TYPE_LABEL[k]}</option>)}
      </select>
      <button onClick={() => step(-1)} className={`${box} hover:bg-slate-800`}>◂</button>
      <div className={`${box} text-slate-100 w-20 text-center`} style={mono}>Week {w}</div>
      <button onClick={() => step(1)} className={`${box} hover:bg-slate-800`}>▸</button>
      <input value={y} onChange={(e) => { const v = parseInt(e.target.value, 10); if (v > 2000 && v < 2100) set({ year: v }); }} inputMode="numeric" className={`${box} w-16 text-slate-100`} />
      <button onClick={current} disabled={busy} className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs hover:bg-slate-800 text-slate-400">{busy ? "…" : "this week"}</button>
    </div>
  );
}

/* ---------------- status ---------------- */
export const STATUS = {
  SCHEDULED: { t: "SCHEDULED", c: "bg-slate-700 text-slate-300" },
  LIVE: { t: "LIVE", c: "bg-rose-500 text-white" },
  FINAL: { t: "FINAL", c: "bg-slate-600 text-slate-200" },
  MANUAL: { t: "MANUAL", c: "bg-violet-500 text-white" },
};
export function Chip({ s }) { const m = STATUS[s] || STATUS.SCHEDULED; return <span className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wide ${m.c}`}>{m.t}</span>; }
export function ScoreLine({ g }) {
  const a = g.awayScore, h = g.homeScore;
  if (g.status === "FINAL") {
    return <div className="text-[12px] truncate" style={mono}><span className={a > h ? "text-slate-100 font-bold" : "text-slate-400"}>{g.away} {a}</span><span className="text-slate-600">, </span><span className={h > a ? "text-slate-100 font-bold" : "text-slate-400"}>{g.home} {h}</span><span className="text-slate-500"> · Final</span></div>;
  }
  return <div className="text-[12px] truncate" style={mono}><span className="text-slate-200">{g.away} {a}</span><span className="text-slate-600">, </span><span className="text-slate-200">{g.home} {h}</span><span className="text-rose-400"> · Q{g.period} {g.clock}</span></div>;
}
export function GameSubtitle({ g }) {
  return <div className="text-[11px] text-slate-500 truncate">{g.venue || "TBD"}{g.awayRec || g.homeRec ? <span className="text-slate-600"> · {g.awayRec || "—"} / {g.homeRec || "—"}</span> : null}</div>;
}
export function InjBadge({ status }) {
  if (!status) return null;
  const c = status === "OUT" || status === "IR" || status === "SUSPENDED" ? "bg-rose-600" : status === "DOUBTFUL" ? "bg-orange-600" : "bg-amber-600";
  return <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold text-white ${c}`}>{status.replace(/_/g, " ")}</span>;
}
function MiniMetric({ label, value }) {
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2">
      <div className="text-[9px] text-slate-500 font-bold tracking-wide">{label}</div>
      <div className="text-lg font-black text-slate-100">{value}</div>
    </div>
  );
}

/* ---------------- Slate detail ---------------- */
// headline last-4-games rate per position, pulled from the gamelog the Slate already fetches
const L4_HEADLINE = { QB: ["passYds", "pYds"], RB: ["rushYds", "rYds"], WR: ["recYds", "rcYds"], TE: ["recYds", "rcYds"], K: ["kickPts", "pts"] };
function L4Hint({ gl, pos }) {
  const cfg = L4_HEADLINE[pos];
  if (!cfg || !gl || !gl.recent || !gl.recent.games) return null;
  const [key, label] = cfg;
  const perGame = (gl.recent[key] || 0) / gl.recent.games;
  return <span className="text-[9px] text-slate-500 shrink-0" style={mono} title={`last ${gl.recent.games} games`}>L{gl.recent.games} {label} {perGame.toFixed(1)}/g</span>;
}
function LineupCol({ title, team, logs, onAdd, onPlayerClick }) {
  const rows = [...team.featured, { id: `dst-${team.teamId}`, pos: "DST", name: `${title.split(" ")[0]} D/ST` }];
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1.5">{title}</div>
      {team.featured.length === 0 && <div className="text-[11px] text-slate-600 py-2">— roster unavailable —</div>}
      <div className="space-y-0.5">
        {rows.map((p, i) => (
          <div key={p.id} className="flex items-center gap-2 text-[12px] px-1 py-1 rounded hover:bg-slate-900/60">
            <span className="text-slate-600 w-4 shrink-0" style={mono}>{i + 1}</span>
            <span className="w-9 text-[10px] text-slate-500 shrink-0 inline-flex items-center gap-0.5" style={mono}>
              {p.pos}{p.depthRank && p.depthRank < 90 ? p.depthRank : ""}
              {p.depthConfirmed === false && <span className="text-amber-500" title="No confirmed depth chart for this team, so the order is the roster listing, not a verified starter">?</span>}
            </span>
            <button onClick={() => onPlayerClick({ id: p.id, name: p.name, pos: p.pos, teamId: team.teamId })} className="flex-1 text-left truncate hover:text-sky-300" title="Open player analysis">{p.name}</button>
            <L4Hint gl={logs[p.id]} pos={p.pos === "PK" ? "K" : p.pos} />
            <InjBadge status={p.injuryStatus} />
            <button onClick={() => onAdd(p)} className="text-emerald-500 hover:text-emerald-300 font-bold w-5 text-center" title="manual bet">+</button>
          </div>
        ))}
      </div>
    </div>
  );
}
export function SlateDetail({ g, d, draftFromGame, goToAnalysis }) {
  const gp = gameProbs(d.lambdaH, d.lambdaA);
  const add = (p) => draftFromGame(g, p.pos === "PK" ? "K" : p.pos, p.id, p.name);
  return (
    <>
      <div className="flex flex-wrap gap-2 mt-3 text-[11px]" style={mono}>
        <Env label="VENUE" v={g.venue || "—"} />
        {d.stadium && d.stadium.dome ? <Env label="ROOF" v="dome/closed" /> : null}
        {d.weather ? <Env label="TEMP" v={`${d.weather.temp}°`} hot={d.weather.temp >= 90} cold={d.weather.temp <= 32} /> : null}
        {d.weather ? <Env label="WIND" v={`${d.weather.wind}mph`} hot={d.weather.wind >= 15} /> : null}
        {d.weather ? <Env label="RAIN" v={`${d.weather.pop}%`} hot={d.weather.pop >= 50} /> : null}
      </div>
      <div className="mt-3 bg-slate-950/60 border border-slate-800 rounded-lg p-3">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">MODEL GAME LINE</div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[13px]" style={mono}>
          <span className="text-slate-300">proj score <b className="text-sky-300">{g.away} {d.lambdaA.toFixed(1)} – {d.lambdaH.toFixed(1)} {g.home}</b></span>
          <span>{g.home} <b className="text-emerald-400">{pct(gp.home)}</b> <span className="text-slate-600">({probToAmerican(gp.home)})</span></span>
          <span>{g.away} <b className="text-emerald-400">{pct(gp.away)}</b> <span className="text-slate-600">({probToAmerican(gp.away)})</span></span>
          <span>total <b className="text-sky-300">{gp.totalLambda.toFixed(1)}</b></span>
        </div>
        <div className="text-[10px] text-slate-600 mt-1.5">team scoring environment (standings points for / against × home field). Game lines are experimental: once odds are pulled they anchor to the market total and spread.</div>
      </div>
      <div className="grid md:grid-cols-2 gap-3 mt-3">
        <LineupCol title={`${g.away} (away)`} team={d.away} logs={d.logs} onAdd={add} onPlayerClick={goToAnalysis} />
        <LineupCol title={`${g.home} (home)`} team={d.home} logs={d.logs} onAdd={add} onPlayerClick={goToAnalysis} />
      </div>
    </>
  );
}

/* ---------------- Player Analysis ---------------- */
export function PlayerAnalysisIntro({ games, boardCount }) {
  const live = (games || []).filter((g) => g.status === "LIVE").length;
  return (
    <div className="grid sm:grid-cols-3 gap-3">
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">PLAYER FILE</div>
        <div className="text-sm text-slate-300">Search any NFL player, or click a name on the Slate.</div>
        <div className="text-[11px] text-slate-600 mt-2" style={mono}>season · last 4 · game log</div>
      </div>
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">SLATE CONTEXT</div>
        <div className="text-sm text-slate-300">{(games || []).length} game(s) this week, {live} live.</div>
        <div className="text-[11px] text-slate-600 mt-2" style={mono}>game script · weather · injuries · depth</div>
      </div>
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">MARKET CONTEXT</div>
        <div className="text-sm text-slate-300">{boardCount} board candidate(s) loaded.</div>
        <div className="text-[11px] text-slate-600 mt-2" style={mono}>odds · no-vig · edge · EV</div>
      </div>
    </div>
  );
}
function ProjectionRow({ r }) {
  const [show, setShow] = useState(false);
  return (
    <div className="bg-slate-950/50 border border-slate-800 rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-2 text-[12px]" style={mono}>
        <div className="flex-1 text-slate-300">{r.type} <span className="text-slate-500">{r.line}</span></div>
        <div className="text-sky-300 w-24 text-right">proj {r.proj != null ? r.proj.toFixed(2) : "—"}</div>
        <div className="w-36 text-right text-slate-400">o {pct(r.overP)} <span className="text-slate-600">({r.overFair})</span></div>
        <div className="w-36 text-right text-slate-400">u {pct(r.underP)} <span className="text-slate-600">({r.underFair})</span></div>
        {r.calc ? <button onClick={() => setShow((s) => !s)} className="text-[11px] text-slate-500 hover:text-emerald-300 border border-slate-700 rounded px-2 py-0.5">{show ? "hide" : "math"}</button> : null}
      </div>
      {show && <MathPanel r={{ ...r, modelP: r.overP, side: "over", fair: r.overFair, odds: null, b: 0, edge: 0, novig: null }} />}
    </div>
  );
}
const SEASON_METRICS = {
  QB: (s, rate) => [["Pass Yds", Math.round(s.passYds || 0)], ["Pass TD", s.passTd || 0], ["INT", s.ints || 0], ["Yds/G", rate("passYds")]],
  RB: (s) => [["Rush Yds", Math.round(s.rushYds || 0)], ["Rush TD", s.rushTd || 0], ["Rec", s.rec || 0], ["YPC", s.rushAtt ? (s.rushYds / s.rushAtt).toFixed(1) : "—"]],
  WR: (s) => [["Rec", s.rec || 0], ["Rec Yds", Math.round(s.recYds || 0)], ["Rec TD", s.recTd || 0], ["Yds/Rec", s.rec ? (s.recYds / s.rec).toFixed(1) : "—"]],
  K: (s, rate) => [["FG Made", s.fgMade || 0], ["Kick Pts", s.kickPts || 0], ["Pts/G", rate("kickPts")], ["Games", s.g]],
};
const GAMELOG_COLS = {
  QB: [["passCmp", "CMP"], ["passAtt", "ATT"], ["passYds", "YDS"], ["passTd", "TD"], ["ints", "INT"]],
  RB: [["rushAtt", "CAR"], ["rushYds", "YDS"], ["rushTd", "TD"], ["rec", "REC"]],
  WR: [["targets", "TGT"], ["rec", "REC"], ["recYds", "YDS"], ["recTd", "TD"]],
  K: [["fgMade", "FG"], ["kickPts", "PTS"]],
};
export function PlayerProfilePanel({ profile, spot, detail, projections, boardEntries, boardGameCount, book, oddsLoading, oddsReady, onFetchOdds, myBets, onTrack, showProjBar }) {
  const p = profile.player;
  const ctx = spot && detail && detail.ready ? analysisCtx(detail, spot, profile) : null;
  const pos = (ctx && ctx.pos) || p.pos || "";
  const posGroup = pos === "TE" ? "WR" : pos;
  const log = (detail && detail.logs && detail.logs[p.id]) || profile.log;
  const season = log && log.season, recent = log && log.recent;
  const hasSeason = !!(season && season.g > 0);
  const hasRecent = !!(recent && recent.games > 0);
  const rate = (key) => (season && season.g ? ((season[key] || 0) / season.g).toFixed(1) : "—");
  const metrics = hasSeason && SEASON_METRICS[posGroup] ? SEASON_METRICS[posGroup](season, rate) : null;
  const rows = [...((log && log.games) || []), ...((profile.priorLog && profile.priorLog.games) || [])].slice(0, GAMELOG_ROWS);
  const cols = GAMELOG_COLS[posGroup] || [["sacks", "SACK"], ["defInt", "INT"]];
  const roster = detail && detail.ready ? [...detail.home.roster, ...detail.away.roster].find((x) => String(x.id) === String(p.id)) : null;
  return (
    <div className="space-y-3">
      <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-4">
        <div className="flex items-start gap-3">
          {pos !== "DST" && <img src={`https://a.espncdn.com/i/headshots/nfl/players/full/${p.id}.png`} alt="" className="w-16 h-16 rounded-xl object-cover border border-slate-700 bg-slate-800 flex-shrink-0" onError={(e) => { e.currentTarget.style.display = "none"; }} />}
          <div className="flex-1">
            <div className="text-xl font-black">{p.name} <span className="text-slate-500 text-sm font-semibold">{[p.jersey ? `#${p.jersey}` : "", pos, p.teamAbbr].filter(Boolean).join(" · ")}</span> <InjBadge status={roster ? roster.injuryStatus : null} /></div>
            <div className="text-[11px] text-slate-500" style={mono}>{[p.teamName, spot ? `on slate: ${spot.game.away}@${spot.game.home} (${spot.side})` : "no game in the selected week (bye, or a different week is loaded)", ctx && ctx.depthRank && ctx.depthRank < 90 ? `depth #${ctx.depthRank}` : ""].filter(Boolean).join(" · ")}</div>
          </div>
          {spot && <Chip s={spot.game.status} />}
        </div>
        {metrics && <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">{metrics.map(([l, v]) => <MiniMetric key={l} label={l} value={v} />)}</div>}
      </div>

      {ctx && (
        <div className="grid lg:grid-cols-3 gap-3">
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
            <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1.5">MATCHUP</div>
            <div className="text-[11px] text-slate-300 space-y-1" style={mono}>
              <div>{spot.game.away} @ {spot.game.home}</div>
              <div>game script (spread): {ctx.teamSpread != null ? ctx.teamSpread.toFixed(1) : "—"}</div>
              <div>implied team pts: {ctx.impliedTeamPts != null ? ctx.impliedTeamPts.toFixed(1) : "—"}</div>
              <div>weather: {ctx.weather ? `${ctx.weather.temp}°F, wind ${ctx.weather.wind}mph` : ctx.stadium && ctx.stadium.dome ? "dome/closed" : "—"}</div>
            </div>
          </div>
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
            <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1.5">SEASON (THIS YEAR)</div>
            <div className="text-[11px] text-slate-300 space-y-0.5" style={mono}>
              {hasSeason ? Object.entries(season).filter(([k]) => k !== "g").map(([k, v]) => <div key={k}>{k}: {typeof v === "number" ? v.toFixed(1) : String(v)}</div>) : <div className="text-slate-600">no season log yet</div>}
            </div>
          </div>
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
            <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1.5">LAST {hasRecent ? recent.games : 4} GAMES</div>
            <div className="text-[11px] text-slate-300 space-y-0.5" style={mono}>
              {hasRecent ? Object.entries(recent).filter(([k]) => k !== "games").map(([k, v]) => <div key={k}>{k}: {typeof v === "number" ? v.toFixed(1) : String(v)}</div>) : <div className="text-slate-600">no recent log yet</div>}
            </div>
          </div>
        </div>
      )}

      {spot && (
        <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <div className="text-[10px] text-slate-500 font-bold tracking-wide">MODEL PROJECTIONS · {spot.game.away}@{spot.game.home}</div>
            <button onClick={onFetchOdds} disabled={oddsLoading === spot.game.pk} className={`text-[11px] font-bold rounded px-2 py-1 ${oddsReady ? "bg-slate-700 text-slate-200" : "bg-sky-600 hover:bg-sky-500 text-white"}`}>{oddsLoading === spot.game.pk ? "…" : oddsReady ? `↻ ${book} odds` : `get ${book} odds`}</button>
          </div>
          {!detail || !detail.ready ? <div className="text-[11px] text-slate-500" style={mono}>loading game context…</div>
            : projections.length === 0 ? <div className="text-[11px] text-slate-500">No model context for this player in this game (not on the team's current roster feed).</div>
            : <div className="space-y-1">{projections.map((x) => <ProjectionRow key={x.type} r={x} />)}</div>}
          {boardEntries.length > 0 && (
            <div className="mt-3 space-y-2">
              <div className="text-[10px] text-slate-500 font-bold tracking-wide">PRICED ON THE BOARD ({boardEntries.length} of {boardGameCount} for this game)</div>
              {boardEntries.map((e) => <BoardRow key={e.id} e={e} tracked={myBets.some((b) => b.key === e.id)} onTrack={() => onTrack(e)} showProjBar={showProjBar} />)}
            </div>
          )}
        </div>
      )}

      {pos !== "DST" && (
        <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3">
          <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">LAST {GAMELOG_ROWS} GAMES</div>
          {!rows.length ? <div className="text-[11px] text-slate-500">No game log returned.</div> : (
            <div className="overflow-x-auto"><table className="w-full text-[12px]" style={mono}>
              <thead><tr className="text-slate-500 text-[10px]">{["wk", "opp", "res", ...cols.map(([, h]) => h)].map((h, i) => <th key={h} className={`${i < 3 ? "text-left" : "text-right"} font-semibold py-1`}>{h}</th>)}</tr></thead>
              <tbody>{rows.map((x, i) => (
                <tr key={x.eventId || i} className="border-t border-slate-800 text-slate-300">
                  <td className="py-1 text-slate-400">{x.week != null ? x.week : "—"}</td>
                  <td>{x.atVs || ""} {x.opp || "—"}</td>
                  <td className={x.result === "W" ? "text-emerald-400" : x.result === "L" ? "text-rose-400" : "text-slate-400"}>{x.result || ""} {x.score || ""}</td>
                  {cols.map(([k]) => <td key={k} className="text-right">{x[k] != null ? x[k] : "—"}</td>)}
                </tr>))}</tbody>
            </table></div>
          )}
        </div>
      )}
    </div>
  );
}
