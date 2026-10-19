/* NHL-specific UI: status chip, score line, slate detail (team context, model game line, rosters,
   goalies) and the Player Analysis panel. Styling follows the MLB page exactly. */
import { useState } from "react";
import { pct } from "../../core/math";
import { Env, StatCard, mono } from "../../core/ui";
import { BoardRow as CoreBoardRow, MyBetRow as CoreMyBetRow, TrendCard as CoreTrendCard } from "../../core/cards";
import { isLineType } from "./config";
import { gameProbs } from "./engine";
import { trendValueForGame } from "./data";

export const getDeltaSignal = () => null;   // no NHL delta thresholds until there is settled data to fit them
export function BoardRow(props) { return <CoreBoardRow {...props} isLineType={isLineType} getDeltaSignal={getDeltaSignal} />; }
export function MyBetRow(props) { return <CoreMyBetRow {...props} isLineType={isLineType} />; }
export const TrendCard = CoreTrendCard;

export const STATUS = {
  GOALIES: { t: "GOALIES PROBABLE", c: "bg-emerald-500 text-slate-950" },
  SCHEDULED: { t: "SCHEDULED", c: "bg-slate-700 text-slate-300" },
  LIVE: { t: "LIVE", c: "bg-rose-500 text-white" },
  FINAL: { t: "FINAL", c: "bg-slate-600 text-slate-200" },
  POSTPONED: { t: "POSTPONED", c: "bg-amber-600 text-slate-950" },
  MANUAL: { t: "MANUAL", c: "bg-violet-500 text-white" },
};
export function Chip({ s }) { const m = STATUS[s] || STATUS.SCHEDULED; return <span className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wide ${m.c}`}>{m.t}</span>; }

const periodLabel = (p) => (p == null ? "" : p <= 3 ? `P${p}` : p === 4 ? "OT" : "SO");
export function ScoreLine({ g }) {
  const a = g.awayScore, h = g.homeScore;
  if (g.status === "FINAL") {
    const extra = g.period && g.period > 3 ? `/${periodLabel(g.period)}` : "";
    return <div className="text-[12px] truncate" style={mono}><span className={a > h ? "text-slate-100 font-bold" : "text-slate-400"}>{g.away} {a}</span><span className="text-slate-600">, </span><span className={h > a ? "text-slate-100 font-bold" : "text-slate-400"}>{g.home} {h}</span><span className="text-slate-500"> · Final{extra}</span></div>;
  }
  return <div className="text-[12px] truncate" style={mono}><span className="text-slate-200">{g.away} {a}</span><span className="text-slate-600">, </span><span className="text-slate-200">{g.home} {h}</span><span className="text-rose-400"> · {periodLabel(g.period)} {g.clock || ""}</span></div>;
}
export function GameSubtitle({ g }) {
  const gn = (x) => (x ? x.name : "TBD");
  return <div className="text-[11px] text-slate-500 truncate">G: {gn(g.awayGoalie)} vs {gn(g.homeGoalie)}{g.awayRec || g.homeRec ? <span className="text-slate-600"> · {g.awayRec || "—"} / {g.homeRec || "—"}</span> : null}</div>;
}

const f1 = (x) => (x == null || isNaN(x) ? "—" : Number(x).toFixed(1));
const f2 = (x) => (x == null || isNaN(x) ? "—" : Number(x).toFixed(2));
const svFmt = (x) => (x == null ? "—" : x.toFixed(3).replace(/^0/, ""));

function TeamCol({ title, list, onAdd, onPlayerClick }) {
  const [showAll, setShowAll] = useState(false);
  const active = list.filter((p) => p.gp > 0 || p.rates.priorGames > 0);
  const shown = showAll ? list : active.slice(0, 20);
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide">{title}</div>
        <div className="text-[9px] text-slate-600" style={mono}>GP · G-A-P · SOG/g · TOI</div>
      </div>
      {list.length === 0 && <div className="text-[11px] text-slate-600 py-2">— roster unavailable —</div>}
      <div className="space-y-0.5">
        {shown.map((p) => (
          <div key={p.id} className="flex items-center gap-2 text-[12px]">
            <span className="text-slate-600 w-5 text-[10px]" style={mono}>{p.pos}</span>
            <button onClick={onPlayerClick ? () => onPlayerClick({ id: p.id, name: p.name }) : undefined} className="flex-1 text-left truncate hover:text-sky-300" title="Open player analysis">{p.name}</button>
            {p.injury && <span className="text-[9px] px-1 rounded bg-rose-900/50 text-rose-300" style={mono}>{p.injury}</span>}
            <span className="text-slate-400 text-[11px]" style={mono}>{p.gp} · {p.season.g}-{p.season.a}-{p.season.g + p.season.a} · {f1(p.rates.sog)} · {f1(p.rates.recentToi || p.rates.toi)}</span>
            <button onClick={() => onAdd(p.id)} className="text-emerald-500 hover:text-emerald-300 font-bold w-5 text-center" title="manual bet">+</button>
          </div>
        ))}
      </div>
      {list.length > shown.length || showAll ? <button onClick={() => setShowAll((v) => !v)} className="mt-1 text-[10px] text-slate-500 hover:text-slate-300">{showAll ? "show regulars only" : `show full roster (${list.length})`}</button> : null}
    </div>
  );
}
function GoalieCard({ label, goalies, expShots, onAdd, onPlayerClick }) {
  const starter = goalies.find((x) => x.starter) || null;
  const others = goalies.filter((x) => x !== starter);
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">{label}</div>
      {!starter ? <div className="text-[11px] text-slate-600">starter not posted{others.length ? ` · ${others.map((o) => o.name).join(", ")}` : ""}</div> : (
        <div className="flex items-center justify-between">
          <div>
            <button onClick={onPlayerClick ? () => onPlayerClick({ id: starter.id, name: starter.name }) : undefined} className="text-[12px] font-semibold text-left hover:text-sky-300">{starter.name} <span className="text-[9px] text-emerald-400 font-bold">{starter.starterStatus || "PROBABLE"}</span></button>
            <div className="text-[11px] text-slate-400" style={mono}>{svFmt(starter.rates.rawSvPct)} SV% ({starter.rates.starts} GS) · model {svFmt(starter.rates.svPct)} · {f2(starter.rates.gaa)} GAA · ~{f1(expShots * starter.rates.svPct * 0.97)} saves</div>
          </div>
          <button onClick={() => onAdd(starter.id)} className="text-emerald-500 hover:text-emerald-300 font-bold text-lg" title="manual bet">+</button>
        </div>
      )}
      {starter && others.length > 0 && <div className="text-[10px] text-slate-600 mt-1">backup: {others.map((o) => o.name).join(", ")}</div>}
    </div>
  );
}
export function SlateDetail({ g, d, draftFromGame, goToAnalysis }) {
  const gp = gameProbs(d.lambdaH, d.lambdaA);
  // forwards first, then defense, each by ice time
  const side = (s) => Object.values(d.skaters).filter((p) => p.side === s).sort((a, b) => (a.group === "D" ? 1 : 0) - (b.group === "D" ? 1 : 0) || (b.rates.recentToi || b.rates.toi || 0) - (a.rates.recentToi || a.rates.toi || 0));
  const gl = (s) => Object.values(d.goalies).filter((p) => p.side === s).sort((a, b) => Number(b.starter) - Number(a.starter) || b.rates.starts - a.rates.starts);
  const T = d.teams;
  return (
    <>
      <div className="flex flex-wrap gap-2 mt-3 text-[11px]" style={mono}>
        <Env label={`${g.away} GF/G`} v={f2(T.away.gf)} hot={T.away.gf >= 3.4} cold={T.away.gf <= 2.7} />
        <Env label={`${g.away} GA/G`} v={f2(T.away.ga)} hot={T.away.ga >= 3.4} cold={T.away.ga <= 2.7} />
        <Env label={`${g.home} GF/G`} v={f2(T.home.gf)} hot={T.home.gf >= 3.4} cold={T.home.gf <= 2.7} />
        <Env label={`${g.home} GA/G`} v={f2(T.home.ga)} hot={T.home.ga >= 3.4} cold={T.home.ga <= 2.7} />
        <Env label="EXP SOG" v={`${f1(d.shotsA)}–${f1(d.shotsH)}`} hot={d.shotsA + d.shotsH >= 62} cold={d.shotsA + d.shotsH <= 52} />
      </div>
      <div className="mt-3 bg-slate-950/60 border border-slate-800 rounded-lg p-3">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">MODEL GAME LINE</div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[13px]" style={mono}>
          <span className="text-slate-300">proj score <b className="text-sky-300">{g.away} {d.lambdaA.toFixed(1)} – {d.lambdaH.toFixed(1)} {g.home}</b></span>
          <span>{g.home} <b className="text-emerald-400">{pct(gp.home)}</b></span>
          <span>{g.away} <b className="text-emerald-400">{pct(gp.away)}</b></span>
          <span>total <b className="text-sky-300">{gp.totalLambda.toFixed(1)}</b></span>
          <span className="text-slate-500">OT {pct(gp.regTie)}</span>
        </div>
        <div className="text-[10px] text-slate-600 mt-1.5">team goal rates (shrunk to league) × opponent defense and starting goalie × home ice. Win % includes OT/shootout.</div>
      </div>
      <div className="grid sm:grid-cols-2 gap-3 mt-3">
        <TeamCol title={`${g.away} (away)`} list={side("away")} onAdd={(pid) => draftFromGame(g, "skater", pid, d.skaters[pid] && d.skaters[pid].name)} onPlayerClick={goToAnalysis} />
        <TeamCol title={`${g.home} (home)`} list={side("home")} onAdd={(pid) => draftFromGame(g, "skater", pid, d.skaters[pid] && d.skaters[pid].name)} onPlayerClick={goToAnalysis} />
      </div>
      <div className="grid sm:grid-cols-2 gap-3 mt-3">
        <GoalieCard label={`${g.away} G`} goalies={gl("away")} expShots={d.shotsH} onAdd={(pid) => draftFromGame(g, "goalie", pid, d.goalies[pid].name)} onPlayerClick={goToAnalysis} />
        <GoalieCard label={`${g.home} G`} goalies={gl("home")} expShots={d.shotsA} onAdd={(pid) => draftFromGame(g, "goalie", pid, d.goalies[pid].name)} onPlayerClick={goToAnalysis} />
      </div>
    </>
  );
}

/* ---------------- Player Analysis ---------------- */
export function PlayerAnalysisIntro({ games, boardCount }) {
  const live = (games || []).filter((g) => g.status === "LIVE").length;
  const goalies = (games || []).filter((g) => g.homeGoalie || g.awayGoalie).length;
  return (
    <div className="grid sm:grid-cols-3 gap-3">
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">PLAYER FILE</div>
        <div className="text-sm text-slate-300">Search any NHL player by name.</div>
        <div className="text-[11px] text-slate-600 mt-2" style={mono}>season · recent windows · game log</div>
      </div>
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">SLATE CONTEXT</div>
        <div className="text-sm text-slate-300">{goalies} game(s) with probable goalies, {live} live.</div>
        <div className="text-[11px] text-slate-600 mt-2" style={mono}>opponent · goalie · goal environment</div>
      </div>
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">MARKET CONTEXT</div>
        <div className="text-sm text-slate-300">{boardCount} board candidate(s) loaded.</div>
        <div className="text-[11px] text-slate-600 mt-2" style={mono}>odds · no-vig · edge · EV</div>
      </div>
    </div>
  );
}
function windowAgg(rows, n, goalie) {
  const r = rows.slice(0, n);
  const sum = (f) => r.reduce((a, x) => a + (f(x.s) || 0), 0);
  if (goalie) { const sa = sum((s) => s.shotsAgainst), sv = sum((s) => s.saves); return { n: r.length, starts: sum((s) => s.gameStarted), sv: sa ? sv / sa : null, saves: r.length ? sv / r.length : null, gaa: r.length ? sum((s) => s.goalsAgainst) / r.length : null }; }
  return { n: r.length, g: sum((s) => s.goals), a: sum((s) => s.assists), sog: r.length ? sum((s) => s.shotsTotal) / r.length : null, ppp: sum((s) => (s.powerPlayGoals || 0) + (s.powerPlayAssists || 0)), toi: r.length ? sum((s) => s.timeOnIcePerGame) / r.length : null };
}
export function PlayerProfilePanel({ profile, spot, detail, projections, boardEntries, boardGameCount, book, oddsLoading, oddsReady, onFetchOdds, myBets, onTrack, showProjBar }) {
  const p = profile.player;
  const goalie = profile.kind === "goalie";
  const cur = (profile.logs.cur || []).filter((r) => !r.postseason);
  const prior = (profile.logs.prior || []).filter((r) => !r.postseason);
  const season = windowAgg(cur, 999, goalie), last = windowAgg(prior, 999, goalie);
  const wins = [["Last 5", windowAgg(cur, 5, goalie)], ["Last 10", windowAgg(cur, 10, goalie)], ["Season", season], ["Last season", last]];
  const log = [...cur, ...prior].slice(0, 12);
  const types = goalie ? ["Saves"] : ["Shots on Goal", "Goals", "Assists", "Points", "Power Play Points"];
  return (
    <div className="space-y-3">
      <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-4">
        <div className="flex items-end justify-between flex-wrap gap-2">
          <div>
            <div className="text-xl font-black">{p.name} <span className="text-slate-500 text-sm font-semibold">{[p.jersey ? `#${p.jersey}` : "", p.pos, p.teamAbbr].filter(Boolean).join(" · ")}</span></div>
            <div className="text-[11px] text-slate-500" style={mono}>{[p.teamName, p.age ? `age ${p.age}` : "", spot ? `on slate: ${spot.game.away}@${spot.game.home} (${spot.side})` : "not on the selected slate"].filter(Boolean).join(" · ")}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
          {goalie ? (<>
            <StatCard label="GP / GS" v={`${season.n} / ${season.starts}`} />
            <StatCard label="SV%" v={svFmt(season.sv)} good={season.sv != null ? season.sv >= 0.905 : undefined} />
            <StatCard label="GAA" v={f2(season.gaa)} />
            <StatCard label="Saves / GP" v={f1(season.saves)} />
          </>) : (<>
            <StatCard label="GP" v={season.n} />
            <StatCard label="G-A-P" v={`${season.g}-${season.a}-${season.g + season.a}`} />
            <StatCard label="SOG / GP" v={f2(season.sog)} />
            <StatCard label="TOI" v={f1(season.toi)} />
          </>)}
        </div>
      </div>

      <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">RECENT WINDOWS</div>
        <div className="overflow-x-auto"><table className="w-full text-[12px]" style={mono}>
          <thead><tr className="text-slate-500 text-[10px]"><th className="text-left font-semibold py-1">window</th><th className="text-right">GP</th>{goalie ? <><th className="text-right">GS</th><th className="text-right">SV%</th><th className="text-right">GAA</th><th className="text-right">SV/G</th></> : <><th className="text-right">G</th><th className="text-right">A</th><th className="text-right">P/G</th><th className="text-right">SOG/G</th><th className="text-right">PPP</th><th className="text-right">TOI</th></>}</tr></thead>
          <tbody>{wins.map(([lbl, w]) => (
            <tr key={lbl} className="border-t border-slate-800 text-slate-300"><td className="py-1 text-slate-400">{lbl}</td><td className="text-right">{w.n}</td>
              {goalie ? <><td className="text-right">{w.starts}</td><td className="text-right">{svFmt(w.sv)}</td><td className="text-right">{f2(w.gaa)}</td><td className="text-right">{f1(w.saves)}</td></>
                : <><td className="text-right">{w.g}</td><td className="text-right">{w.a}</td><td className="text-right">{w.n ? f2((w.g + w.a) / w.n) : "—"}</td><td className="text-right">{f2(w.sog)}</td><td className="text-right">{w.ppp}</td><td className="text-right">{f1(w.toi)}</td></>}
            </tr>))}</tbody>
        </table></div>
      </div>

      {spot && (
        <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <div className="text-[10px] text-slate-500 font-bold tracking-wide">MODEL PROJECTIONS · {spot.game.away}@{spot.game.home}</div>
            <button onClick={onFetchOdds} disabled={oddsLoading === spot.game.pk} className={`text-[11px] font-bold rounded px-2 py-1 ${oddsReady ? "bg-slate-700 text-slate-200" : "bg-sky-600 hover:bg-sky-500 text-white"}`}>{oddsLoading === spot.game.pk ? "…" : oddsReady ? `↻ ${book} odds` : `get ${book} odds`}</button>
          </div>
          {!detail || !detail.ready ? <div className="text-[11px] text-slate-500" style={mono}>loading game context…</div>
            : projections.length === 0 ? <div className="text-[11px] text-slate-500">No model context for this player in this game (not on the active roster).</div>
            : <div className="space-y-1">{projections.map((r) => (
              <div key={r.type} className="flex items-center gap-3 text-[12px] border-t border-slate-800 pt-1" style={mono}>
                <div className="flex-1 text-slate-300">{r.type} <span className="text-slate-500">{r.line}</span></div>
                <div className="text-sky-300 w-20 text-right">proj {r.proj != null ? r.proj.toFixed(2) : "—"}</div>
                <div className="w-36 text-right text-slate-400">o {pct(r.overP)} <span className="text-slate-600">({r.overFair})</span></div>
                <div className="w-36 text-right text-slate-400">u {pct(r.underP)} <span className="text-slate-600">({r.underFair})</span></div>
              </div>))}</div>}
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
        {log.length === 0 ? <div className="text-[11px] text-slate-500">No games logged.</div> : (
          <div className="overflow-x-auto"><table className="w-full text-[12px]" style={mono}>
            <thead><tr className="text-slate-500 text-[10px]"><th className="text-left font-semibold py-1">date</th><th className="text-left">opp</th><th className="text-left">res</th>{types.map((t) => <th key={t} className="text-right">{t === "Shots on Goal" ? "SOG" : t === "Power Play Points" ? "PPP" : t === "Assists" ? "A" : t === "Goals" ? "G" : t === "Points" ? "P" : "SV"}</th>)}<th className="text-right">TOI</th></tr></thead>
            <tbody>{log.map((r) => (
              <tr key={r.eventId} className="border-t border-slate-800 text-slate-300">
                <td className="py-1 text-slate-400">{r.date ? new Date(r.date).toLocaleDateString([], { month: "numeric", day: "numeric", year: "2-digit" }) : "—"}</td>
                <td>{r.atVs === "@" ? "@" : "vs"} {r.opp || "—"}</td><td className={r.result === "W" ? "text-emerald-400" : r.result === "L" ? "text-rose-400" : "text-slate-400"}>{r.result || ""} {r.score || ""}</td>
                {types.map((t) => <td key={t} className="text-right">{trendValueForGame(r, t) ?? "—"}</td>)}
                <td className="text-right">{f1(r.s.timeOnIcePerGame)}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
