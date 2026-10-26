/* MLB data for the shared Player Analysis page (core/analysis.tsx). Same content the MLB page has always
   shown (slate matchup, season baseline, Statcast, form windows + chart, platoon splits, game log),
   expressed as data so every sport renders through one layout. */
import { pct } from "../../core/math";
import { displayNum, displayRate, outsToIp, safeDiv } from "./data";
import { ipToOuts } from "./engine";

const HITTER_CATS = [
  { key: "hits", label: "Hits", projType: "Hits", defaultLine: 0.5, fn: (s) => +s.hits || 0 },
  { key: "tb", label: "TB", projType: "Total Bases", defaultLine: 1.5, fn: (s) => +s.totalBases || 0 },
  { key: "hr", label: "HR", projType: "Home Run", defaultLine: 0.5, fn: (s) => +s.homeRuns || 0 },
  { key: "hrr", label: "H+R+RBI", projType: "H+R+RBI", defaultLine: 1.5, fn: (s) => (+s.hits || 0) + (+s.runs || 0) + (+s.rbi || 0) },
];
const PITCHER_CATS = [
  { key: "k", label: "Ks", projType: "Strikeouts", defaultLine: 5.5, fn: (s) => +s.strikeOuts || 0 },
  // IP is charted in outs (the Outs market's unit) and labelled as innings
  { key: "ip", label: "IP", projType: "Outs", defaultLine: 15, fn: (s) => ipToOuts(s.inningsPitched || "0"), fmt: (v) => outsToIp(v), fmtLine: (l) => `${outsToIp(Math.round(l))} (${l} outs)` },
  { key: "er", label: "ER", projType: null, defaultLine: 2.5, fn: (s) => +s.earnedRuns || 0 },
];

function slateCard(profile, spot, detail) {
  if (!spot) return { title: "SLATE MATCHUP", empty: "Not found on the selected date." };
  const g = spot.game;
  const rec = detail && detail.ready && spot.kind === "hitter" ? detail.hitters[String(profile.player.id)] : null;
  const bvp = rec && rec.bvp;
  const lines = [];
  if (detail && detail.ready) {
    lines.push(`park RF ${detail.park.rf.toFixed(2)}${detail.weather && !detail.park.dome ? ` · ${detail.weather.temp}° · wind ${detail.weather.wind}mph` : detail.park.dome ? " · dome" : ""}`);
    lines.push(`model score ${g.away} ${detail.lambdaA.toFixed(1)} – ${detail.lambdaH.toFixed(1)} ${g.home}`);
    if (spot.kind === "hitter") lines.push(bvp ? `BvP ${bvp.h}-${bvp.ab}${bvp.hr ? `, ${bvp.hr} HR` : ""}` : { text: "BvP no/limited history", tone: "muted" });
  } else if (detail && detail.loading) lines.push({ text: "loading detail…", tone: "muted" });
  return {
    title: "SLATE MATCHUP",
    headline: { text: `${g.away} @ ${g.home}` },
    note: spot.kind === "hitter" ? `${spot.side === "home" ? g.home : g.away} lineup · spot ${spot.lineupIndex + 1} · vs ${(spot.oppSP && spot.oppSP.name) || "TBD"}` : `${spot.side === "home" ? g.home : g.away} starter · vs ${spot.oppTeam}`,
    lines,
  };
}
function seasonCard(profile) {
  const s = profile.kind === "pitcher" ? profile.pitcherSeason : profile.hitterSeason;
  if (!s) return { title: "SEASON BASELINE", empty: "No season line returned." };
  if (profile.kind === "pitcher") return {
    title: "SEASON BASELINE",
    grid: [["IP", displayNum(s.ip, 1)], ["GS", s.gs], ["SO", s.so], ["BB", s.bb], ["K%", s.bf ? pct(s.so / s.bf) : "—"], ["BB%", s.bf ? pct(s.bb / s.bf) : "—"],
      ["WHIP", s.ip ? displayNum((s.h + s.bb) / s.ip, 2) : "—"], ["HR/9", s.ip ? displayNum((s.hrA * 9) / s.ip, 2) : "—"], ["FIP", s.fip != null ? s.fip.toFixed(2) : "—"], ["role", s.role]],
  };
  return {
    title: "SEASON BASELINE",
    grid: [["G", s.g], ["PA", s.pa || s.ab], ["AVG", s.avg || "—", "sky"], ["OBP", s.obp || "—", "sky"], ["SLG", s.slg || "—", "sky"], ["OPS", s.ops || "—", "sky"],
      ["HR", s.hr], ["TB", s.tb], ["K%", s.pa ? pct(s.so / s.pa) : "—"], ["BB%", s.pa ? pct(s.bb / s.pa) : "—"]],
  };
}
function statcastCard(profile) {
  const pitcher = profile.kind === "pitcher";
  const title = pitcher ? "PITCHER STATCAST" : "BATTER STATCAST";
  const sc = pitcher ? profile.statcastPitcher : profile.statcastBatter;
  if (!sc) return { title, empty: "Not fetched." };
  const ok = sc.verdict === "season_confirmed";
  return {
    title,
    headline: { text: sc.verdict || "unknown", tone: ok ? "good" : "warn" },
    note: `${sc.source || "savant"}${sc.cached ? " · cached" : ""}`,
    grid: [
      ["BBE", sc.bbe ?? "—"], ["pitches", sc.pitches ?? "—"],
      ...(pitcher ? [] : [["xBA", displayRate(sc.xba), "sky"]]),
      ["xwOBA", displayRate(pitcher ? sc.xwobaAllowed : sc.xwoba), "sky"], ["EV", displayNum(sc.avgEV, 1)],
      ["HH%", sc.hardHitRate != null ? pct(sc.hardHitRate) : "—"],
      ["Brl%", sc.barrelRate != null || sc.barrelAllowedRate != null ? pct(pitcher ? sc.barrelAllowedRate : sc.barrelRate) : "—"],
      ...(pitcher ? [["CSW%", sc.cswRate != null ? pct(sc.cswRate) : "—"]] : []),
    ],
  };
}
function form(profile) {
  const pitcher = profile.kind === "pitcher";
  const rows = (pitcher ? profile.pitchingWindows : profile.hittingWindows) || [];
  const logs = (pitcher ? profile.pitcherLogs : profile.hitterLogs) || [];
  const cats = pitcher ? PITCHER_CATS : HITTER_CATS;
  return {
    title: pitcher ? "Pitching Form" : "Hitting Form",
    table: pitcher
      ? { cols: ["window", "IP", "ERA", "K", "K/9", "BB/9"], rows: rows.map((r) => [`L${r.n}`, outsToIp(r.outs), displayNum(r.era, 2), r.so, displayNum(r.k9, 1), displayNum(r.bb9, 1)]) }
      : { cols: ["window", "H-AB", "AVG", "HR", "TB/G", "HRR/G", "K%"], rows: rows.map((r) => [`L${r.n}`, `${r.h}-${r.ab}`, displayRate(r.avg), r.hr, displayNum(r.tbG, 2), displayNum(r.hrrG, 2), r.kRate != null ? pct(r.kRate) : "—"]) },
    cats: cats.map(({ fn, ...c }) => c),
    games: logs.map((x) => ({ date: x.date ? x.date.slice(5) : "", opp: x.opponent || "", homeAway: x.homeAway || "", v: Object.fromEntries(cats.map((c) => [c.key, c.fn(x.stat || {})])) })),
  };
}
function splits(profile) {
  if (profile.kind === "pitcher") {
    const sp = profile.pitcherSplits;
    return {
      title: "Platoon Splits", empty: "No split data returned.",
      panels: sp ? [["vs LHB", sp.vL], ["vs RHB", sp.vR]].map(([label, s]) => ({
        label, sub: s && s.bf ? `${s.bf} BF` : null,
        lines: s ? [
          [["ERA", s.era || (s.ip ? displayNum((s.er * 9) / s.ip, 2) : "—")]],
          [["K%", s.bf ? pct(safeDiv(s.so, s.bf)) : "—"], ["BB%", s.bf ? pct(safeDiv(s.bb, s.bf)) : "—"]],
          [["K/9", s.ip ? displayNum((s.so * 9) / s.ip, 1) : "—"], ["HR/9", s.ip ? displayNum((s.hr * 9) / s.ip, 2) : "—"]],
          [["WHIP", s.ip ? displayNum((s.h + s.bb) / s.ip, 2) : "—"]],
        ] : null,
      })) : [],
    };
  }
  const sp = profile.hitterSplits;
  return {
    title: "Platoon Splits", empty: "No split line returned.",
    panels: sp ? [["vs LHP", sp.vL], ["vs RHP", sp.vR]].map(([label, s]) => ({
      label, sub: s && s.pa ? `${s.pa} PA` : null,
      headline: s ? `${s.avg || displayRate(safeDiv(s.h, s.ab))} / ${s.obp || displayRate(safeDiv(s.h + s.bb, s.pa || s.ab + s.bb))} / ${s.slg || displayRate(safeDiv(s.tb, s.ab))}` : null,
      lines: s ? [[["K%", s.pa ? pct(safeDiv(s.so, s.pa)) : "—"], ["BB%", s.pa ? pct(safeDiv(s.bb, s.pa)) : "—"]], [["HR", s.hr], ["H/AB", `${s.h}-${s.ab}`]]] : null,
    })) : [],
  };
}
function gameLog(profile) {
  const pitcher = profile.kind === "pitcher";
  const logs = ((pitcher ? profile.pitcherLogs : profile.hitterLogs) || []).slice(0, 10);
  return {
    title: "Last 10 Game Log",
    cols: pitcher ? ["date", "opp", "IP", "K", "ER", "H", "BB"] : ["date", "opp", "H-AB", "TB", "HR", "HRR"],
    rows: logs.map((x) => {
      const s = x.stat || {};
      const head = [x.date ? x.date.slice(5) : "—", `${x.homeAway || ""} ${x.opponent || ""}`];
      return pitcher
        ? [...head, s.inningsPitched || "0.0", +s.strikeOuts || 0, +s.earnedRuns || 0, +s.hits || 0, +s.baseOnBalls || 0]
        : [...head, `${+s.hits || 0}-${+s.atBats || 0}`, +s.totalBases || 0, +s.homeRuns || 0, (+s.hits || 0) + (+s.runs || 0) + (+s.rbi || 0)];
    }),
  };
}

export function playerView({ profile, spot, detail }) {
  const p = profile.player;
  const pitcher = profile.kind === "pitcher";
  const h = profile.hitterSeason, ps = profile.pitcherSeason;
  return {
    headshot: `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/${p.id}/headshot/67/current`,
    subtitle: `${p.teamAbbr || p.team || "FA"} · ${p.positionName || p.position || (pitcher ? "Pitcher" : "Hitter")} · bats ${p.bats || "—"} / throws ${p.throws || "—"}${p.active === false ? " · inactive" : ""}`,
    metrics: pitcher
      ? [["ERA", ps ? ps.era : "—"], ["K/9", ps ? ps.k9.toFixed(1) : "—"], ["FIP", ps && ps.fip != null ? ps.fip.toFixed(2) : "—"], ["Exp IP", ps ? ps.expIp.toFixed(1) : "—"]]
      : [["AVG", h ? h.avg : "—"], ["OPS", h ? h.ops : "—"], ["HR", h ? h.hr : "—"], ["H+R+RBI/G", h ? displayNum((h.h + h.r + h.rbi) / Math.max(h.g || 1, 1), 2) : "—"]],
    cards: [slateCard(profile, spot, detail), seasonCard(profile), statcastCard(profile)],
    form: form(profile),
    splits: splits(profile),
    log: gameLog(profile),
  };
}
