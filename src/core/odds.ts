 // a hitter faces the opposing STARTER for ~60% of the game; bullpen (team RA/G) covers the rest

// Supabase project — URL is safe to expose client-side; the Odds API key lives as a server-side secret.
// Get SUPABASE_ANON_KEY from: Supabase Dashboard → Project Settings → API → "anon public"
export const SUPABASE_URL = "https://jkpctgapbsyzqjfiiuoe.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprcGN0Z2FwYnN5enFqZmlpdW9lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4NzE5MDMsImV4cCI6MjEwMzQ0NzkwM30.9UT8ILqf6Xpk9LNangxZKfQZmv6Woa7WlbzRVyxdttg"; // safe to expose — grants only public access
export const ODDS_PROXY_URL = `${SUPABASE_URL}/functions/v1/odds-proxy`;

/* ---------------------- The Odds API ---------------------- */
export function normName(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z ]/g, " ").replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/\s+/g, " ").trim();
}
export function oddsProxyFetch(path: string, query: string) {
  const url = `${ODDS_PROXY_URL}?path=${encodeURIComponent(path)}&query=${encodeURIComponent(query)}`;
  return fetch(url, { headers: { "apikey": SUPABASE_ANON_KEY } });
}
// -> [{ type, player, point, over, under }]
// Robust to: Over/Under markets, Yes/No markets (HR), missing point (->0.5),
// and the side appearing in EITHER the name or description field.
export const sideOf = (s) => { s = (s || "").toLowerCase().trim(); if (s === "over" || s === "yes") return "over"; if (s === "under" || s === "no") return "under"; return null; };
