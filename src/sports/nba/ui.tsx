/* NBA-specific UI for the shared shell: status chip, score line, slate detail (rest, model game line,
   rotations) and the Player Analysis panel. Styling follows the MLB page. */
import { useState } from "react";
import { pct, probToAmerican } from "../../core/math";
import { Env, StatCard, mono } from "../../core/ui";
import { BoardRow as CoreBoardRow, MathPanel, MyBetRow as CoreMyBetRow, TrendCard as CoreTrendCard } from "../../core/cards";
import { isLineType, isYesNoType } from "./config";
import { gameProbs } from "./engine";

export const getDeltaSignal = () => null;   // no NBA thresholds until there is settled data to fit them
export function BoardRow(props) { return <CoreBoardRow {...props} isLineType={isLineType} getDeltaSignal={getDeltaSignal} isYesNoType={isYesNoType} />; }
export function MyBetRow(props) { return <CoreMyBetRow {...props} isLineType={isLineType} isYesNoType={isYesNoType} />; }
export function TrendCard(props) { return <CoreTrendCard {...props} isYesNoType={isYesNoType} />; }

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
    const ot = g.period && g.period > 4 ? `/${g.period === 5 ? "OT" : `${g.period - 4}OT`}` : "";
    return <div className="text-[12px] truncate" style={mono}><span className={a > h ? "text-slate-100 font-bold" : "text-slate-400"}>{g.away} {a}</span><span className="text-slate-600">, </span><span className={h > a ? "text-slate-100 font-bold" : "text-slate-400"}>{g.home} {h}</span><span className="text-slate-500"> · Final{ot}</span></div>;
  }
  return <div className="text-[12px] truncate" style={mono}><span className="text-slate-200">{g.away} {a}</span><span className="text-slate-600">, </span><span className="text-slate-200">{g.home} {h}</span><span className="text-rose-400"> · {g.period > 4 ? "OT" : `Q${g.period}`} {g.clock}</span></div>;
}
export function GameSubtitle({ g }) {
  return <div className="text-[11px] text-slate-500 truncate">{g.venue || "TBD"}{g.awayRec || g.homeRec ? <span className="text-slate-600"> · {g.awayRec || "—"} / {g.homeRec || "—"}</span> : null}</div>;
}

export function InjBadge({ status }) {
  if (!status) return null;
  const c = status === "OUT" || status === "SUSPENDED" ? "bg-rose-600" : status === "DOUBTFUL" ? "bg-orange-600" : "bg-amber-600";
  return <span className="inline-flex"><span className={`px-1.5 py-0.5 rounded text-[9px] font-bold text-white ${c}`}>{status.replace(/_/g, " ")}</span></span>;
}
const per = (log, k) => (log && log.season && log.season.g ? log.season[k] / log.season.g : null);
const f1 = (x) => (x == null || isNaN(x) ? "—" : Number(x).toFixed(1));

function TeamCol({ title, team, logs, onAdd, onPlayerClick }) {
  const [showAll, setShowAll] = useState(false);
  const featuredIds = new Set((team.featured || []).map((p) => p.id));
  const rest = (team.roster || []).filter((p) => !featuredIds.has(p.id)).sort((a, b) => (per(logs[b.id], "min") || 0) - (per(logs[a.id], "min") || 0));
  const list = showAll ? [...team.featured, ...rest] : team.featured;
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide">{title}</div>
        <div className="text-[9px] text-slate-600" style={mono}>MIN · PTS · REB · AST · 3PM</div>
      </div>
      {list.length === 0 && <div className="text-[11px] text-slate-600 py-2">— roster unavailable —</div>}
      <div className="space-y-0.5">
        {list.map((p, i) => {
          const lg = logs[p.id];
          return (
            <div key={p.id} className="flex items-center gap-2 text-[12px]">
              <span className="text-slate-600 w-4 shrink-0" style={mono}>{i + 1}</span>
              <span className="w-9 text-[10px] text-slate-500 shrink-0 inline-flex items-center gap-0.5" style={mono}>
                {p.pos}{p.isStarter ? "*" : ""}
                {p.depthConfirmed === false && <span className="text-amber-500" title="No confirmed depth chart for this team, so the order is the roster listing, not verified starters">?</span>}
              </span>
              <button onClick={onPlayerClick ? () => onPlayerClick({ id: p.id, name: p.name }) : undefined} className="flex-1 text-left truncate hover:text-sky-300" title="Open player analysis">{p.name}</button>
              <InjBadge status={p.injuryStatus} />
              <span className="text-slate-400 text-[11px]" style={mono}>{f1(per(lg, "min"))} · {f1(per(lg, "pts"))} · {f1(per(lg, "reb"))} · {f1(per(lg, "ast"))} · {f1(per(lg, "fg3m"))}</span>
              <button onClick={() => onAdd(p.id)} className="text-emerald-500 hover:text-emerald-300 font-bold w-5 text-center" title="manual bet">+</button>
            </div>
          );
        })}
      </div>
      {(team.roster || []).length > (team.featured || []).length && (
        <button onClick={() => setShowAll((v) => !v)} className="mt-1 text-[10px] text-slate-500 hover:text-slate-300">{showAll ? "show rotation only" : `show full roster (${team.roster.length})`}</button>
      )}
    </div>
  );
}
export function SlateDetail({ g, d, draftFromGame, goToAnalysis }) {
  const gp = gameProbs(d.lambdaH, d.lambdaA);
  const name = (pid) => { const p = [...d.home.roster, ...d.away.roster].find((x) => x.id === pid); return p ? p.name : ""; };
  return (
    <>
      <div className="flex flex-wrap gap-2 mt-3 text-[11px]" style={mono}>
        <Env label={`${g.away} REST`} v={d.away.rest.backToBack ? "B2B" : `${d.away.rest.daysRest}d`} hot={d.away.rest.backToBack} />
        <Env label={`${g.home} REST`} v={d.home.rest.backToBack ? "B2B" : `${d.home.rest.daysRest}d`} hot={d.home.rest.backToBack} />
        {d.away.standings && d.away.standings.ppgFor ? <Env label={`${g.away} PPG`} v={`${f1(d.away.standings.ppgFor)}/${f1(d.away.standings.ppgAgainst)}`} /> : null}
        {d.home.standings && d.home.standings.ppgFor ? <Env label={`${g.home} PPG`} v={`${f1(d.home.standings.ppgFor)}/${f1(d.home.standings.ppgAgainst)}`} /> : null}
      </div>
      <div className="mt-3 bg-slate-950/60 border border-slate-800 rounded-lg p-3">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">MODEL GAME LINE</div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[13px]" style={mono}>
          <span className="text-slate-300">proj score <b className="text-sky-300">{g.away} {d.lambdaA.toFixed(1)} – {d.lambdaH.toFixed(1)} {g.home}</b></span>
          <span>{g.home} <b className="text-emerald-400">{pct(gp.home)}</b> <span className="text-slate-600">({probToAmerican(gp.home)})</span></span>
          <span>{g.away} <b className="text-emerald-400">{pct(gp.away)}</b> <span className="text-slate-600">({probToAmerican(gp.away)})</span></span>
          <span>total <b className="text-sky-300">{gp.totalLambda.toFixed(1)}</b></span>
        </div>
        <div className="text-[10px] text-slate-600 mt-1.5">team scoring environment (points for / against per game, shrunk to league) × home court. Win % splits regulation ties evenly for OT.</div>
      </div>
      <div className="grid sm:grid-cols-2 gap-3 mt-3">
        <TeamCol title={`${g.away} (away)`} team={d.away} logs={d.logs} onAdd={(pid) => draftFromGame(g, "player", pid, name(pid))} onPlayerClick={goToAnalysis} />
        <TeamCol title={`${g.home} (home)`} team={d.home} logs={d.logs} onAdd={(pid) => draftFromGame(g, "player", pid, name(pid))} onPlayerClick={goToAnalysis} />
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
        <div className="text-sm text-slate-300">Search any NBA player by name.</div>
        <div className="text-[11px] text-slate-600 mt-2" style={mono}>season · last 10 · game log</div>
      </div>
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">SLATE CONTEXT</div>
        <div className="text-sm text-slate-300">{(games || []).length} game(s) on this date, {live} live.</div>
        <div className="text-[11px] text-slate-600 mt-2" style={mono}>rest · blowout risk · injuries · usage</div>
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
  const yn = isYesNoType(r.type);
  return (
    <div className="bg-slate-950/50 border border-slate-800 rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-2 text-[12px]" style={mono}>
        <div className="flex-1 text-slate-300">{r.type} {yn ? null : <span className="text-slate-500">{r.line}</span>}</div>
        <div className="text-sky-300 w-24 text-right">{yn ? `p ${pct(r.proj)}` : `proj ${r.proj != null ? r.proj.toFixed(2) : "—"}`}</div>
        <div className="w-36 text-right text-slate-400">{yn ? "yes" : "o"} {pct(r.overP)} <span className="text-slate-600">({r.overFair})</span></div>
        {!yn && <div className="w-36 text-right text-slate-400">u {pct(r.underP)} <span className="text-slate-600">({r.underFair})</span></div>}
        {r.calc ? <button onClick={() => setShow((s) => !s)} className="text-[11px] text-slate-500 hover:text-emerald-300 border border-slate-700 rounded px-2 py-0.5">{show ? "hide" : "math"}</button> : null}
      </div>
      {show && <MathPanel r={{ ...r, modelP: r.overP, side: "over", fair: r.overFair, odds: null, b: 0, edge: 0, novig: null }} />}
    </div>
  );
}
export function PlayerProfilePanel({ profile, spot, detail, projections, boardEntries, boardGameCount, book, oddsLoading, oddsReady, onFetchOdds, myBets, onTrack, showProjBar }) {
  const p = profile.player;
  const log = profile.log;
  const s = log.season, r = log.recent;
  const pg = (o, k, n) => (o && n ? (o[k] / n).toFixed(1) : "—");
  const rows = (profile.logs.cur || []).filter((x) => x.min > 0).concat((profile.logs.prior || []).filter((x) => x.min > 0)).slice(0, 12);
  const injury = detail && detail.ready ? ([...(detail.home.roster || []), ...(detail.away.roster || [])].find((x) => x.id === p.id) || {}).injuryStatus : null;
  return (
    <div className="space-y-3">
      <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <img src={`https://a.espncdn.com/i/headshots/nba/players/full/${p.id}.png`} alt="" className="w-16 h-16 rounded-xl object-cover border border-slate-700 bg-slate-800 flex-shrink-0" onError={(e) => { e.currentTarget.style.display = "none"; }} />
          <div className="flex-1">
            <div className="text-xl font-black">{p.name} <span className="text-slate-500 text-sm font-semibold">{[p.jersey ? `#${p.jersey}` : "", p.pos, p.teamAbbr].filter(Boolean).join(" · ")}</span> <InjBadge status={injury} /></div>
            <div className="text-[11px] text-slate-500" style={mono}>{[p.teamName, spot ? `on slate: ${spot.game.away}@${spot.game.home} (${spot.side})` : "not on the selected slate", `${log.curGames} gm this season + ${log.priorGames} last season in the model base`].filter(Boolean).join(" · ")}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mt-3">
          <StatCard label="MIN" v={pg(s, "min", s.g)} />
          <StatCard label="PTS" v={pg(s, "pts", s.g)} />
          <StatCard label="REB" v={pg(s, "reb", s.g)} />
          <StatCard label="AST" v={pg(s, "ast", s.g)} />
          <StatCard label="3PM" v={pg(s, "fg3m", s.g)} />
        </div>
        <div className="text-[10px] text-slate-600 mt-2" style={mono}>per game, model base (this season + last season, which fades from full to half weight over the first 15 games){r.games ? ` · last ${r.games}: ${pg(r, "pts", r.games)} pts, ${pg(r, "min", r.games)} min` : ""}</div>
      </div>

      {spot && (
        <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <div className="text-[10px] text-slate-500 font-bold tracking-wide">MODEL PROJECTIONS · {spot.game.away}@{spot.game.home}</div>
            <button onClick={onFetchOdds} disabled={oddsLoading === spot.game.pk} className={`text-[11px] font-bold rounded px-2 py-1 ${oddsReady ? "bg-slate-700 text-slate-200" : "bg-sky-600 hover:bg-sky-500 text-white"}`}>{oddsLoading === spot.game.pk ? "…" : oddsReady ? `↻ ${book} odds` : `get ${book} odds`}</button>
          </div>
          {!detail || !detail.ready ? <div className="text-[11px] text-slate-500" style={mono}>loading game context…</div>
            : projections.length === 0 ? <div className="text-[11px] text-slate-500">No model context for this player in this game.</div>
            : <div className="space-y-1">{projections.map((x) => <ProjectionRow key={x.type} r={x} />)}</div>}
          {boardEntries.length > 0 && (
            <div className="mt-3 space-y-2">
              <div className="text-[10px] text-slate-500 font-bold tracking-wide">PRICED ON THE BOARD ({boardEntries.length} of {boardGameCount} for this game)</div>
              {boardEntries.map((e) => <BoardRow key={e.id} e={e} tracked={myBets.some((b) => b.key === e.id)} onTrack={() => onTrack(e)} showProjBar={showProjBar} />)}
            </div>
          )}
        </div>
      )}

      <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">GAME LOG</div>
        {!rows.length ? <div className="text-[11px] text-slate-500">No games logged.</div> : (
          <div className="overflow-x-auto"><table className="w-full text-[12px]" style={mono}>
            <thead><tr className="text-slate-500 text-[10px]">{["date", "opp", "res", "MIN", "PTS", "REB", "AST", "3PM", "STL", "BLK", "TO"].map((h, i) => <th key={h} className={`${i < 3 ? "text-left" : "text-right"} font-semibold py-1`}>{h}</th>)}</tr></thead>
            <tbody>{rows.map((x) => (
              <tr key={x.eventId} className="border-t border-slate-800 text-slate-300">
                <td className="py-1 text-slate-400">{x.date ? new Date(x.date).toLocaleDateString([], { month: "numeric", day: "numeric", year: "2-digit" }) : "—"}</td>
                <td>{x.atVs === "@" ? "@" : "vs"} {x.opp || "—"}</td>
                <td className={x.result === "W" ? "text-emerald-400" : x.result === "L" ? "text-rose-400" : "text-slate-400"}>{x.result || ""} {x.score || ""}{x.postseason ? " (P)" : ""}</td>
                {["min", "pts", "reb", "ast", "fg3m", "stl", "blk", "tov"].map((k) => <td key={k} className="text-right">{x[k] != null ? (k === "min" ? Math.round(x[k]) : x[k]) : "—"}</td>)}
              </tr>))}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
