// statcast-proxy — server-side Baseball Savant proxy.
// Bypasses browser CORS restrictions and bot-detection blocks on Savant CSV/JSON endpoints.
// No secrets required — this just forwards requests with proper browser headers.

import "@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export default {
  fetch: async (req: Request): Promise<Response> => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const { searchParams } = new URL(req.url);
    const target = searchParams.get("url"); // full encoded Savant URL

    if (!target) {
      return new Response("missing url param", { status: 400, headers: CORS });
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      return new Response("invalid url encoding", { status: 400, headers: CORS });
    }

    let upstream: Response;
    try {
      upstream = await fetch(decoded, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/csv,application/json,*/*",
          "Referer": "https://baseballsavant.mlb.com/",
          "Origin": "https://baseballsavant.mlb.com",
        },
      });
    } catch (e) {
      return new Response(`upstream fetch failed: ${e}`, { status: 502, headers: CORS });
    }

    const body = await upstream.arrayBuffer();
    const contentType = upstream.headers.get("Content-Type") ?? "text/plain";

    return new Response(body, {
      status: upstream.status,
      headers: { ...CORS, "Content-Type": contentType },
    });
  },
};
