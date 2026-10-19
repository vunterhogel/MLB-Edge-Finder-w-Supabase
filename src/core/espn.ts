/* ESPN public JSON helpers shared by every sport that uses ESPN (NHL now; NBA/NFL as they move onto
   the shell). ESPN sends Access-Control-Allow-Origin: *, so these work straight from the browser.
   `sport` is the ESPN path pair, e.g. "hockey/nhl". */
export const espnSite = (sport) => `https://site.api.espn.com/apis/site/v2/sports/${sport}`;
export const espnWeb = (sport) => `https://site.web.api.espn.com/apis/common/v3/sports/${sport}`;
export const espnV2 = (sport) => `https://site.api.espn.com/apis/v2/sports/${sport}`;

export async function jget(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status}`); return r.json(); }
export function ymd(dateStr) { return String(dateStr).replace(/-/g, ""); }
export function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }
export function numOrNull(v) { const n = Number(v); return v === "" || v == null || !Number.isFinite(n) ? null : n; }
/* "22:32" -> 22.53 minutes; plain numbers pass through */
export function toMinutes(v) {
  if (v == null) return 0;
  const s = String(v);
  if (s.includes(":")) { const [m, sec] = s.split(":"); return num(m) + num(sec) / 60; }
  return num(s);
}

/* Athlete gamelog -> one row per game, newest first:
   { eventId, date, atVs: "vs"|"@", opp, oppId, result, score, postseason, s: { statName: value } }.
   ESPN keeps the per-game numbers under seasonTypes[].categories[].events[] and the game metadata in
   a separate events{} dict; they are joined by eventId. */
export async function fetchGamelog(sport, athleteId, season = null) {
  const d = await jget(`${espnWeb(sport)}/athletes/${athleteId}/gamelog${season ? `?season=${season}` : ""}`);
  const names = d.names || [];
  if (!names.length) return [];
  const meta = (d.events && typeof d.events === "object") ? d.events : {};
  const rows = [];
  for (const st of d.seasonTypes || []) {
    const label = String(st.displayName || "");
    if (/pre-?season/i.test(label)) continue;   // exhibition games never feed a model or a trend
    const post = /post/i.test(label);
    for (const cat of st.categories || []) {
      const evs = Array.isArray(cat.events) ? cat.events : Object.values(cat.events || {});
      for (const ev of evs) {
        if (!ev || !ev.stats || ev.eventId == null) continue;
        const m = meta[ev.eventId] || {};
        const s = {};
        names.forEach((n, i) => { s[n] = n === "timeOnIcePerGame" ? toMinutes(ev.stats[i]) : num(ev.stats[i]); });
        rows.push({
          eventId: String(ev.eventId), date: m.gameDate || null, atVs: m.atVs || null,
          opp: (m.opponent && m.opponent.abbreviation) || null, oppId: m.opponent ? String(m.opponent.id) : null,
          result: m.gameResult || null, score: m.score || null, postseason: post, s,
        });
      }
    }
  }
  rows.sort((a, b) => (Date.parse(b.date || 0) || 0) - (Date.parse(a.date || 0) || 0));
  return rows;
}

/* Game summary -> status, score and every player's box line keyed by athlete id. */
export async function fetchSummary(sport, eventId) {
  const d = await jget(`${espnSite(sport)}/summary?event=${eventId}`);
  const comp = d.header && d.header.competitions && d.header.competitions[0];
  const st = comp && comp.status && comp.status.type;
  const home = comp && (comp.competitors || []).find((c) => c.homeAway === "home");
  const away = comp && (comp.competitors || []).find((c) => c.homeAway === "away");
  const players = {};
  for (const team of (d.boxscore && d.boxscore.players) || []) {
    const teamId = team.team && String(team.team.id);
    for (const cat of team.statistics || []) {
      const keys = cat.keys || cat.names || [];
      for (const a of cat.athletes || []) {
        const id = a.athlete && String(a.athlete.id);
        if (!id) continue;
        const p = (players[id] = players[id] || { group: cat.name, teamId, scratched: !!a.athlete.scratched });
        (a.stats || []).forEach((v, i) => { const k = keys[i]; if (k) p[k] = /timeOnIce/i.test(k) ? toMinutes(v) : num(v); });
      }
    }
  }
  return {
    final: !!(st && st.completed), state: st ? st.state : null, canceled: !!(st && /CANCEL|POSTPON/i.test(String(st.name || ""))),
    period: comp && comp.status ? comp.status.period : null, clock: comp && comp.status ? comp.status.displayClock : null,
    homeScore: home && home.score != null ? +home.score : null, awayScore: away && away.score != null ? +away.score : null,
    homeId: home && home.team ? String(home.team.id) : null, awayId: away && away.team ? String(away.team.id) : null,
    players, plays: d.plays || [], injuries: d.injuries || [],
  };
}

/* Universal player search, filtered to one league slug (e.g. "nhl"). */
export async function searchEspnPlayers(league, query) {
  const q = String(query || "").trim();
  if (!q) return [];
  const d = await jget(`https://site.api.espn.com/apis/search/v2?query=${encodeURIComponent(q)}&limit=20&type=player`);
  const out = [];
  for (const block of d.results || []) {
    for (const p of block.contents || []) {
      if (p.defaultLeagueSlug !== league) continue;
      const m = String(p.uid || "").match(/a:(\d+)/);
      if (!m) continue;
      out.push({ id: m[1], name: p.displayName || "", teamName: p.subtitle || "" });
    }
  }
  return out;
}
