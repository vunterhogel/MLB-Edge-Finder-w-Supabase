// odds-proxy — server-side Odds API proxy.
// The ODDS_API_KEY secret never reaches the browser; the edge function appends it before forwarding.
// Set the secret with: supabase secrets set ODDS_API_KEY=<your-key>

import "@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ODDS_BASE = "https://api.the-odds-api.com/v4";

export default {
  fetch: async (req: Request): Promise<Response> => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const key = Deno.env.get("ODDS_API_KEY");
    if (!key) {
      return Response.json({ error: "ODDS_API_KEY secret not set" }, { status: 500, headers: CORS });
    }

    const { searchParams } = new URL(req.url);
    const path = searchParams.get("path");   // e.g. /sports/baseball_mlb/events
    const query = searchParams.get("query"); // e.g. dateFormat=iso

    if (!path) {
      return Response.json({ error: "missing path param" }, { status: 400, headers: CORS });
    }

    const targetUrl = `${ODDS_BASE}${path}?apiKey=${key}${query ? `&${query}` : ""}`;

    let upstream: Response;
    try {
      upstream = await fetch(targetUrl);
    } catch (e) {
      return Response.json({ error: `upstream fetch failed: ${e}` }, { status: 502, headers: CORS });
    }

    const body = await upstream.arrayBuffer();
    const remaining = upstream.headers.get("x-requests-remaining");

    const resHeaders: Record<string, string> = { ...CORS, "Content-Type": "application/json" };
    if (remaining !== null) resHeaders["x-requests-remaining"] = remaining;

    return new Response(body, { status: upstream.status, headers: resHeaders });
  },
};
