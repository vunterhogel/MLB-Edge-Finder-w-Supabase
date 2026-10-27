/* NHL sport adapter for the shared SportApp shell (same shape as sports/mlb/adapter.tsx). */
import { ALL_PROPS, BOOKS, BOOK_LABELS, CATEGORY_ORDER, DEFAULT_LINE, GOALIE_PROPS, ODDS_TESTING_LIMIT, SKATER_PROPS, STAT_ORDER, TREND_PROPS, SIGNAL_RULES, isLineType, matchesQuery } from "./config";
import { buildGameLineEntries, buildTrendCard, espnSeasonFor, fetchEventOdds, fetchGameResult, fetchOddsEvents, fetchPlayerAnalysisProfile, fetchPlayerLogs, fetchRoster, fetchSchedule, fetchTeamStats, findPlayerInSlate, matchCurrentOdds, matchEvent, oddsDebug, parseEventOdds, parseGameOdds, playerTeam, searchPlayers, statFor, trendValueForGame } from "./data";
import { MODEL_VERSION, evalBet, fractionRemaining, gameProbs, gameLambdas, goalieRates, projectProp, skaterRates, teamRates } from "./engine";
import { gradeBet, pct } from "../../core/math";
import { normName } from "../../core/odds";
import { createStorage } from "../../core/storage";
import { logSections } from "../../core/playerLog";

const storage = createStorage("nhlef", MODEL_VERSION, {});

/* run async jobs with a concurrency cap (ESPN is fast, but ~50 game logs per game is a lot at once) */
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k]).catch(() => {}); } });
  await Promise.all(workers);
}

/* ---- context builders ---- */
function liveSnap(d, pid) { return d.live ? { fractionRemaining: d.live.fractionRemaining, totals: (d.live.players && d.live.players[pid]) || {} } : null; }
function skaterCtx(d, s) {
  const home = s.side === "home";
  return { kind: "skater", pos: s.group, rates: s.rates, injury: s.injury, teamLambda: home ? d.lambdaH : d.lambdaA, teamShots: home ? d.shotsH : d.shotsA, live: liveSnap(d, s.id) };
}
function goalieCtx(d, gk) {
  const home = gk.side === "home";
  return { kind: "goalie", rates: gk.rates, starter: gk.starter, expShotsAgainst: home ? d.shotsA : d.shotsH, live: liveSnap(d, gk.id) };
}

/* ---- everything the model needs for one game ---- */
async function loadGameDetail(g, { date }) {
  const season = espnSeasonFor(date);
  const [homeRoster, awayRoster, homeT, awayT, liveRes] = await Promise.all([
    fetchRoster(g.homeId).catch(() => []), fetchRoster(g.awayId).catch(() => []),
    fetchTeamStats(g.homeId).catch(() => null), fetchTeamStats(g.awayId).catch(() => null),
    g.status === "LIVE" ? fetchGameResult(g.pk) : Promise.resolve(null),
  ]);
  const roster = [...homeRoster.map((p) => ({ ...p, side: "home", teamId: g.homeId })), ...awayRoster.map((p) => ({ ...p, side: "away", teamId: g.awayId }))];
  const skaters = {}, goalies = {}, gamelogs = {}, priorGamelogs = {};
  await pool(roster, 8, async (p) => {
    playerTeam[p.id] = { teamId: p.teamId, group: p.group === "G" ? "G" : "S" };
    const { cur, prior } = await fetchPlayerLogs(p.id, season);
    gamelogs[p.id] = cur; priorGamelogs[p.id] = prior;
    const curReg = cur.filter((r) => !r.postseason);
    if (p.group === "G") {
      const probable = p.side === "home" ? g.homeGoalie : g.awayGoalie;
      goalies[p.id] = { ...p, rates: goalieRates(cur, prior), starter: !!(probable && probable.id === p.id), starterStatus: probable && probable.id === p.id ? String(probable.status || "").toUpperCase() : null };
    } else {
      const season_ = { g: curReg.reduce((a, r) => a + (r.s.goals || 0), 0), a: curReg.reduce((a, r) => a + (r.s.assists || 0), 0) };
      skaters[p.id] = { ...p, gp: curReg.length, season: season_, rates: skaterRates(cur, prior, p.group) };
    }
  });
  const starterOf = (side) => Object.values(goalies).find((x) => x.side === side && x.starter) || null;
  const lam = gameLambdas(homeT, awayT, starterOf("home") && starterOf("home").rates, starterOf("away") && starterOf("away").rates);
  const live = liveRes ? { fractionRemaining: fractionRemaining(liveRes.period, liveRes.clock), players: liveRes.players } : null;
  return {
    ready: true, loading: false, skaters, goalies, gamelogs, priorGamelogs,
    teams: { home: teamRates(homeT), away: teamRates(awayT), homeRaw: homeT, awayRaw: awayT },
    lambdaH: lam.lambdaH, lambdaA: lam.lambdaA, shotsH: lam.shotsH, shotsA: lam.shotsA, live,
  };
}

/* ---- odds rows -> priced board entries ---- */
function buildPropEntries(g, d, rows, book) {
  const skByName = {}, gkByName = {};
  for (const id in d.skaters) skByName[normName(d.skaters[id].name)] = d.skaters[id];
  for (const id in d.goalies) gkByName[normName(d.goalies[id].name)] = d.goalies[id];
  const entries = [];
  for (const row of rows) {
    const isG = row.type === "Saves";
    const pl = (isG ? gkByName : skByName)[normName(row.player)];
    if (!pl) continue;
    const ctx = isG ? goalieCtx(d, pl) : skaterCtx(d, pl);
    const pre = projectProp(ctx, row.type, parseFloat(row.point));
    for (const side of ["over", "under"]) {
      const odds = side === "over" ? row.over : row.under;
      if (odds == null) continue;
      const bet = { gamePk: g.pk, game: `${g.away}@${g.home}`, gameTimeIso: g.gameTimeIso || null, playerId: pl.id, name: pl.name, type: row.type, line: String(row.point), side, odds, overOdds: row.over, underOdds: row.under, ctx, book: row.srcBook || book };
      entries.push({ id: `${g.pk}-${pl.id}-${row.type}-${row.point}-${side}`, ...bet, ...evalBet(bet, pre) });
    }
  }
  return entries;
}

function analysisCtx(d, spot, profile) {
  const pid = String(profile.player.id);
  if (d.goalies && d.goalies[pid]) return goalieCtx(d, d.goalies[pid]);
  if (d.skaters && d.skaters[pid]) return skaterCtx(d, d.skaters[pid]);
  return null;
}
function trendSubjects(g, d) {
  const out = [];
  for (const id in d.skaters) { const s = d.skaters[id]; if (s.gp > 0 || s.rates.priorGames > 0) out.push({ player: s, pid: id, props: SKATER_PROPS, isHome: s.side === "home" }); }
  for (const id in d.goalies) { const gk = d.goalies[id]; if (gk.starter) out.push({ player: gk, pid: id, props: GOALIE_PROPS, isHome: gk.side === "home" }); }
  return out;
}


/* ---- Slate: what the shared game panel shows for a hockey game ---- */
const periodLabel = (p) => (p == null ? "" : p <= 3 ? `P${p}` : p === 4 ? "OT" : "SO");
const game = {
  subtitle: (g) => `G: ${g.awayGoalie ? g.awayGoalie.name : "TBD"} vs ${g.homeGoalie ? g.homeGoalie.name : "TBD"}` + (g.awayRec || g.homeRec ? ` · ${g.awayRec || "—"} / ${g.homeRec || "—"}` : ""),
  finalSuffix: (g) => (g.period && g.period > 3 ? `/${periodLabel(g.period)}` : ""),
  liveLabel: (g) => `${periodLabel(g.period)} ${g.clock || ""}`,
};
const f1 = (x) => (x == null || isNaN(x) ? "—" : Number(x).toFixed(1));
const f2 = (x) => (x == null || isNaN(x) ? "—" : Number(x).toFixed(2));
const svFmt = (x) => (x == null ? "—" : x.toFixed(3).replace(/^0/, ""));
function skaterRow(p, i) {
  return {
    id: p.id, idx: i + 1, name: p.name,
    chip: { text: p.pos, tone: "muted" },
    chips: p.injury ? [{ text: p.injury, tone: "bad" }] : [],
    stat: `${p.gp} · ${p.season.g}-${p.season.a}-${p.season.g + p.season.a} · ${f1(p.rates.sog)} · ${f1(p.rates.recentToi || p.rates.toi)}`,
    detail: [
      { text: `GP ${p.gp} · G-A-P ${p.season.g}-${p.season.a}-${p.season.g + p.season.a}` },
      { text: `model SOG/g ${f2(p.rates.sog)} · TOI ${f1(p.rates.recentToi || p.rates.toi)}`, strong: true },
    ],
    player: { id: p.id, name: p.name }, draft: { kind: "skater", id: p.id, name: p.name },
  };
}
// regulars (anyone with games this season or last), forwards then defense, by ice time
function skaterColumn(title, list) {
  const active = list.filter((p) => p.gp > 0 || p.rates.priorGames > 0).slice(0, 20);
  return { title, empty: "— roster unavailable —", rows: active.map((p, i) => skaterRow(p, i)) };
}
function goalieCard(title, goalies, expShots) {
  const starter = goalies.find((x) => x.starter) || null;
  const others = goalies.filter((x) => x !== starter);
  return {
    starter: true, title, empty: `starter not posted${others.length ? ` · ${others.map((o) => o.name).join(", ")}` : ""}`,
    row: starter ? {
      name: starter.name, nameBadge: starter.starterStatus || "PROBABLE",
      sub: `${svFmt(starter.rates.rawSvPct)} SV% (${starter.rates.starts} GS) · model ${svFmt(starter.rates.svPct)} · ${f2(starter.rates.gaa)} GAA · ~${f1(expShots * starter.rates.svPct * 0.97)} saves${others.length ? ` · backup: ${others.map((o) => o.name).join(", ")}` : ""}`,
      player: { id: starter.id, name: starter.name }, draft: { kind: "goalie", id: starter.id, name: starter.name },
    } : null,
  };
}
function slateView(g, d) {
  const gp = gameProbs(d.lambdaH, d.lambdaA);
  // forwards first, then defense, each by ice time
  const side = (s) => Object.values(d.skaters).filter((p) => p.side === s).sort((a, b) => (a.group === "D" ? 1 : 0) - (b.group === "D" ? 1 : 0) || (b.rates.recentToi || b.rates.toi || 0) - (a.rates.recentToi || a.rates.toi || 0));
  const gl = (s) => Object.values(d.goalies).filter((p) => p.side === s).sort((a, b) => Number(b.starter) - Number(a.starter) || b.rates.starts - a.rates.starts);
  const T = d.teams;
  return {
    env: [
      { label: `${g.away} GF/G`, v: f2(T.away.gf), hot: T.away.gf >= 3.4, cold: T.away.gf <= 2.7 },
      { label: `${g.away} GA/G`, v: f2(T.away.ga), hot: T.away.ga >= 3.4, cold: T.away.ga <= 2.7 },
      { label: `${g.home} GF/G`, v: f2(T.home.gf), hot: T.home.gf >= 3.4, cold: T.home.gf <= 2.7 },
      { label: `${g.home} GA/G`, v: f2(T.home.ga), hot: T.home.ga >= 3.4, cold: T.home.ga <= 2.7 },
      { label: "EXP SOG", v: `${f1(d.shotsA)}–${f1(d.shotsH)}`, hot: d.shotsA + d.shotsH >= 62, cold: d.shotsA + d.shotsH <= 52 },
    ],
    gameLine: { lambdaA: d.lambdaA, lambdaH: d.lambdaH, home: gp.home, away: gp.away, total: gp.totalLambda, note: "team goal rates (shrunk to league) × opponent defense and starting goalie × home ice. Win % includes OT/shootout." },
    sections: [
      [skaterColumn(`${g.away} (away)`, side("away")), skaterColumn(`${g.home} (home)`, side("home"))],
      [goalieCard(`${g.away} G`, gl("away"), d.shotsH), goalieCard(`${g.home} G`, gl("home"), d.shotsA)],
    ],
  };
}


/* ---- Player Analysis data (rendered by the shared core/analysis.tsx) ---- */
function windowAgg(rows, n, goalie) {
  const r = rows.slice(0, n);
  const sum = (f) => r.reduce((a, x) => a + (f(x.s) || 0), 0);
  if (goalie) { const sa = sum((s) => s.shotsAgainst), sv = sum((s) => s.saves); return { n: r.length, starts: sum((s) => s.gameStarted), sv: sa ? sv / sa : null, saves: r.length ? sv / r.length : null, gaa: r.length ? sum((s) => s.goalsAgainst) / r.length : null }; }
  return { n: r.length, g: sum((s) => s.goals), a: sum((s) => s.assists), sog: r.length ? sum((s) => s.shotsTotal) / r.length : null, ppp: sum((s) => (s.powerPlayGoals || 0) + (s.powerPlayAssists || 0)), toi: r.length ? sum((s) => s.timeOnIcePerGame) / r.length : null };
}
const NHL_ABBR = { "Shots on Goal": "SOG", "Goals": "G", "Assists": "A", "Points": "P", "Power Play Points": "PPP", "Saves": "SV" };
function playerView({ profile, spot, detail }) {
  const p = profile.player;
  const goalie = profile.kind === "goalie";
  const cur = (profile.logs.cur || []).filter((r) => !r.postseason);
  const prior = (profile.logs.prior || []).filter((r) => !r.postseason);
  const season = windowAgg(cur, 999, goalie), last = windowAgg(prior, 999, goalie);
  const ready = spot && detail && detail.ready;
  const ctx = ready ? analysisCtx(detail, spot, profile) : null;
  const sideTeams = ready ? (spot.side === "home" ? { us: detail.teams.home, them: detail.teams.away } : { us: detail.teams.away, them: detail.teams.home }) : null;
  return {
    headshot: `https://a.espncdn.com/i/headshots/nhl/players/full/${p.id}.png`,
    subtitle: [p.teamAbbr || "FA", p.pos, p.jersey ? `#${p.jersey}` : "", p.age ? `age ${p.age}` : ""].filter(Boolean).join(" · "),
    metrics: goalie
      ? [["GP / GS", `${season.n} / ${season.starts}`], ["SV%", svFmt(season.sv), season.sv != null ? season.sv >= 0.905 : undefined], ["GAA", f2(season.gaa)], ["Saves / GP", f1(season.saves)]]
      : [["GP", season.n], ["G-A-P", `${season.g}-${season.a}-${season.g + season.a}`], ["SOG / GP", f2(season.sog)], ["TOI", f1(season.toi)]],
    cards: [
      !spot ? { title: "SLATE MATCHUP", empty: "Not found on the selected date." } : {
        title: "SLATE MATCHUP", headline: { text: `${spot.game.away} @ ${spot.game.home}` },
        note: `${spot.side === "home" ? spot.game.home : spot.game.away} ${goalie ? "goalie" : "skater"} · vs ${spot.side === "home" ? spot.game.away : spot.game.home}`,
        lines: ready ? [
          `model score ${spot.game.away} ${detail.lambdaA.toFixed(1)} – ${detail.lambdaH.toFixed(1)} ${spot.game.home}`,
          `exp shots ${spot.game.away} ${f1(detail.shotsA)} – ${f1(detail.shotsH)} ${spot.game.home}`,
          `opp GF/G ${f2(sideTeams.them.gf)} · GA/G ${f2(sideTeams.them.ga)}`,
        ] : [{ text: "loading detail…", tone: "muted" }],
      },
      goalie
        ? { title: "SEASON BASELINE", grid: [["GP", season.n], ["GS", season.starts], ["SV%", svFmt(season.sv), "sky"], ["GAA", f2(season.gaa), "sky"], ["SV/G", f1(season.saves)], ["last season GP", last.n], ["last SV%", svFmt(last.sv)], ["last GAA", f2(last.gaa)]] }
        : { title: "SEASON BASELINE", grid: [["GP", season.n], ["G", season.g, "sky"], ["A", season.a, "sky"], ["P/G", season.n ? f2((season.g + season.a) / season.n) : "—", "sky"], ["SOG/G", f2(season.sog)], ["PPP", season.ppp], ["TOI", f1(season.toi)], ["last season P/G", last.n ? f2((last.g + last.a) / last.n) : "—"]] },
      !ctx ? { title: "MODEL CONTEXT", empty: spot ? "loading matchup context…" : "Available when the player is on the selected slate." }
        : goalie
          ? { title: "MODEL CONTEXT", note: "inputs the projection uses for this game", grid: [["starter", ctx.starter ? "yes" : "no", ctx.starter ? "good" : "warn"], ["exp SA", f1(ctx.expShotsAgainst), "sky"], ["model SV%", svFmt(ctx.rates && ctx.rates.svPct)], ["raw SV%", svFmt(ctx.rates && ctx.rates.rawSvPct)], ["starts", ctx.rates ? ctx.rates.starts : "—"], ["eff starts", ctx.rates && ctx.rates.effStarts != null ? f1(ctx.rates.effStarts) : "—"]] }
          : { title: "MODEL CONTEXT", note: "inputs the projection uses for this game", grid: [["team goals", f2(ctx.teamLambda), "sky"], ["team shots", f1(ctx.teamShots)], ["SOG rate", f2(ctx.rates && ctx.rates.sog)], ["TOI", f1(ctx.rates && (ctx.rates.recentToi || ctx.rates.toi))], ["G rate", f2(ctx.rates && ctx.rates.g)], ["A rate", f2(ctx.rates && ctx.rates.a)], ["injury", ctx.injury || "none", ctx.injury ? "bad" : null], ["eff games", ctx.rates && ctx.rates.effGames != null ? f1(ctx.rates.effGames) : "—"]] },
    ],
    ...logSections({ rows: [...cur, ...prior], curCount: cur.length, types: goalie ? ["Saves"] : ["Shots on Goal", "Goals", "Assists", "Points"], valueFor: trendValueForGame, abbr: (t) => NHL_ABBR[t] || t, defaultLines: DEFAULT_LINE, title: goalie ? "Goaltending Form" : "Scoring Form" }),
  };
}

/* ---- settlement ---- */
function gradeLineResult(type, side, line, res) {
  const h = res.homeScore, a = res.awayScore;
  if (h == null || a == null) return { status: null, actual: null };
  const actual = `${a}-${h}`;
  if (type === "Moneyline") return { status: (side === "home" ? h > a : a > h) ? "won" : "lost", actual };
  if (type === "Total") { const t = h + a; return { status: t === line ? "push" : (side === "over" ? t > line : t < line) ? "won" : "lost", actual: t }; }
  if (type === "Puck Line") { const m = side === "home" ? h - a : a - h; return { status: m + line === 0 ? "push" : m + line > 0 ? "won" : "lost", actual }; }
  return { status: null, actual: null };
}
function gradeProp(b, res, dnpActual) {
  const p = res.players[b.playerId] || res.players[String(b.playerId)];
  if (!p || !p.played) return { status: "void", actual: dnpActual };
  const actual = statFor(b.type, p);
  const st = gradeBet(b.side, parseFloat(String(b.line)), actual);
  return st == null ? null : { status: st, actual };
}

/* ---- manual draft ---- */
function draftCtx(d, g, kind, pid) {
  if (!d || !d.ready) return null;
  if (kind === "goalie" && d.goalies[pid]) return goalieCtx(d, d.goalies[pid]);
  if (kind === "skater" && d.skaters[pid]) return skaterCtx(d, d.skaters[pid]);
  return null;
}

const NHL = {
  id: "nhl",
  meta: {
    title: "NHL", tagline: "live odds · de-vigged edge · Monte-Carlo props", emoji: "🏒", league: "NHL",
    analysisHint: "NHL-wide profile lookup. If the player is on the selected slate, this tab adds matchup context, model projections, and any pulled",
    statsSource: "ESPN", searchPlaceholder: "Connor McDavid",
    csvPrefix: "nhl-edge-finder", boardLogCsvPrefix: "nhl-board-log", backupApp: "nhl-edge-finder",
    overrideTitle: "Per-market book overrides: pull one market (e.g. Saves) from a different book than the rest of the board",
    diagnosticsType: "Saves", diagnosticsMarketKey: "player_total_saves",
    draftKindLabel: (kind) => (kind === "goalie" ? "GOALIE" : "SKATER"),
    searchResultLine: (p) => `${p.teamName || "FA"}`,
    intro: {
      file: "Search any NHL player by name.", fileSub: "season · recent windows · game log",
      slate: (games) => `${games.filter((g) => g.homeGoalie || g.awayGoalie).length} game(s) with probable goalies, ${games.filter((g) => g.status === "LIVE").length} live.`,
      slateSub: "opponent · goalie · goal environment",
    },
  },
  config: { ALL_PROPS, BOOKS, BOOK_LABELS, CATEGORY_ORDER, DEFAULT_LINE, ODDS_TESTING_LIMIT, isLineType, matchesQuery, STAT_ORDER, TREND_PROPS, SIGNAL_RULES },
  storage,
  api: { fetchSchedule, fetchOddsEvents, fetchEventOdds, matchEvent, oddsDebug, parseEventOdds, parseGameOdds, matchCurrentOdds, buildGameLineEntries, fetchGameResult, searchPlayers, fetchPlayerAnalysisProfile, findPlayerInSlate, buildTrendCard },
  model: { projectProp },
  loadGameDetail, buildPropEntries, analysisCtx, trendSubjects,
  propsForKind: (kind) => (kind === "goalie" ? GOALIE_PROPS : SKATER_PROPS),
  gradeLineResult,
  gradeTrackedProp: (b, res) => gradeProp(b, res, "DNP"),
  gradeLogProp: (e, res) => gradeProp(e, res, null),
  draftCtx,
  draftDefaults: (kind) => (kind === "goalie" ? { type: "Saves", line: DEFAULT_LINE.Saves } : { type: "Shots on Goal", line: DEFAULT_LINE["Shots on Goal"] }),
  game, slateView, playerView,
};
export default NHL;
