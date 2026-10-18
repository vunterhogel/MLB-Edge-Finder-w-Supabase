// nhl-collector: scheduled, server-side NHL research collector (paper mode).
//
// Jobs (POST JSON body {"job": ...}, header x-collector-token required):
//   snapshot  {kind:"open"|"close"}  pull player-prop quotes for today's NHL games from several books in
//                                    ONE call per game (bookmaker list counts as one region), store every
//                                    quote, and store a baseline model prediction for every quoted line.
//                                    "close" only touches games starting in the next ~50 minutes that
//                                    don't already have a close snapshot (near-closing line for CLV).
//   settle                           fetch box scores for finished games and store per-player outcomes.
//
// Nothing here bets or recommends; it builds a timestamped forecast + quote + outcome ledger so the
// NHL model can be evaluated honestly before anything is trusted.

import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL_VERSION = "nhl-v0-2026-10-18";
const SPORT = "nhl";
const ODDS_SPORT = "icehockey_nhl";
const MARKETS = ["player_shots_on_goal", "player_total_saves", "player_points"];
const BOOKS = ["draftkings", "fanduel", "betmgm", "caesars", "espnbet", "fanatics"];
const NHL = "https://api-web.nhle.com/v1";
const ODDS = "https://api.the-odds-api.com/v4";

// Credit guards (Edge Finder share of the Odds API account).
const MONTHLY_CAP = Number(Deno.env.get("NHL_MONTHLY_CREDIT_CAP") ?? 1500);
const ACCOUNT_FLOOR = Number(Deno.env.get("ODDS_ACCOUNT_FLOOR") ?? 1000);

// ---- league priors (stabilize thin early-season samples; retune from settled outcomes) ----
const LG_TEAM_SHOTS_PER_G = 28.5;   // shots on goal per team-game
const LG_SV_PCT = 0.900;
const POS_PRIOR = {
  F: { sog: 2.0, pts: 0.50 },
  D: { sog: 1.4, pts: 0.30 },
};
const SHRINK = { playerGames: 10, priorSeasonGames: 20, teamGames: 10, goalieShots: 400 };
const PHI = { player_shots_on_goal: 1.25, player_points: 1.15, player_total_saves: 1.6 };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ---------------- helpers ----------------
function normName(s: string) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z ]/g, " ").replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/\s+/g, " ").trim();
}
async function getJson(url: string, tries = 3): Promise<any> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (r.ok) return await r.json();
      last = new Error(`${r.status} ${url.replace(/apiKey=[^&]+/, "apiKey=***")}`);
      if (r.status === 404) break;
    } catch (e) { last = e; }
    await new Promise((res) => setTimeout(res, 400 * (i + 1)));
  }
  throw last;
}
function etDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function prevSeason(season: number) { // 20262027 -> 20252026
  const a = Math.floor(season / 10000);
  return `${a - 1}${a}`;
}

// ---------------- NB / Poisson pricing ----------------
function lgamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1; let a = c[0]; const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function pmf(k: number, mean: number, phi: number) {
  const m = Math.max(mean, 1e-9);
  if (phi <= 1.0001) return Math.exp(-m + k * Math.log(m) - lgamma(k + 1)); // Poisson
  const r = m / (phi - 1), p = r / (r + m);
  return Math.exp(lgamma(k + r) - lgamma(r) - lgamma(k + 1) + r * Math.log(p) + k * Math.log(1 - p));
}
// Separate over / under / push so integer lines price pushes correctly.
function priceLine(mean: number, phi: number, line: number) {
  const fl = Math.floor(line);
  let cdf = 0;
  for (let k = 0; k <= fl; k++) cdf += pmf(k, mean, phi);
  const isInt = Math.abs(line - fl) < 1e-9;
  const push = isInt ? pmf(fl, mean, phi) : 0;
  const over = Math.max(0, 1 - cdf);
  const under = Math.max(0, cdf - push);
  return { over, under, push };
}

// ---------------- team context from NHL club stats ----------------
type TeamCtx = {
  abbrev: string; gp: number; shotsFor: number; shotsAgainst: number;
  skaters: Map<string, any>; goalies: Map<string, any>;
  priorSkaters: Map<string, any>; priorGoalies: Map<string, any>;
  roster: Map<string, { id: string; name: string; pos: string }>;
};
async function teamCtx(abbrev: string, season: number, cache: Map<string, TeamCtx>): Promise<TeamCtx> {
  if (cache.has(abbrev)) return cache.get(abbrev)!;
  const [cur, prior, roster] = await Promise.all([
    getJson(`${NHL}/club-stats/${abbrev}/now`).catch(() => ({ skaters: [], goalies: [] })),
    getJson(`${NHL}/club-stats/${abbrev}/${prevSeason(season)}/2`).catch(() => ({ skaters: [], goalies: [] })),
    getJson(`${NHL}/roster/${abbrev}/current`).catch(() => ({})),
  ]);
  const byId = (arr: any[]) => new Map((arr || []).map((p: any) => [String(p.playerId), p]));
  const goalies = cur.goalies || [];
  const gp = goalies.reduce((s: number, g: any) => s + (g.gamesStarted || 0), 0);
  const ctx: TeamCtx = {
    abbrev, gp,
    shotsFor: (cur.skaters || []).reduce((s: number, p: any) => s + (p.shots || 0), 0),
    shotsAgainst: goalies.reduce((s: number, g: any) => s + (g.shotsAgainst || 0), 0),
    skaters: byId(cur.skaters), goalies: byId(goalies),
    priorSkaters: byId(prior.skaters), priorGoalies: byId(prior.goalies),
    roster: new Map(),
  };
  for (const grp of ["forwards", "defensemen", "goalies"]) {
    for (const p of roster[grp] || []) {
      const name = `${p.firstName?.default ?? ""} ${p.lastName?.default ?? ""}`;
      ctx.roster.set(normName(name), { id: String(p.id), name: name.trim(), pos: p.positionCode });
    }
  }
  // players who have played but are no longer on the roster feed (or vice versa) still resolve by name
  for (const p of [...(cur.skaters || []), ...goalies]) {
    const name = `${p.firstName?.default ?? ""} ${p.lastName?.default ?? ""}`;
    if (!ctx.roster.has(normName(name))) ctx.roster.set(normName(name), { id: String(p.playerId), name: name.trim(), pos: p.positionCode || "G" });
  }
  cache.set(abbrev, ctx);
  return ctx;
}
const teamRate = (total: number, gp: number) =>
  (total + LG_TEAM_SHOTS_PER_G * SHRINK.teamGames) / (gp + SHRINK.teamGames);

// ---------------- baseline projections ----------------
function skaterRate(ctx: TeamCtx, pid: string, pos: string, key: "shots" | "points") {
  const grp = pos === "D" ? "D" : "F";
  const lg = key === "shots" ? POS_PRIOR[grp].sog : POS_PRIOR[grp].pts;
  const pr = ctx.priorSkaters.get(pid);
  const priorRate = pr && pr.gamesPlayed
    ? ((pr[key] || 0) + lg * SHRINK.priorSeasonGames) / (pr.gamesPlayed + SHRINK.priorSeasonGames)
    : lg;
  const cur = ctx.skaters.get(pid);
  const gp = cur?.gamesPlayed || 0;
  const rate = ((cur?.[key] || 0) + priorRate * SHRINK.playerGames) / (gp + SHRINK.playerGames);
  return { rate, gp, cur: cur ? { gp, [key]: cur[key], toi: cur.avgTimeOnIcePerGame } : null, priorRate, priorGp: pr?.gamesPlayed || 0 };
}
function projectSkater(market: string, own: TeamCtx, opp: TeamCtx, pid: string, pos: string) {
  if (market === "player_shots_on_goal") {
    const s = skaterRate(own, pid, pos, "shots");
    // opponent shot suppression: opponent shots-against/g vs league, half-weighted
    const oppSA = teamRate(opp.shotsAgainst, opp.gp);
    const oppMult = Math.min(1.12, Math.max(0.88, 1 + 0.5 * (oppSA / LG_TEAM_SHOTS_PER_G - 1)));
    return { mean: s.rate * oppMult, inputs: { ...s, oppSAperG: oppSA, oppMult } };
  }
  if (market === "player_points") {
    const s = skaterRate(own, pid, pos, "points");
    return { mean: s.rate, inputs: s };
  }
  return null;
}
function projectGoalie(own: TeamCtx, opp: TeamCtx, pid: string) {
  const cur = own.goalies.get(pid), pr = own.priorGoalies.get(pid);
  const saves = (cur?.saves || 0) + 0.5 * (pr?.saves || 0);
  const sa = (cur?.shotsAgainst || 0) + 0.5 * (pr?.shotsAgainst || 0);
  const svPct = (saves + LG_SV_PCT * SHRINK.goalieShots) / (sa + SHRINK.goalieShots);
  const oppSF = teamRate(opp.shotsFor, opp.gp);
  const ownSA = teamRate(own.shotsAgainst, own.gp);
  const expSA = 0.5 * (oppSF + ownSA);
  return { mean: expSA * svPct, inputs: { svPct, oppSFperG: oppSF, ownSAperG: ownSA, expSA, curGp: cur?.gamesPlayed || 0 } };
}

// ---------------- jobs ----------------
async function creditsUsedThisMonth(sb: any) {
  const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  const { data } = await sb.from("collector_runs").select("credits_used").eq("sport", SPORT).gte("started_at", start.toISOString());
  return (data || []).reduce((s: number, r: any) => s + (r.credits_used || 0), 0);
}

async function upsertGames(sb: any, date: string) {
  const sched = await getJson(`${NHL}/schedule/${date}`);
  const day = (sched.gameWeek || []).find((d: any) => d.date === date);
  const games = (day?.games || []).filter((g: any) => g.gameType === 2 || g.gameType === 3);
  const rows = games.map((g: any) => ({
    sport: SPORT, event_id: String(g.id), start_time: g.startTimeUTC, season: String(g.season), game_type: String(g.gameType),
    home: g.homeTeam.abbrev, away: g.awayTeam.abbrev,
    home_name: `${g.homeTeam.placeName?.default ?? ""} ${g.homeTeam.commonName?.default ?? ""}`.trim(),
    away_name: `${g.awayTeam.placeName?.default ?? ""} ${g.awayTeam.commonName?.default ?? ""}`.trim(),
    status: g.gameState, updated_at: new Date().toISOString(),
  }));
  if (rows.length) {
    const { error } = await sb.from("events").upsert(rows, { onConflict: "sport,event_id", ignoreDuplicates: false });
    if (error) throw error;
  }
  return games;
}

async function snapshot(sb: any, kind: "open" | "close", notes: any) {
  const key = Deno.env.get("ODDS_API_KEY");
  if (!key) throw new Error("ODDS_API_KEY not set");
  const used = await creditsUsedThisMonth(sb);
  if (used >= MONTHLY_CAP) { notes.skipped = `monthly cap reached (${used}/${MONTHLY_CAP})`; return 0; }

  const games = await upsertGames(sb, etDate());
  const now = Date.now();
  let targets = games.filter((g: any) => ["FUT", "PRE"].includes(g.gameState) && Date.parse(g.startTimeUTC) > now);
  if (kind === "close") targets = targets.filter((g: any) => Date.parse(g.startTimeUTC) - now <= 50 * 60000);
  if (!targets.length) { notes.targets = 0; return 0; }

  // skip games already snapshotted for this kind
  const { data: done } = await sb.from("quotes").select("event_id").eq("sport", SPORT).eq("snapshot_kind", kind)
    .in("event_id", targets.map((g: any) => String(g.id)));
  const doneSet = new Set((done || []).map((r: any) => r.event_id));
  targets = targets.filter((g: any) => !doneSet.has(String(g.id)));
  notes.targets = targets.length;
  if (!targets.length) return 0;

  const events = await getJson(`${ODDS}/sports/${ODDS_SPORT}/events?apiKey=${key}&dateFormat=iso`); // free
  const cache = new Map<string, TeamCtx>();
  let credits = 0, remaining: number | null = null;
  notes.games = [];

  for (const g of targets) {
    const homeName = normName(`${g.homeTeam.placeName?.default ?? ""} ${g.homeTeam.commonName?.default ?? ""}`);
    const awayName = normName(`${g.awayTeam.placeName?.default ?? ""} ${g.awayTeam.commonName?.default ?? ""}`);
    const commonH = normName(g.homeTeam.commonName?.default ?? ""), commonA = normName(g.awayTeam.commonName?.default ?? "");
    const ev = (events || []).find((e: any) => {
      const h = normName(e.home_team), a = normName(e.away_team);
      const sameDay = Math.abs(Date.parse(e.commence_time) - Date.parse(g.startTimeUTC)) < 6 * 3600000;
      return sameDay && (h === homeName || h.endsWith(commonH)) && (a === awayName || a.endsWith(commonA));
    });
    if (!ev) { notes.games.push({ id: g.id, err: "no odds event match" }); continue; }
    if (remaining != null && remaining < ACCOUNT_FLOOR) { notes.games.push({ id: g.id, err: "account floor" }); continue; }

    const url = `${ODDS}/sports/${ODDS_SPORT}/events/${ev.id}/odds?apiKey=${key}&regions=us&oddsFormat=american&markets=${MARKETS.join(",")}&bookmakers=${BOOKS.join(",")}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const last = Number(r.headers.get("x-requests-last") ?? 0);
    const rem = r.headers.get("x-requests-remaining");
    credits += isFinite(last) ? last : 0;
    if (rem != null) remaining = Number(rem);
    if (!r.ok) { notes.games.push({ id: g.id, err: `odds ${r.status}` }); continue; }
    const data = await r.json();

    await sb.from("events").update({ odds_event_id: ev.id }).eq("sport", SPORT).eq("event_id", String(g.id));
    const season = g.season;
    const [home, away] = await Promise.all([teamCtx(g.homeTeam.abbrev, season, cache), teamCtx(g.awayTeam.abbrev, season, cache)]);

    const resolve = (name: string) => {
      const n = normName(name);
      const h = home.roster.get(n); if (h) return { ...h, own: home, opp: away };
      const a = away.roster.get(n); if (a) return { ...a, own: away, opp: home };
      return null;
    };

    const quoteRows: any[] = [];
    const predRows = new Map<string, any>();
    let unmatched = 0;
    for (const bm of data.bookmakers || []) {
      for (const mk of bm.markets || []) {
        if (!MARKETS.includes(mk.key)) continue;
        const byKey = new Map<string, any>();
        for (const o of mk.outcomes || []) {
          const side = String(o.name || "").toLowerCase();
          if (side !== "over" && side !== "under") continue;
          const k = `${o.description}|${o.point}`;
          const row = byKey.get(k) || { player: o.description, line: o.point, over: null, under: null };
          row[side] = o.price; byKey.set(k, row);
        }
        for (const q of byKey.values()) {
          const who = resolve(q.player);
          if (!who) unmatched++;
          quoteRows.push({
            sport: SPORT, event_id: String(g.id), snapshot_kind: kind, book: bm.key, market: mk.key,
            player_id: who?.id ?? null, player_name: q.player, line: q.line, over_price: q.over, under_price: q.under,
            book_updated_at: mk.last_update || bm.last_update || null,
          });
          if (!who || q.line == null) continue;
          const pk = `${who.id}|${mk.key}|${q.line}`;
          if (predRows.has(pk)) continue;
          const proj = mk.key === "player_total_saves"
            ? (who.pos === "G" ? projectGoalie(who.own, who.opp, who.id) : null)
            : (who.pos !== "G" ? projectSkater(mk.key, who.own, who.opp, who.id, who.pos) : null);
          if (!proj || !isFinite(proj.mean)) continue;
          const phi = PHI[mk.key as keyof typeof PHI];
          const p = priceLine(proj.mean, phi, Number(q.line));
          predRows.set(pk, {
            sport: SPORT, event_id: String(g.id), player_id: who.id, player_name: who.name, team: who.own.abbrev,
            market: mk.key, line: q.line, model_version: MODEL_VERSION, snapshot_kind: kind,
            proj: +proj.mean.toFixed(4), dist: phi <= 1.0001 ? "poisson" : `negbin(phi=${phi})`,
            p_over: +p.over.toFixed(5), p_under: +p.under.toFixed(5), p_push: +p.push.toFixed(5),
            inputs: proj.inputs,
          });
        }
      }
    }
    if (quoteRows.length) { const { error } = await sb.from("quotes").insert(quoteRows); if (error) throw error; }
    if (predRows.size) {
      const { error } = await sb.from("predictions").upsert([...predRows.values()], { onConflict: "sport,event_id,player_id,market,line,model_version,snapshot_kind", ignoreDuplicates: true });
      if (error) throw error;
    }
    notes.games.push({ id: g.id, matchup: `${g.awayTeam.abbrev}@${g.homeTeam.abbrev}`, quotes: quoteRows.length, predictions: predRows.size, unmatched, credits: last });
  }
  notes.remaining = remaining;
  return { credits, remaining };
}

async function settle(sb: any, notes: any) {
  // refresh today's schedule too, so status/start-time changes (postponements) are recorded
  await upsertGames(sb, etDate()).catch(() => null);
  const cutoff = new Date(Date.now() - 2 * 3600000).toISOString();
  const { data: open } = await sb.from("events").select("event_id").eq("sport", SPORT).eq("final", false).lt("start_time", cutoff).limit(40);
  notes.checked = (open || []).length; notes.settled = [];
  for (const e of open || []) {
    let box: any;
    try { box = await getJson(`${NHL}/gamecenter/${e.event_id}/boxscore`); } catch (err) { notes.settled.push({ id: e.event_id, err: String(err) }); continue; }
    const finished = ["OFF", "FINAL"].includes(box.gameState);
    const upd: any = { status: box.gameState, home_score: box.homeTeam?.score ?? null, away_score: box.awayTeam?.score ?? null, updated_at: new Date().toISOString() };
    if (["PPD", "CNCL"].includes(box.gameScheduleState)) upd.status = box.gameScheduleState;
    if (!finished) { await sb.from("events").update(upd).eq("sport", SPORT).eq("event_id", e.event_id); continue; }
    const rows: any[] = [];
    const toSec = (t: string) => { const [m, s] = String(t || "0:0").split(":").map(Number); return (m || 0) * 60 + (s || 0); };
    for (const side of ["homeTeam", "awayTeam"]) {
      const t = box.playerByGameStats?.[side] || {};
      for (const p of [...(t.forwards || []), ...(t.defense || [])]) {
        const pid = String(p.playerId), played = toSec(p.toi) > 0;
        for (const [stat, v] of [["sog", p.sog], ["points", p.points], ["goals", p.goals], ["assists", p.assists], ["toi_sec", toSec(p.toi)]] as [string, number][])
          rows.push({ sport: SPORT, event_id: e.event_id, player_id: pid, stat, value: v ?? 0, participated: played, source: "nhl boxscore" });
      }
      for (const p of t.goalies || []) {
        const pid = String(p.playerId), played = toSec(p.toi) > 0;
        for (const [stat, v] of [["saves", p.saves], ["shots_against", p.shotsAgainst], ["toi_sec", toSec(p.toi)], ["starter", p.starter ? 1 : 0]] as [string, number][])
          rows.push({ sport: SPORT, event_id: e.event_id, player_id: pid, stat, value: v ?? 0, participated: played, source: "nhl boxscore" });
      }
    }
    if (rows.length) { const { error } = await sb.from("outcomes").upsert(rows, { onConflict: "sport,event_id,player_id,stat" }); if (error) throw error; }
    upd.final = true;
    await sb.from("events").update(upd).eq("sport", SPORT).eq("event_id", e.event_id);
    notes.settled.push({ id: e.event_id, rows: rows.length });
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const token = req.headers.get("x-collector-token") || "";
  const { data: ok } = await sb.rpc("check_collector_token", { t: token });
  if (!ok) return json({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const job = body.job || "snapshot";
  const { data: run } = await sb.from("collector_runs").insert({ sport: SPORT, job: job === "snapshot" ? `snapshot:${body.kind || "open"}` : job }).select("id").single();
  const notes: any = { model: MODEL_VERSION };
  let credits = 0, remaining: number | null = null, error: string | null = null;
  try {
    if (job === "snapshot") {
      const res: any = await snapshot(sb, body.kind === "close" ? "close" : "open", notes);
      if (res) { credits = res.credits || 0; remaining = res.remaining ?? null; }
    } else if (job === "settle") {
      await settle(sb, notes);
    } else {
      throw new Error(`unknown job ${job}`);
    }
  } catch (e) {
    error = String((e as Error)?.message || e);
  }
  if (run) await sb.from("collector_runs").update({ finished_at: new Date().toISOString(), credits_used: credits, credits_remaining: remaining, notes, error }).eq("id", run.id);
  return json({ ok: !error, error, credits, remaining, notes }, error ? 500 : 200);
});
