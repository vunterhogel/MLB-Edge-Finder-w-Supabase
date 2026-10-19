/* Shared data layer for the unified Edge Finder research backbone (Supabase).
   Every sport reads/writes the SAME tables: events, snapshots, predictions, quotes, outcomes,
   tracked_bets (+ views v_prop_board, v_tracked_bets).

   Reads use the public anon key (read-only by RLS). Writes and paid odds pulls require the private
   "Edge Finder key" (sent as x-ef-key), which the user pastes once into the app; it lives only in
   this browser's localStorage, never in the repo. */

export const SUPABASE_URL = "https://jkpctgapbsyzqjfiiuoe.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprcGN0Z2FwYnN5enFqZmlpdW9lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4NzE5MDMsImV4cCI6MjEwMzQ0NzkwM30.9UT8ILqf6Xpk9LNangxZKfQZmv6Woa7WlbzRVyxdttg";

const LS_KEY = "ef_writer_key_v1";
export function getWriterKey(): string {
  try { return localStorage.getItem(LS_KEY) || ""; } catch { return ""; }
}
export function setWriterKey(k: string) {
  try { if (k) localStorage.setItem(LS_KEY, k.trim()); else localStorage.removeItem(LS_KEY); } catch { /* storage unavailable */ }
}

function headers(extra: Record<string, string> = {}, withKey = false): Record<string, string> {
  const h: Record<string, string> = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, ...extra };
  const k = withKey ? getWriterKey() : "";
  if (k) h["x-ef-key"] = k;
  return h;
}

/** GET every row for a PostgREST query, paging past the server's 1,000-row cap. */
export async function selectAll(pathAndQuery: string, pageSize = 1000): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += pageSize) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
      headers: headers({ Range: `${from}-${from + pageSize - 1}`, "Range-Unit": "items" }),
    });
    if (!r.ok && r.status !== 206) throw new Error(`${r.status} ${await r.text().catch(() => "")}`.trim());
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

export async function insertRow(table: string, row: any): Promise<any> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json", Prefer: "return=representation" }, true),
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? "Not allowed: set your Edge Finder key first (🔑)." : `${r.status} ${await r.text().catch(() => "")}`);
  return (await r.json())[0];
}

export async function updateRows(table: string, filter: string, patch: any): Promise<void> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: headers({ "Content-Type": "application/json", Prefer: "return=minimal" }, true),
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => "")}`);
}

/** true when the stored key is accepted by the database (no side effects). */
export async function checkWriterKey(): Promise<boolean> {
  if (!getWriterKey()) return false;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ef_writer_ok`, {
    method: "POST", headers: headers({ "Content-Type": "application/json" }, true), body: "{}",
  });
  return r.ok ? (await r.json()) === true : false;
}

/** Call a sport's collector edge function (manual pulls / settlement). */
export async function callCollector(fnName: string, body: any): Promise<any> {
  const key = getWriterKey();
  if (!key) throw new Error("Set your Edge Finder key first (🔑) to pull odds or settle.");
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${fnName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ef-key": key },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error("Edge Finder key rejected. Re-enter it (🔑).");
  if (!r.ok) throw new Error(data.error || `collector ${r.status}`);
  return data;
}

/* ---------------- shared pricing math (sport-agnostic) ---------------- */
export const impliedProb = (o: number) => (o < 0 ? -o / (-o + 100) : 100 / (o + 100));
export const decimalOdds = (o: number) => (o > 0 ? 1 + o / 100 : 1 + 100 / -o);
export const fmtOdds = (o: number | null | undefined) => (o == null || isNaN(o as number) ? "—" : o > 0 ? `+${o}` : `${o}`);
export const pct = (x: number | null | undefined, d = 1) => (x == null || isNaN(x) ? "—" : `${(x * 100).toFixed(d)}%`);

/** Price one side of a line. Push-aware: the market's de-vigged price is a no-push (two-way)
 *  probability, so the model is blended on the same conditional-on-no-push basis, then the push
 *  mass is restored for EV: EV = P(win)·(dec−1) − P(loss). */
export function priceSide(opts: {
  side: "over" | "under"; pOver: number | null; pUnder: number | null; pPush: number | null;
  novigOver: number | null; odds: number | null; keep: number;
}) {
  const { side, pOver, pUnder, novigOver, odds, keep } = opts;
  const push = opts.pPush || 0;
  const rawWin = side === "over" ? pOver : pUnder;
  if (rawWin == null || !isFinite(rawWin)) return null;
  const denom = 1 - push > 1e-9 ? 1 - push : 1;
  const rawCond = rawWin / denom;
  const mkt = novigOver == null ? null : side === "over" ? novigOver : 1 - novigOver;
  const blendCond = mkt == null ? rawCond : mkt + keep * (rawCond - mkt);
  const pWin = blendCond * denom, pLoss = (1 - blendCond) * denom;
  const ev = odds == null ? null : pWin * (decimalOdds(odds) - 1) - pLoss;
  return { rawCond, blendCond, mkt, edge: mkt == null ? null : blendCond - mkt, rawEdge: mkt == null ? null : rawCond - mkt, ev, push };
}

/* ---------------- dates (US Eastern slate days) ---------------- */
export function etToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
export function shiftDate(d: string, days: number): string {
  const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + days); return t.toISOString().slice(0, 10);
}
/** UTC window that safely contains one ET slate day (08:00Z..08:00Z next day covers EDT and EST). */
export function slateWindow(d: string) { return { from: `${d}T08:00:00Z`, to: `${shiftDate(d, 1)}T08:00:00Z` }; }
export function fmtTimeET(iso: string | null) {
  if (!iso) return "TBD";
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
}
