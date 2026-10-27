/* Public stat files fetched through Edge Finder's own nfl-stats-proxy Supabase function (GitHub release
   downloads can't be read from a browser directly), plus a parquet reader for the compact season files
   sportsdataverse publishes (a full NBA season is ~600KB as parquet vs ~18MB as CSV).
   The parquet library loads on first use only, so pages that never need it don't download it. */
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./odds";

const PROXY = `${SUPABASE_URL}/functions/v1/nfl-stats-proxy`;

export async function fetchViaProxy(url, as = "text") {
  const r = await fetch(`${PROXY}?url=${encodeURIComponent(url)}`, { headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}`, apikey: SUPABASE_ANON_KEY } });
  if (!r.ok) throw new Error(`${url.split("/").pop()}: ${r.status}`);
  return as === "buffer" ? r.arrayBuffer() : r.text();
}

// rows of a parquet file (only the named columns), as plain objects with numbers (never BigInt)
export async function readParquet(buffer, columns) {
  const [{ parquetReadObjects }, { compressors }] = await Promise.all([import("hyparquet"), import("hyparquet-compressors")]);
  const rows = await parquetReadObjects({ file: buffer, columns, compressors });
  for (const r of rows) for (const k in r) if (typeof r[k] === "bigint") r[k] = Number(r[k]);
  return rows;
}

// localStorage cache with an age limit; every read/write is safe when storage is unavailable or full
export function cacheGet(key, maxAgeMs) {
  try { const c = JSON.parse(localStorage.getItem(key) || "null"); return c && Date.now() - c.at < maxAgeMs ? c.v : null; } catch { return null; }
}
export function cacheSet(key, v) {
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), v })); } catch { /* storage full or unavailable */ }
}
