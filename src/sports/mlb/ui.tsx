import { useMemo, useState } from "react";
import { CATEGORY_ORDER, isLineType } from "./config";
import { displayNum, displayRate, outsToIp, safeDiv } from "./data";
import { calculatePlatoonAdjustment, ipToOuts } from "./engine";
import { fmtOdds, pct } from "../../core/math";
import { profitUnits } from "./settle";
import { HotBadge, TrendPill, mono, projMeta } from "../../core/ui";


/* ---------------------- status + small UI ---------------------- */
export const STATUS = {
  POSTED: { t: "LINEUP POSTED", c: "bg-emerald-500 text-slate-950" },
  PARTIAL: { t: "PARTIAL", c: "bg-teal-600 text-white" },
  PENDING: { t: "PENDING · PROBABLES", c: "bg-amber-500 text-slate-950" },
  SCHEDULED: { t: "NO DATA YET", c: "bg-slate-700 text-slate-300" },
  LIVE: { t: "LIVE", c: "bg-rose-500 text-white" },
  FINAL: { t: "FINAL", c: "bg-slate-600 text-slate-200" },
  MANUAL: { t: "MANUAL", c: "bg-violet-500 text-white" },
};
export function Chip({ s }) { const m = STATUS[s] || STATUS.SCHEDULED; return <span className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wide ${m.c}`}>{m.t}</span>; }
export const STAT_ORDER = CATEGORY_ORDER;

export function ScoreLine({ g }) {
  const a = g.awayScore, h = g.homeScore;
  if (g.status === "FINAL") {
    const extra = g.inning && g.inning > 9 ? `/F${g.inning}` : "";
    return <div className="text-[12px] truncate" style={mono}><span className={a > h ? "text-slate-100 font-bold" : "text-slate-400"}>{g.away} {a}</span><span className="text-slate-600">, </span><span className={h > a ? "text-slate-100 font-bold" : "text-slate-400"}>{g.home} {h}</span><span className="text-slate-500"> · Final{extra}</span></div>;
  }
  const st = (g.inningState || "").toLowerCase();
  const half = st.startsWith("mid") ? "Mid" : st.startsWith("end") ? "End" : (st.startsWith("top") ? "Top" : "Bot");
  return <div className="text-[12px] truncate" style={mono}><span className="text-slate-200">{g.away} {a}</span><span className="text-slate-600">, </span><span className="text-slate-200">{g.home} {h}</span><span className="text-rose-400"> · {half} {g.inning}{g.outs != null ? ` · ${g.outs} out` : ""}</span></div>;
}

/* ---------------------- subcomponents ---------------------- */
export function PlayerAnalysisIntro({ games, boardCount }) {
  const live = (games || []).filter((g) => g.status === "LIVE").length;
  const posted = (games || []).filter((g) => g.status === "POSTED" || g.status === "PARTIAL").length;
  return (
    <div className="grid sm:grid-cols-3 gap-3">
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">PLAYER FILE</div>
        <div className="text-sm text-slate-300">Search any MLB player by name.</div>
        <div className="text-[11px] text-slate-600 mt-2" style={mono}>season · recent windows · splits · Statcast</div>
      </div>
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">SLATE CONTEXT</div>
        <div className="text-sm text-slate-300">{posted} posted/partial lineup game(s), {live} live.</div>
        <div className="text-[11px] text-slate-600 mt-2" style={mono}>matchup · park · weather · BvP</div>
      </div>
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">MARKET CONTEXT</div>
        <div className="text-sm text-slate-300">{boardCount} board candidate(s) loaded.</div>
        <div className="text-[11px] text-slate-600 mt-2" style={mono}>odds · no-vig · edge · EV</div>
      </div>
    </div>
  );
}
export function PlayerProfilePanel({ profile, spot, detail, projections, boardEntries, boardGameCount, book, oddsLoading, oddsReady, onFetchOdds, myBets, onTrack, showProjBar }) {
  const p = profile.player;
  const isPitcher = profile.kind === "pitcher";
  const hasSlate = !!spot;
  const slateReady = hasSlate && detail && detail.ready;
  const canFetchOdds = hasSlate && spot.game && !spot.game.manual && spot.game.status !== "FINAL";
  const hSeason = profile.hitterSeason;
  const pSeason = profile.pitcherSeason;
  const [mktSort, setMktSort] = useState("ev_desc");
  const sortedMkts = useMemo(() => {
    const getDelta = (e: any) => (e.proj ?? 0) - parseFloat(e.line ?? 0);
    const cmps: Record<string, (a: any, b: any) => number> = {
      ev_desc: (a, b) => (b.ev ?? -9) - (a.ev ?? -9),
      proj_desc: (a, b) => (b.proj ?? -9) - (a.proj ?? -9),
      edge_desc: (a, b) => (b.edge ?? -9) - (a.edge ?? -9),
      delta_desc: (a, b) => getDelta(b) - getDelta(a),
      type: (a, b) => (a.type || "").localeCompare(b.type || ""),
    };
    return cmps[mktSort] ? [...boardEntries].sort(cmps[mktSort]) : boardEntries;
  }, [boardEntries, mktSort]);
  return (
    <div className="space-y-3">
      <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-start gap-3">
            <img
              src={`https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/${p.id}/headshot/67/current`}
              alt=""
              className="w-16 h-16 rounded-xl object-cover border border-slate-700 bg-slate-800 flex-shrink-0"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
            <div>
              <div className="text-2xl font-black tracking-tight">{p.name}</div>
              <div className="text-[11px] text-slate-500 mt-1" style={mono}>
                {p.teamAbbr || p.team || "FA"} · {p.positionName || p.position || (isPitcher ? "Pitcher" : "Hitter")} · bats {p.bats || "—"} / throws {p.throws || "—"}
                {p.active === false ? " · inactive" : ""}
              </div>
            </div>
          </div>
          {hasSlate ? <Chip s={spot.game.status} /> : <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-400">NOT ON SELECTED SLATE</span>}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
          {isPitcher ? (
            <>
              <MiniMetric label="ERA" value={pSeason ? pSeason.era : "—"} />
              <MiniMetric label="K/9" value={pSeason ? pSeason.k9.toFixed(1) : "—"} />
              <MiniMetric label="FIP" value={pSeason && pSeason.fip != null ? pSeason.fip.toFixed(2) : "—"} />
              <MiniMetric label="Exp IP" value={pSeason ? pSeason.expIp.toFixed(1) : "—"} />
            </>
          ) : (
            <>
              <MiniMetric label="AVG" value={hSeason ? hSeason.avg : "—"} />
              <MiniMetric label="OPS" value={hSeason ? hSeason.ops : "—"} />
              <MiniMetric label="HR" value={hSeason ? hSeason.hr : "—"} />
              <MiniMetric label="H+R+RBI/G" value={hSeason ? displayNum((hSeason.h + hSeason.r + hSeason.rbi) / Math.max(hSeason.g || 1, 1), 2) : "—"} />
            </>
          )}
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-3">
        <SlateProfileCard spot={spot} detail={detail} profile={profile} />
        <SeasonProfileCard profile={profile} />
        <StatcastProfileCard title={isPitcher ? "Pitcher Statcast" : "Batter Statcast"} sc={isPitcher ? profile.statcastPitcher : profile.statcastBatter} kind={isPitcher ? "pitcher" : "hitter"} />
      </div>

      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
        <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
          <div>
            <div className="text-xs font-bold text-slate-300">Model Projections</div>
            <div className="text-[11px] text-slate-500" style={mono}>{hasSlate ? (slateReady ? "using selected-slate matchup context" : "loading selected-slate context") : "available when player is in the selected slate"}</div>
          </div>
          {canFetchOdds && (
            oddsReady ? (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-emerald-500" style={mono}>✓ odds loaded</span>
                <button onClick={onFetchOdds} disabled={oddsLoading === spot.game.pk} className="text-[10px] text-slate-500 hover:text-slate-300 border border-slate-700 rounded px-2 py-1 disabled:opacity-40" title="Re-fetch from API (costs 1 credit)">
                  {oddsLoading === spot.game.pk ? "…" : "↺ refresh"}
                </button>
              </div>
            ) : (
              <button onClick={onFetchOdds} disabled={oddsLoading === spot.game.pk} className="bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white font-bold text-xs rounded-lg px-3 py-1.5">
                {oddsLoading === spot.game.pk ? "…" : `Get ${book} odds`}
              </button>
            )
          )}
        </div>
        {!hasSlate ? <div className="text-sm text-slate-500 py-5 text-center">No matchup on the selected date. Change the date if you want same-day projections.</div>
          : !slateReady ? <div className="text-sm text-slate-500 py-5 text-center" style={mono}>loading matchup detail…</div>
          : <div className="grid sm:grid-cols-2 gap-2">{projections.map((r) => <AnalysisProjectionRow key={r.type} r={r} />)}</div>}
      </div>

      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
        <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
          <div>
            <div className="text-xs font-bold text-slate-300">Current Board Markets</div>
            <div className="text-[11px] text-slate-500" style={mono}>{boardEntries.length ? `${boardEntries.length} priced player market(s) loaded` : boardGameCount ? "game odds loaded, no matched player markets" : "pull odds from Slate or this profile to populate market rows"}</div>
          </div>
          {boardEntries.length > 1 && (
            <div className="flex gap-1">
              {([["ev_desc","EV"],["proj_desc","Proj"],["edge_desc","Edge"],["delta_desc","Δ"],["type","Type"]] as const).map(([k, l]) => (
                <button key={k} onClick={() => setMktSort(k)} className={`text-[10px] px-2 py-1 rounded border ${mktSort === k ? "border-sky-700 text-sky-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`}>{l}</button>
              ))}
            </div>
          )}
        </div>
        {sortedMkts.length ? (
          <div className="space-y-2">
            {sortedMkts.map((e) => <BoardRow key={e.id} e={e} tracked={myBets.some((b) => b.key === e.id)} onTrack={() => onTrack(e)} showProjBar={showProjBar} />)}
          </div>
        ) : <div className="text-sm text-slate-500 py-5 text-center">No player-specific odds rows loaded yet.</div>}
      </div>

      <div className="grid lg:grid-cols-2 gap-3">
        <RecentWindowsCard title={isPitcher ? "Pitching Form" : "Hitting Form"} kind={isPitcher ? "pitcher" : "hitter"} rows={isPitcher ? profile.pitchingWindows : profile.hittingWindows} logs={isPitcher ? profile.pitcherLogs : profile.hitterLogs} projections={projections} boardEntries={boardEntries} />
        {isPitcher
          ? <div className="space-y-3"><PitcherSplitCard splits={profile.pitcherSplits} /><GameLogCard kind="pitcher" logs={profile.pitcherLogs} /></div>
          : <SplitAndLogCard splits={profile.hitterSplits} logs={profile.hitterLogs} />}
      </div>
    </div>
  );
}
export function MiniMetric({ label, value, good }) {
  return <div className="bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2"><div className="text-[9px] text-slate-500 font-bold tracking-wide">{label}</div><div className={`text-lg font-black ${good === true ? "text-emerald-400" : good === false ? "text-rose-400" : "text-slate-100"}`}>{value}</div></div>;
}
export function SlateProfileCard({ spot, detail, profile }) {
  const p = profile.player;
  if (!spot) return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">SLATE MATCHUP</div>
      <div className="text-sm text-slate-500">Not found on the selected date.</div>
    </div>
  );
  const g = spot.game;
  const rec = detail && detail.ready && spot.kind === "hitter" ? detail.hitters[String(p.id)] : null;
  const bvp = rec && rec.bvp;
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">SLATE MATCHUP</div>
      <div className="text-sm font-bold">{g.away} <span className="text-slate-600">@</span> {g.home}</div>
      <div className="text-[11px] text-slate-500 mt-1" style={mono}>
        {spot.kind === "hitter" ? `${spot.side === "home" ? g.home : g.away} lineup · spot ${spot.lineupIndex + 1} · vs ${(spot.oppSP && spot.oppSP.name) || "TBD"}` : `${spot.side === "home" ? g.home : g.away} starter · vs ${spot.oppTeam}`}
      </div>
      {detail && detail.ready && (
        <div className="mt-2 space-y-1 text-[11px]" style={mono}>
          <div className="text-slate-400">park RF <span className="text-sky-300">{detail.park.rf.toFixed(2)}</span>{detail.weather && !detail.park.dome ? ` · ${detail.weather.temp}° · wind ${detail.weather.wind}mph` : detail.park.dome ? " · dome" : ""}</div>
          <div className="text-slate-400">model score <span className="text-sky-300">{g.away} {detail.lambdaA.toFixed(1)} – {detail.lambdaH.toFixed(1)} {g.home}</span></div>
          {spot.kind === "hitter" && <div className="text-slate-400">BvP {bvp ? <span className="text-slate-200">{bvp.h}-{bvp.ab}{bvp.hr ? `, ${bvp.hr} HR` : ""}</span> : <span className="text-slate-600">no/limited history</span>}</div>}
        </div>
      )}
      {detail && detail.loading && <div className="text-[11px] text-slate-600 mt-2" style={mono}>loading detail…</div>}
    </div>
  );
}
export function SeasonProfileCard({ profile }) {
  const s = profile.kind === "pitcher" ? profile.pitcherSeason : profile.hitterSeason;
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">SEASON BASELINE</div>
      {!s ? <div className="text-sm text-slate-500">No season line returned.</div> : profile.kind === "pitcher" ? (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]" style={mono}>
          <span className="text-slate-500">IP <b className="text-slate-200">{displayNum(s.ip, 1)}</b></span>
          <span className="text-slate-500">GS <b className="text-slate-200">{s.gs}</b></span>
          <span className="text-slate-500">SO <b className="text-slate-200">{s.so}</b></span>
          <span className="text-slate-500">BB <b className="text-slate-200">{s.bb}</b></span>
          <span className="text-slate-500">K% <b className="text-slate-200">{s.bf ? pct(s.so / s.bf) : "—"}</b></span>
          <span className="text-slate-500">BB% <b className="text-slate-200">{s.bf ? pct(s.bb / s.bf) : "—"}</b></span>
          <span className="text-slate-500">WHIP <b className="text-slate-200">{s.ip ? displayNum((s.h + s.bb) / s.ip, 2) : "—"}</b></span>
          <span className="text-slate-500">HR/9 <b className="text-slate-200">{s.ip ? displayNum((s.hrA * 9) / s.ip, 2) : "—"}</b></span>
          <span className="text-slate-500">FIP <b className="text-slate-200">{s.fip != null ? s.fip.toFixed(2) : "—"}</b></span>
          <span className="text-slate-500">role <b className="text-slate-200">{s.role}</b></span>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]" style={mono}>
          <span className="text-slate-500">G <b className="text-slate-200">{s.g}</b></span>
          <span className="text-slate-500">PA <b className="text-slate-200">{s.pa || s.ab}</b></span>
          <span className="text-slate-500">AVG <b className="text-sky-300">{s.avg || "—"}</b></span>
          <span className="text-slate-500">OBP <b className="text-sky-300">{s.obp || "—"}</b></span>
          <span className="text-slate-500">SLG <b className="text-sky-300">{s.slg || "—"}</b></span>
          <span className="text-slate-500">OPS <b className="text-sky-300">{s.ops || "—"}</b></span>
          <span className="text-slate-500">HR <b className="text-slate-200">{s.hr}</b></span>
          <span className="text-slate-500">TB <b className="text-slate-200">{s.tb}</b></span>
          <span className="text-slate-500">K% <b className="text-slate-200">{s.pa ? pct(s.so / s.pa) : "—"}</b></span>
          <span className="text-slate-500">BB% <b className="text-slate-200">{s.pa ? pct(s.bb / s.pa) : "—"}</b></span>
        </div>
      )}
    </div>
  );
}
export function StatcastProfileCard({ title, sc, kind }) {
  const ok = sc && sc.verdict === "season_confirmed";
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">{title.toUpperCase()}</div>
      {!sc ? <div className="text-sm text-slate-500">Not fetched.</div> : (
        <>
          <div className={`text-sm font-bold ${ok ? "text-emerald-400" : "text-amber-400"}`}>{sc.verdict || "unknown"}</div>
          <div className="text-[10px] text-slate-600 mb-2" style={mono}>{sc.source || "savant"}{sc.cached ? " · cached" : ""}</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]" style={mono}>
            <span className="text-slate-500">BBE <b className="text-slate-200">{sc.bbe ?? "—"}</b></span>
            <span className="text-slate-500">pitches <b className="text-slate-200">{sc.pitches ?? "—"}</b></span>
            {kind === "hitter" && <span className="text-slate-500">xBA <b className="text-sky-300">{displayRate(sc.xba)}</b></span>}
            <span className="text-slate-500">xwOBA <b className="text-sky-300">{displayRate(kind === "pitcher" ? sc.xwobaAllowed : sc.xwoba)}</b></span>
            <span className="text-slate-500">EV <b className="text-slate-200">{displayNum(sc.avgEV, 1)}</b></span>
            <span className="text-slate-500">HH% <b className="text-slate-200">{sc.hardHitRate != null ? pct(sc.hardHitRate) : "—"}</b></span>
            <span className="text-slate-500">Brl% <b className="text-slate-200">{sc.barrelRate != null || sc.barrelAllowedRate != null ? pct(kind === "pitcher" ? sc.barrelAllowedRate : sc.barrelRate) : "—"}</b></span>
            {kind === "pitcher" && <span className="text-slate-500">CSW% <b className="text-slate-200">{sc.cswRate != null ? pct(sc.cswRate) : "—"}</b></span>}
          </div>
        </>
      )}
    </div>
  );
}
export function AnalysisProjectionRow({ r }) {
  const pm = projMeta(r.proj, r.line, "over");
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-bold">{r.type} <span className="text-slate-500 text-xs">line {r.line}</span></div>
          <div className="text-[11px] text-slate-500" style={mono}>proj <span className="text-sky-300">{r.proj != null ? r.proj.toFixed(2) : "—"}</span>{pm && <span className={`ml-1 ${pm.color}`}>vs line {pm.delta >= 0 ? "+" : "−"}{Math.abs(pm.delta).toFixed(2)}</span>}</div>
        </div>
        <div className="text-right text-[11px]" style={mono}>
          <div>Over <b className="text-emerald-300">{pct(r.overP)}</b> <span className="text-slate-600">{r.overFair}</span></div>
          <div>Under <b className="text-sky-300">{pct(r.underP)}</b> <span className="text-slate-600">{r.underFair}</span></div>
        </div>
      </div>
    </div>
  );
}
// projType: maps to the prop type string used in projections / boardEntries
// isOuts: true means the fn() returns outs (integer), display as IP string, and line is in outs
export const HITTER_CHART_CATS = [
  { key: "hits", label: "Hits",    fn: (s) => +s.hits || 0,                                          defaultLine: 0.5, projType: "Hits" },
  { key: "tb",   label: "TB",      fn: (s) => +s.totalBases || 0,                                    defaultLine: 1.5, projType: "Total Bases" },
  { key: "hr",   label: "HR",      fn: (s) => +s.homeRuns || 0,                                      defaultLine: 0.5, projType: "Home Run" },
  { key: "hrr",  label: "H+R+RBI", fn: (s) => (+s.hits || 0) + (+s.runs || 0) + (+s.rbi || 0),      defaultLine: 1.5, projType: "H+R+RBI" },
];
export const PITCHER_CHART_CATS = [
  { key: "k",  label: "Ks", fn: (s) => +s.strikeOuts || 0,                isOuts: false, defaultLine: 5.5,  projType: "Strikeouts" },
  { key: "ip", label: "IP", fn: (s) => ipToOuts(s.inningsPitched || "0"), isOuts: true,  defaultLine: 15,   projType: "Outs" },
  { key: "er", label: "ER", fn: (s) => +s.earnedRuns || 0,                isOuts: false, defaultLine: 2.5,  projType: null },
];
export function RecentWindowsCard({ title, kind, rows, logs, projections, boardEntries }) {
  const cats = kind === "pitcher" ? PITCHER_CHART_CATS : HITTER_CHART_CATS;
  const [win, setWin] = useState(20);
  const [catKey, setCatKey] = useState(cats[0].key);
  const [lineMode, setLineMode] = useState<"model"|"actual">("model");
  const cat = cats.find((c) => c.key === catKey) || cats[0];

  // Model projection line: use the player's projected value for this matchup
  const modelLine = (() => {
    if (!cat.projType || !projections || !projections.length) return cat.defaultLine;
    const p = projections.find((p) => p.type === cat.projType);
    return (p && p.proj != null) ? +p.proj.toFixed(2) : cat.defaultLine;
  })();

  // Actual market line: from loaded board entries (over/under share the same line)
  const actualLine = (() => {
    if (!cat.projType || !boardEntries || !boardEntries.length) return null;
    const e = boardEntries.find((e) => e.type === cat.projType);
    return e ? parseFloat(String(e.line)) : null;
  })();

  const hasActual = actualLine != null;
  // Only use actual mode when it's available; reset to model if it disappears
  const effectiveMode = (lineMode === "actual" && hasActual) ? "actual" : "model";
  const activeLine = effectiveMode === "actual" ? actualLine! : modelLine;

  // Format the active line for display (IP category shows outs→IP notation)
  const fmtLineLabel = (l: number) => {
    if (cat.isOuts) return `${outsToIp(Math.round(l))} (${l} outs)`;
    return typeof l === "number" && !Number.isInteger(l) ? l.toFixed(2) : String(l);
  };
  // Short version for SVG axis label
  const fmtLineShort = (l: number) => cat.isOuts ? outsToIp(Math.round(l)) : String(l);

  // Bar values — newest-first in logs, reversed to oldest→newest left-to-right
  const gameLogs = (logs || []).slice(0, win).reverse();
  const barVals = gameLogs.map((x) => ({
    raw: cat.fn(x.stat || {}),
    date: x.date || "",
    opp: x.opponent || "",
    homeAway: x.homeAway || "",
  }));
  // Display label per bar
  const fmtBarVal = (v: number) => cat.isOuts ? outsToIp(v) : (Number.isInteger(v) ? String(v) : v.toFixed(1));

  const n = barVals.length;
  const hitCount = barVals.filter((b) => b.raw >= activeLine).length;
  const maxVal = Math.max(activeLine * 1.7, ...barVals.map((b) => b.raw), 1);

  const W = 460, H = 120, padL = 28, padR = 6, padT = 14, padB = 22;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const xOf = (i: number) => padL + (i + 0.5) * (chartW / Math.max(n, 1));
  const yOf = (v: number) => padT + chartH - Math.min((v / maxVal) * chartH, chartH);
  const barW = Math.max(4, (chartW / Math.max(n, 1)) * 0.65);
  const lineY = yOf(activeLine);
  const showLabels = n <= 10;
  const lineStroke = effectiveMode === "actual" ? "#7dd3fc" : "#64748b";

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">{title.toUpperCase()}</div>
      {/* Summary table */}
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]" style={mono}>
          <thead className="text-slate-600">
            <tr>{kind === "pitcher" ? ["window","IP","ERA","K","K/9","BB/9"].map((h) => <th key={h} className="text-right font-semibold py-1 first:text-left">{h}</th>) : ["window","H-AB","AVG","HR","TB/G","HRR/G","K%"].map((h) => <th key={h} className="text-right font-semibold py-1 first:text-left">{h}</th>)}</tr>
          </thead>
          <tbody>
            {(rows || []).map((r) => (
              <tr key={r.n} className="border-t border-slate-800/80">
                <td className="py-1 text-slate-400">L{r.n}</td>
                {kind === "pitcher" ? (
                  <>
                    <td className="text-right text-slate-200">{outsToIp(r.outs)}</td>
                    <td className="text-right text-slate-200">{displayNum(r.era, 2)}</td>
                    <td className="text-right text-slate-200">{r.so}</td>
                    <td className="text-right text-slate-200">{displayNum(r.k9, 1)}</td>
                    <td className="text-right text-slate-200">{displayNum(r.bb9, 1)}</td>
                  </>
                ) : (
                  <>
                    <td className="text-right text-slate-200">{r.h}-{r.ab}</td>
                    <td className="text-right text-slate-200">{displayRate(r.avg)}</td>
                    <td className="text-right text-slate-200">{r.hr}</td>
                    <td className="text-right text-slate-200">{displayNum(r.tbG, 2)}</td>
                    <td className="text-right text-slate-200">{displayNum(r.hrrG, 2)}</td>
                    <td className="text-right text-slate-200">{r.kRate != null ? pct(r.kRate) : "—"}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Bar chart controls + chart ── */}
      <div className="mt-3 border-t border-slate-800 pt-3 space-y-1.5">
        {/* Row 1: window selector ← → line mode toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] text-slate-600 font-bold tracking-wide">WINDOW</span>
            {([5,10,20] as const).map((w) => (
              <button key={w} onClick={() => setWin(w)} className={`text-[10px] px-2 py-0.5 rounded border ${win === w ? "border-sky-700 text-sky-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`}>L{w}</button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            {n > 0 && (
              <span className={`text-[12px] font-black ${hitCount / n >= 0.65 ? "text-emerald-400" : hitCount / n >= 0.45 ? "text-amber-400" : "text-rose-400"}`} style={mono}>
                {hitCount}/{n}
              </span>
            )}
            {hasActual && (
              <div className="flex gap-1 ml-2">
                <button onClick={() => setLineMode("model")} className={`text-[10px] px-2 py-0.5 rounded border ${effectiveMode === "model" ? "border-slate-500 text-slate-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`}>proj</button>
                <button onClick={() => setLineMode("actual")} className={`text-[10px] px-2 py-0.5 rounded border ${effectiveMode === "actual" ? "border-sky-600 text-sky-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`}>mkt line</button>
              </div>
            )}
          </div>
        </div>
        {/* Row 2: category selector ← → active line label */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] text-slate-600 font-bold tracking-wide">STAT</span>
            {cats.map((c) => (
              <button key={c.key} onClick={() => setCatKey(c.key)} className={`text-[10px] px-2 py-0.5 rounded border ${catKey === c.key ? "border-emerald-700 text-emerald-300" : "border-slate-700 text-slate-500 hover:text-slate-300"}`}>{c.label}</button>
            ))}
          </div>
          <span className="text-[10px] text-slate-500" style={mono}>
            {effectiveMode === "actual" ? <span className="text-sky-400">mkt </span> : <span className="text-slate-600">proj </span>}
            {fmtLineLabel(activeLine)}
          </span>
        </div>

        {/* Chart */}
        {n === 0 ? (
          <div className="text-[11px] text-slate-600 text-center py-3">No game log data available</div>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
            <line x1={padL} y1={padT} x2={padL} y2={padT + chartH} stroke="#1e293b" strokeWidth="1.5" />
            <text x={padL - 3} y={lineY + 3.5} fontSize="8" fill={lineStroke} textAnchor="end" fontFamily="ui-monospace,monospace">{fmtLineShort(activeLine)}</text>
            <line x1={padL} y1={lineY} x2={W - padR} y2={lineY} stroke={lineStroke} strokeWidth="1" strokeDasharray="4,3" />
            {barVals.map((b, i) => {
              const x = xOf(i);
              const hit = b.raw >= activeLine;
              const barH = Math.max(2, (Math.min(b.raw, maxVal) / maxVal) * chartH);
              const y = padT + chartH - barH;
              const dv = fmtBarVal(b.raw);
              return (
                <g key={i}>
                  <rect x={x - barW / 2} y={y} width={barW} height={barH} fill={hit ? "#34d399" : "#f87171"} rx="2" opacity="0.85">
                    <title>{b.date ? b.date.slice(5) : ""} {b.homeAway} {b.opp}: {dv}</title>
                  </rect>
                  <text x={x} y={y - 2} fontSize="7.5" fill={hit ? "#86efac" : "#fca5a5"} textAnchor="middle" fontFamily="ui-monospace,monospace">{dv}</text>
                  {showLabels && <text x={x} y={H - 4} fontSize="7" fill="#475569" textAnchor="middle" fontFamily="ui-monospace,monospace">{b.opp}</text>}
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}
export function SplitAndLogCard({ splits, logs }) {
  return (
    <div className="space-y-3">
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
        <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">PLATOON SPLITS</div>
        {!splits ? <div className="text-sm text-slate-500">No split line returned.</div> : (
          <div className="grid grid-cols-2 gap-2">
            {[{ lab: "vs LHP", s: splits.vL }, { lab: "vs RHP", s: splits.vR }].map(({ lab, s }) => (
              <div key={lab} className="bg-slate-950/60 border border-slate-800 rounded-lg p-2">
                <div className="text-[10px] text-slate-500 font-bold mb-1">{lab}{s && s.pa ? <span className="text-slate-600 font-normal"> · {s.pa} PA</span> : ""}</div>
                {s ? (
                  <div className="space-y-0.5 text-[11px]" style={mono}>
                    <div className="text-sky-300 font-bold">{s.avg || displayRate(safeDiv(s.h, s.ab))} / {s.obp || displayRate(safeDiv(s.h + s.bb, s.pa || s.ab + s.bb))} / {s.slg || displayRate(safeDiv(s.tb, s.ab))}</div>
                    <div><span className="text-slate-500">K% </span><span className="text-slate-200">{s.pa ? pct(safeDiv(s.so, s.pa)) : "—"}</span><span className="text-slate-600"> · </span><span className="text-slate-500">BB% </span><span className="text-slate-200">{s.pa ? pct(safeDiv(s.bb, s.pa)) : "—"}</span></div>
                    <div><span className="text-slate-500">HR </span><span className="text-slate-200">{s.hr}</span><span className="text-slate-600"> · </span><span className="text-slate-500">H/AB </span><span className="text-slate-200">{s.h}-{s.ab}</span></div>
                  </div>
                ) : <div className="text-slate-600 text-[11px]">—</div>}
              </div>
            ))}
          </div>
        )}
      </div>
      <GameLogCard kind="hitter" logs={logs} />
    </div>
  );
}
export function PitcherSplitCard({ splits }) {
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">PLATOON SPLITS</div>
      {!splits ? <div className="text-sm text-slate-500">No split data returned.</div> : (
        <div className="grid grid-cols-2 gap-2">
          {[{ lab: "vs LHB", s: splits.vL }, { lab: "vs RHB", s: splits.vR }].map(({ lab, s }) => (
            <div key={lab} className="bg-slate-950/60 border border-slate-800 rounded-lg p-2">
              <div className="text-[10px] text-slate-500 font-bold mb-1">{lab}{s && s.bf ? <span className="text-slate-600 font-normal"> · {s.bf} BF</span> : ""}</div>
              {s ? (
                <div className="space-y-0.5 text-[11px]" style={mono}>
                  <div><span className="text-slate-500">ERA </span><span className="text-sky-300 font-bold">{s.era || (s.ip ? displayNum((s.er * 9) / s.ip, 2) : "—")}</span></div>
                  <div><span className="text-slate-500">K% </span><span className="text-slate-200">{s.bf ? pct(safeDiv(s.so, s.bf)) : "—"}</span><span className="text-slate-600"> · </span><span className="text-slate-500">BB% </span><span className="text-slate-200">{s.bf ? pct(safeDiv(s.bb, s.bf)) : "—"}</span></div>
                  <div><span className="text-slate-500">K/9 </span><span className="text-slate-200">{s.ip ? displayNum((s.so * 9) / s.ip, 1) : "—"}</span><span className="text-slate-600"> · </span><span className="text-slate-500">HR/9 </span><span className="text-slate-200">{s.ip ? displayNum((s.hr * 9) / s.ip, 2) : "—"}</span></div>
                  <div><span className="text-slate-500">WHIP </span><span className="text-slate-200">{s.ip ? displayNum((s.h + s.bb) / s.ip, 2) : "—"}</span></div>
                </div>
              ) : <div className="text-slate-600 text-[11px]">—</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
export function GameLogCard({ kind, logs }) {
  const rows = (logs || []).slice(0, 10);
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-2">LAST 10 GAME LOG</div>
      {!rows.length ? <div className="text-sm text-slate-500">No game log returned.</div> : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]" style={mono}>
            <thead className="text-slate-600">
              <tr>{kind === "pitcher" ? ["date", "opp", "IP", "K", "ER", "H", "BB"].map((h) => <th key={h} className="text-right font-semibold py-1 first:text-left">{h}</th>) : ["date", "opp", "H-AB", "TB", "HR", "HRR"].map((h) => <th key={h} className="text-right font-semibold py-1 first:text-left">{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((x, i) => {
                const s = x.stat || {};
                return (
                  <tr key={`${x.date}-${i}`} className="border-t border-slate-800/80">
                    <td className="py-1 text-left text-slate-400">{x.date ? x.date.slice(5) : "—"}</td>
                    <td className="text-right text-slate-400">{x.homeAway} {x.opponent}</td>
                    {kind === "pitcher" ? (
                      <>
                        <td className="text-right text-slate-200">{s.inningsPitched || "0.0"}</td>
                        <td className="text-right text-slate-200">{+s.strikeOuts || 0}</td>
                        <td className="text-right text-slate-200">{+s.earnedRuns || 0}</td>
                        <td className="text-right text-slate-200">{+s.hits || 0}</td>
                        <td className="text-right text-slate-200">{+s.baseOnBalls || 0}</td>
                      </>
                    ) : (
                      <>
                        <td className="text-right text-slate-200">{+s.hits || 0}-{+s.atBats || 0}</td>
                        <td className="text-right text-slate-200">{+s.totalBases || 0}</td>
                        <td className="text-right text-slate-200">{+s.homeRuns || 0}</td>
                        <td className="text-right text-slate-200">{(+s.hits || 0) + (+s.runs || 0) + (+s.rbi || 0)}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
export function MathPanel({ r }) {
  const p = r.modelP, q = p != null ? 1 - p : null, isLive = r.calc && r.calc.live;
  const activeMults = (r.calc && r.calc.mults ? r.calc.mults : []).filter(([, v]) => Math.abs(Number(v) - 1) > 0.0005);
  const chain = isLive ? "live remaining-game projection" : (activeMults.length ? activeMults.map(([k, v]) => `${k} ${Number(v).toFixed(3)}`).join("  ×  ") : "neutral context");
  if (!r.calc || p == null) return null;
  return (
    <div className="border-t border-slate-800 px-4 py-2.5 text-[11px] text-slate-400 space-y-1" style={mono}>
      <div><span className="text-slate-500">1 · base</span> &nbsp;{r.calc.baseStr}</div>
      <div><span className="text-slate-500">2 · context</span> &nbsp;{chain}</div>
      {isLive && <div><span className="text-slate-500">live</span> &nbsp;have <span className="text-slate-200">{r.calc.live.current}</span> · {Math.round(r.calc.live.fr * 100)}% left · need {(parseFloat(r.line) - r.calc.live.current).toFixed(1)} more</div>}
      <div><span className="text-slate-500">3 · projection</span> &nbsp;{isLive ? "final" : "E"}[{r.type}] = <span className="text-sky-300">{r.proj != null ? r.proj.toFixed(2) : "—"}</span> &nbsp;→ {r.calc.dist}({r.calc.params})</div>
      <div><span className="text-slate-500">4 · model</span> &nbsp;P({r.side} {r.line}) = <span className="text-emerald-300">{pct(p)}</span> → fair {r.fair}</div>
      <div><span className="text-slate-500">5 · market</span> &nbsp;{fmtOdds(r.odds)} {r.devigged ? "(de-vigged" : "(raw"} {r.novig != null ? pct(r.novig) : "—"}{r.devigged ? ")" : ")"}, pays ${r.b.toFixed(2)}/$1</div>
      <div><span className="text-slate-500">6 · EV</span> &nbsp;= p·b − (1−p) = ({p.toFixed(3)})({r.b.toFixed(2)}) − ({q.toFixed(3)}) = <span className={r.ev >= 0 ? "text-emerald-300" : "text-rose-300"}>{r.ev >= 0 ? "+" : ""}{(r.ev * 100).toFixed(1)}%</span></div>
      <div className="text-slate-600">edge = model − {r.devigged ? "no-vig" : "implied"} = {r.edge >= 0 ? "+" : ""}{(r.edge * 100).toFixed(1)} pts</div>
    </div>
  );
}

// Delta gate signal indicator (Option B — visual dot on board row).
// Returns "strong" | "moderate" | null based on category-specific thresholds derived from Sep 2-7 data.
// TB / H+R+RBI: |Δ| thresholds (both directions meaningful). Hits / K: direction-only (positive delta only).
// Outs, HR, game lines omitted — delta signal unreliable or inverted for those categories.
export function getDeltaSignal(type, proj, line) {
  if (proj == null || line == null) return null;
  const lineNum = parseFloat(line);
  if (isNaN(lineNum)) return null;
  const delta = proj - lineNum;
  const abs = Math.abs(delta);
  if (type === "Total Bases") return abs >= 1.0 ? "strong" : abs >= 0.75 ? "moderate" : null;
  if (type === "H+R+RBI")     return abs >= 1.0 ? "strong" : abs >= 0.75 ? "moderate" : null;
  if (type === "Hits")        return delta > 0.5 ? "strong" : delta > 0 ? "moderate" : null;
  if (type === "Strikeouts")  return delta > 0 ? "moderate" : null; // no strong tier — direction only
  return null;
}

export function BoardRow({ e, tracked, onTrack, showProjBar = true }) {
  const [show, setShow] = useState(false);
  const evGood = e.ev >= 0;
  const pm = !isLineType(e.type) ? projMeta(e.proj, e.line, e.side) : null;
  return (
    <div className="bg-slate-900/70 border border-slate-800 rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex-1 min-w-0">
          <div className="font-semibold truncate">{e.name} <span className="text-slate-500 text-xs">{e.game}</span></div>
          <div className="text-[11px] text-slate-400" style={mono}>
            {e.side} {e.line} {e.type} @ {fmtOdds(e.odds)} · <span className="text-sky-300">proj {e.proj != null ? e.proj.toFixed(2) : "—"}</span>
            {pm && <span className={`ml-1.5 font-bold ${pm.color}`}>{pm.delta >= 0 ? "+" : "−"}{Math.abs(pm.delta).toFixed(2)}</span>}
            {(() => { const sig = getDeltaSignal(e.type, e.proj, e.line); return sig ? <span className={`ml-1 ${sig === "strong" ? "text-emerald-400" : "text-yellow-400"}`}>●</span> : null; })()}
          </div>
        </div>
        <div className="text-right text-[11px]" style={mono}>
          <div className="text-slate-400">model {pct(e.modelP)} · fair {e.fair}</div>
          {e.outsSanityFailed
            ? <div className="text-amber-400 font-bold">⚠ stale IP data · edge suppressed</div>
            : <div className={evGood ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>EV {evGood ? "+" : ""}{(e.ev * 100).toFixed(1)}% · edge {e.edge >= 0 ? "+" : ""}{(e.edge * 100).toFixed(1)}%</div>
          }
        </div>
        <button onClick={() => setShow((s) => !s)} className="text-[11px] text-slate-500 hover:text-emerald-300 border border-slate-700 rounded px-2 py-1">{show ? "hide" : "math"}</button>
        <button onClick={onTrack} disabled={tracked} className={`text-[11px] font-bold rounded px-2 py-1 ${tracked ? "bg-slate-700 text-slate-400" : "bg-emerald-600 hover:bg-emerald-500 text-white"}`}>{tracked ? "tracked" : "track"}</button>
      </div>
      {pm && showProjBar && (
        <div className="relative h-1 mx-4 mb-2.5 bg-slate-800 rounded-full overflow-hidden" title={`proj ${e.proj != null ? e.proj.toFixed(2) : "—"} vs line ${e.line} · ${pm.delta >= 0 ? "clears" : "misses"} by ${Math.abs(pm.delta).toFixed(2)}`}>
          <div className="absolute inset-y-0 left-0" style={{ width: `${pm.projPct}%`, backgroundColor: pm.barColor }} />
          <div className="absolute inset-y-0 w-px bg-white/70" style={{ left: `${pm.linePct}%` }} />
        </div>
      )}
      {show && <MathPanel r={e} />}
    </div>
  );
}
export function TrendCard({ c, entry, tracked, onTrack }) {
  return (
    <div className="bg-slate-900/70 border border-slate-800 rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 flex-wrap">
        <div className="flex-1 min-w-[160px]">
          <div className="font-semibold truncate">{c.name} <span className="text-slate-500 text-xs">{c.game}</span></div>
          <div className="text-[11px] text-slate-400" style={mono}>
            {c.side} {c.line} {c.type}{c.odds != null ? ` @ ${fmtOdds(c.odds)}` : ""}
            <span className={`ml-1.5 ${c.sourced === "book" ? "text-sky-400" : "text-slate-500"}`}>{c.sourced === "book" ? "· book line" : "· model-free line"}</span>
          </div>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <TrendPill label="Recent Form" s={c.recentForm} />
          <TrendPill label={`vs ${c.opp || "OPP"}`} s={c.vsOpp} />
          <TrendPill label={c.isHome ? "Home" : "Away"} s={c.homeAway} />
        </div>
        {entry && (
          <button onClick={() => onTrack(entry)} disabled={tracked} className={`text-[11px] font-bold rounded px-2 py-1 ${tracked ? "bg-slate-700 text-slate-400" : "bg-emerald-600 hover:bg-emerald-500 text-white"}`}>{tracked ? "tracked" : "track"}</button>
        )}
      </div>
    </div>
  );
}
export function MyBetRow({ b, onOdds, onUnits, onRemove }) {
  const stColor = { open: "bg-slate-700 text-slate-300", won: "bg-emerald-600 text-white", lost: "bg-rose-600 text-white", push: "bg-amber-600 text-slate-950", void: "bg-slate-600 text-slate-200" }[b.status];
  const profit = (b.status === "won" || b.status === "lost") ? profitUnits(b.status, Number(b.odds), b.units) : null;
  return (
    <div className="flex items-center gap-3 bg-slate-900/70 border border-slate-800 rounded-xl px-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="font-semibold truncate">{b.name} <span className="text-slate-500 text-xs">{b.game} · {b.book}</span></div>
        <div className="text-[11px] text-slate-400" style={mono}>
          {b.side} {b.line} {b.type}
          {b.proj != null ? <> · <span className="text-sky-300">proj {Number(b.proj).toFixed(2)}</span></> : ""}
          {(() => { const pm = !isLineType(b.type) && b.proj != null ? projMeta(b.proj, b.line, b.side) : null; if (!pm) return null; return <span className={`ml-1.5 font-bold ${pm.color}`}>{pm.delta >= 0 ? "+" : "−"}{Math.abs(pm.delta).toFixed(2)}</span>; })()}
          {b.actual != null ? <> · <span className="text-slate-300">actual {b.actual}</span></> : ""}
        </div>
        {b.currentOdds != null && (
          <div className="text-[11px]" style={mono} title={b.oddsCheckedAt ? `checked ${new Date(b.oddsCheckedAt).toLocaleTimeString()}` : ""}>
            <span className="text-slate-500">took {fmtOdds(Number(b.odds))} → {b.closing ? "close " : "now "}</span>
            <span className={b.clv != null && b.clv >= 0 ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>{fmtOdds(b.currentOdds)}</span>
            {b.clv != null && <span className={b.clv >= 0 ? "text-emerald-500" : "text-rose-500"}> ({b.clv >= 0 ? "+" : ""}{(b.clv * 100).toFixed(1)} {b.live ? "mov" : "CLV"})</span>}
          </div>
        )}
        {b.currentOdds == null && b.lineMissing && (
          <div className="text-[11px] text-amber-500/80" style={mono} title={b.oddsCheckedAt ? `checked ${new Date(b.oddsCheckedAt).toLocaleTimeString()}` : ""}>line not found (scratched, settled, or moved off your number)</div>
        )}
      </div>
      <label className="text-[10px] text-slate-500 flex flex-col items-end gap-0.5">odds
        <input value={b.odds} onChange={(e) => onOdds(e.target.value)} inputMode="numeric" className="w-16 bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-sm text-slate-100 text-right" />
      </label>
      <label className="text-[10px] text-slate-500 flex flex-col items-end gap-0.5">units
        <input value={b.units} onChange={(e) => onUnits(e.target.value)} inputMode="decimal" className="w-14 bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-sm text-slate-100 text-right" />
        {b.suggested > 0 && <span className="text-[9px] text-slate-600">sug {b.suggested}u</span>}
      </label>
      <div className="text-right text-[11px] w-28" style={mono}>
        {b.modelP != null ? <>
          <div className="text-slate-400">model {pct(b.modelP)}</div>
          <div className={b.ev >= 0 ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>EV {b.ev != null ? `${b.ev >= 0 ? "+" : ""}${(b.ev * 100).toFixed(1)}%` : "—"} · edge {b.edge != null ? `${b.edge >= 0 ? "+" : ""}${(b.edge * 100).toFixed(1)}%` : "—"}</div>
        </> : <div className="text-slate-600">manual</div>}
        {profit != null && <div className={profit >= 0 ? "text-emerald-400" : "text-rose-400"}>{profit >= 0 ? "+" : ""}{profit.toFixed(2)}u</div>}
      </div>
      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${stColor}`}>{b.status}</span>
      <button onClick={onRemove} className="text-slate-600 hover:text-rose-400 text-lg leading-none">×</button>
    </div>
  );
}
export function LineupCol({ title, g, lineup, d, onAdd, onPlayerClick }) {
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1.5">{title}</div>
      {lineup.length === 0 && <div className="text-[11px] text-slate-600 py-2">— not posted —</div>}
      <div className="space-y-0.5">{lineup.map((p, i) => <PlayerRow key={p.id} idx={i + 1} rec={d.hitters && d.hitters[p.id]} onAdd={() => onAdd(p.id)} onPlayerClick={onPlayerClick ? () => onPlayerClick(p) : null} />)}</div>
    </div>
  );
}
export function PlayerRow({ idx, rec, onAdd, onPlayerClick }) {
  const [exp, setExp] = useState(false);
  const stat = rec && rec.season, l15 = rec && rec.l15, bvp = rec && rec.bvp;
  const sProxy = stat && stat.ab ? (stat.h / stat.ab) + (stat.tb / stat.ab) : null;
  const delta = (l15 && sProxy != null) ? (l15.ops - sProxy) : null;
  const oppLast = rec && rec.oppName ? rec.oppName.split(" ").slice(-1)[0] : null;
  return (
    <div className="text-[12px]">
      <div className="flex items-center gap-2">
        <span className="text-slate-600 w-4" style={mono}>{idx}</span>
        <button onClick={() => setExp((e) => !e)} className="text-slate-500 hover:text-slate-300 text-[10px] w-3 flex-shrink-0">{exp ? "▾" : "▸"}</button>
        <button
          onClick={onPlayerClick || undefined}
          disabled={!onPlayerClick}
          className={`flex-1 text-left truncate ${onPlayerClick ? "hover:text-sky-300 cursor-pointer" : "cursor-default"}`}
          title={onPlayerClick ? "Open player analysis" : undefined}
        >{rec ? rec.name : "—"}</button>
        {rec && rec.bats && rec.oppThrows && (() => {
          const f = calculatePlatoonAdjustment({ kind: "hitter", bats: rec.bats, oppThrows: rec.oppThrows, splits: rec.splits, season: rec.season });
          const cls = f < 0.99 ? "bg-rose-900/50 text-rose-300" : f > 1.01 ? "bg-emerald-900/50 text-emerald-300" : "bg-slate-800 text-slate-400";
          return <span className={`text-[9px] px-1 rounded ${cls}`} style={mono} title={`bats ${rec.bats} vs ${rec.oppThrows}HP`}>{rec.bats}v{rec.oppThrows} ×{f.toFixed(2)}</span>;
        })()}
        <span className="text-slate-400" style={mono}>{stat ? `${stat.avg != null ? stat.avg : "—"}/${stat.ops != null ? stat.ops : "—"}` : "—"}</span>
        {delta != null && <HotBadge delta={delta} />}
        <button onClick={onAdd} className="text-emerald-500 hover:text-emerald-300 font-bold w-5 text-center" title="manual bet">+</button>
      </div>
      {exp && (
        <div className="ml-7 mb-1 mt-0.5 text-[11px] text-slate-400" style={mono}>
          <span>season: {stat ? `${stat.h}-${stat.ab}, ${stat.hr}HR, ${stat.slg != null ? stat.slg : "—"}SLG` : "n/a"}</span>
          {l15 && <span className="ml-2 text-slate-300">L15: {l15.h}-{l15.ab}, {l15.hr}HR, {l15.avg.toFixed(3)}</span>}
          {oppLast && <span className="ml-2">vs {oppLast}: {bvp ? `${bvp.h}-${bvp.ab}${bvp.hr ? `, ${bvp.hr}HR` : ""}` : (bvp === null ? "no history" : "…")}</span>}
        </div>
      )}
    </div>
  );
}
export function SPCard({ label, sp, st, onAdd, onPlayerClick }) {
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
      <div className="text-[10px] text-slate-500 font-bold tracking-wide mb-1">{label}</div>
      {!sp ? <div className="text-[11px] text-slate-600">TBD</div> : (
        <div className="flex items-center justify-between">
          <div>
            <button
              onClick={onPlayerClick || undefined}
              disabled={!onPlayerClick}
              className={`text-[12px] font-semibold text-left ${onPlayerClick ? "hover:text-sky-300 cursor-pointer" : "cursor-default"}`}
              title={onPlayerClick ? "Open player analysis" : undefined}
            >
              {sp.name}{st && st.role === "swing" ? <span className="ml-1 text-[9px] text-amber-400 font-bold">SWING</span> : null}
            </button>
            <div className="text-[11px] text-slate-400" style={mono}>{st ? `${st.era} ERA · ${st.k9.toFixed(1)} K/9 · ~${st.expIp.toFixed(1)} IP${st.recentLog && st.recentLog.games >= 3 ? ` (L${st.recentLog.games} avg ${st.recentLog.avgIp.toFixed(1)})` : ""}` : "—"}</div>
          </div>
          <button onClick={onAdd} className="text-emerald-500 hover:text-emerald-300 font-bold text-lg" title="manual bet">+</button>
        </div>
      )}
    </div>
  );
}
