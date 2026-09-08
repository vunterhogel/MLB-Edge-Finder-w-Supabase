// nba-stats-proxy — server-side proxy for NBA data sources.
// Mirrors nfl-stats-proxy's job (which mirrors statcast-proxy for MLB): bypass
// browser CORS/bot-detection on upstream hosts. No secrets required — ESPN's
// hidden API is public; this just forwards requests with sane headers.

import "@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Only ever proxy to these hosts — this function forwards arbitrary URLs, so keep it
// pinned to the specific upstream sources the NBA engine actually needs.
const ALLOWED_HOSTS = new Set([
  "site.api.espn.com",
  "site.web.api.espn.com",
  "sports.core.api.espn.com",
  "cdn.espn.com",
]);

export default {
  fetch: async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const { searchParams } = new URL(req.url);
    const target = searchParams.get("url"); // full encoded upstream URL
    if (!target) {
      return new Response("missing url param", { status: 400, headers: CORS });
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      return new Response("invalid url encoding", { status: 400, headers: CORS });
    }

    let host: string;
    try {
      host = new URL(decoded).hostname;
    } catch {
      return new Response("invalid target url", { status: 400, headers: CORS });
    }
    if (!ALLOWED_HOSTS.has(host)) {
      return new Response(`host not allowed: ${host}`, { status: 400, headers: CORS });
    }

    let upstream: Response;
    try {
      upstream = await fetch(decoded, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json,text/plain,*/*",
        },
        redirect: "follow",
      });
    } catch (e) {
      return new Response(`upstream fetch failed: ${e}`, { status: 502, headers: CORS });
    }

    if (!upstream.ok) {
      return new Response(`upstream ${upstream.status}`, { status: upstream.status, headers: CORS });
    }

    const body = await upstream.arrayBuffer();
    const contentType = upstream.headers.get("Content-Type") ?? "application/json";
    return new Response(body, { status: 200, headers: { ...CORS, "Content-Type": contentType } });
  },
};
