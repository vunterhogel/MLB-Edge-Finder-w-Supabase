# Integrating the NFL Edge Finder — full step-by-step walkthrough

This zip is your existing MLB Edge Finder StackBlitz project with the NFL clone
added alongside it. **Nothing in the MLB app was touched** except one line in
`main.tsx` (step 4 below). Read `NFL_PROJECTION_MODELS.md` first if you want
the projection methodology — this file is the "how do I actually get this
running" walkthrough, written against your real setup:

- **GitHub repo:** `vunterhogel/MLB-Edge-Finder-w-Supabase`
- **StackBlitz:** `https://stackblitz.com/github/vunterhogel/MLB-Edge-Finder-w-Supabase`
- **Supabase project:** `jkpctgapbsyzqjfiiuoe` (dashboard: `https://supabase.com/dashboard/project/jkpctgapbsyzqjfiiuoe`)
- **Local folder:** `/Users/huntervogel/Desktop/MLB Edge Finder FULL TESTER (Patched)`

Follow the steps in order. Each one says how to know it worked before you
move to the next.

---

## 0. What you're about to add, in plain terms

Right now your project is one React app (`src/App.tsx`) plus one Supabase
backend with two edge functions (`odds-proxy`, `statcast-proxy`). After this
integration, the same project has *two* apps — MLB (unchanged) and NFL (new)
— behind a small switcher screen, sharing the same Supabase backend plus one
new edge function (`nfl-stats-proxy`). You will not create a second Supabase
project, a second GitHub repo, or a second StackBlitz — everything lands in
the one you already have.

## 1. What's new in this zip

```
supabase/functions/nfl-stats-proxy/     NEW edge function (ESPN + nflverse proxy)
supabase/config.toml                    ADDED a [functions.nfl-stats-proxy] block
src/nfl/NFLApp.tsx                      NEW — the entire NFL engine + UI (self-contained,
                                         mirrors App.tsx's structure/patterns exactly)
src/Root.tsx                            NEW — tiny sport switcher (⚾/🏈 toggle)
src/main.tsx                            CHANGED — renders <Root/> instead of <App/> directly
NFL_PROJECTION_MODELS.md                NEW — the design doc this code implements
INTEGRATION.md                          this file
```

`src/App.tsx` (MLB) is **byte-for-byte unchanged**. `supabase/functions/odds-proxy`
is **byte-for-byte unchanged** — it was already sport-agnostic (forwards
`path`/`query` to The Odds API verbatim), so pointing it at
`americanfootball_nfl` costs zero new backend code. `supabase/functions/statcast-proxy`
is also untouched; the new `nfl-stats-proxy` function sits next to it rather
than replacing it.

Skim this list once so nothing below surprises you, then start at step 2.

## 2. Unzip and merge into your local folder

1. Unzip `NFL_Edge_Finder_Integration.zip` somewhere temporary (e.g. your
   Downloads folder) — do **not** unzip it directly on top of your project
   yet, so you can look at it first.
2. Open the unzipped folder side-by-side with
   `/Users/huntervogel/Desktop/MLB Edge Finder FULL TESTER (Patched)` and
   confirm it has the same shape as the file list in step 1 (a `src/nfl/`
   folder, a `supabase/functions/nfl-stats-proxy/` folder, etc.) — this
   catches a bad/partial download before it touches your real project.
3. Copy these into your real project folder, overwriting only where a
   destination file doesn't already exist for anything except `main.tsx`
   (which you're intentionally changing in step 4):
   - `src/nfl/` → new folder, copy the whole thing in
   - `src/Root.tsx` → new file
   - `supabase/functions/nfl-stats-proxy/` → new folder, copy the whole thing in
   - `NFL_PROJECTION_MODELS.md`, `INTEGRATION.md` → new files at the project root
   - Leave `src/main.tsx` where it is for now — you'll hand-edit it in step 4
     rather than overwrite it, in case you've since made your own tweaks to it.
4. **Do not copy** `node_modules/`, `dist/`, or `supabase/.temp/` from the zip
   — the zip was stripped of these before packaging (they're
   environment-specific and get regenerated); your project's real ones stay
   put.

**Checkpoint:** run `ls src/nfl supabase/functions` from your project root —
you should see `NFLApp.tsx` and `nfl-stats-proxy` (alongside your existing
`odds-proxy` and `statcast-proxy`).

## 3. Add the new edge function's config block

Open `supabase/config.toml` and find the existing block that looks like this:

```toml
[functions.statcast-proxy]
enabled = true
verify_jwt = false
import_map = "./functions/statcast-proxy/deno.json"
entrypoint = "./functions/statcast-proxy/index.ts"
```

Directly after it, add:

```toml
[functions.nfl-stats-proxy]
enabled = true
verify_jwt = false
import_map = "./functions/nfl-stats-proxy/deno.json"
entrypoint = "./functions/nfl-stats-proxy/index.ts"
```

(If you copied the zip's `supabase/config.toml` wholesale instead of
hand-editing, it already has this block — but then double-check nothing else
in your `config.toml` that you'd customized since the zip was generated got
silently reverted. When in doubt, hand-edit rather than overwrite this file.)

**Checkpoint:** `grep nfl-stats-proxy supabase/config.toml` should print the
block above.

## 4. Wire up the sport switcher

Open `src/main.tsx`. It currently reads:

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(<App />);
```

Change the two `App` lines to `Root`:

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import Root from './Root';

createRoot(document.getElementById('root')!).render(<Root />);
```

That's the only edit to an existing file in this entire integration.

If you'd rather not have a MLB/NFL toggle screen at all right now — say, you
want to test NFL in isolation first — render `NFLApp` directly instead:

```tsx
import NFLApp from './nfl/NFLApp';
createRoot(document.getElementById('root')!).render(<NFLApp />);
```

You can switch back to `<Root/>` later with no other changes needed; nothing
else depends on which one `main.tsx` renders.

**Checkpoint:** this is a 3-line file — just re-read it back and confirm it
matches one of the two versions above exactly (missing the `.tsx` import
extension, a leftover `App` reference, or a stray semicolon are the usual
copy-paste slips).

## 5. Run it locally first (catch problems before deploying anything)

From your project root:

```bash
npm install
npm run dev
```

Open the printed local URL (usually `http://localhost:5173`). You should see
the sport switcher bar at the top (⚾ MLB Edge Finder / 🏈 NFL Edge Finder).

- Click **⚾ MLB Edge Finder** first — it should look and behave exactly as it
  always has. If MLB is broken, stop here; that means something went wrong in
  step 2 or 4, not in the new NFL code (since `App.tsx` is untouched).
- Click **🏈 NFL Edge Finder**. The tab bar (Slate / Board / Player Analysis /
  My Bets / Stats) should render, and the Slate tab should show week/season
  controls. Data won't load yet — that needs the edge function deployed
  (step 6) — but you should see clean "loading" or empty states, not a blank
  white screen or a red error overlay.

**Checkpoint:** no red Vite/React error overlay on either tab, and the
sport-switcher buttons visibly toggle between the two apps.

If you do hit a red error overlay, copy the exact error text — it'll tell you
whether it's a missing import (something from step 2 didn't get copied) or a
syntax issue (something got truncated during copy/unzip).

## 6. Deploy the new edge function to Supabase

You already have the Supabase CLI set up for this project (you use it for
`odds-proxy`/`statcast-proxy` today). Same flow, new function name:

```bash
cd "/Users/huntervogel/Desktop/MLB Edge Finder FULL TESTER (Patched)"
supabase functions deploy nfl-stats-proxy
```

No new secrets are required for this one. `nfl-stats-proxy` only proxies
public, keyless sources (ESPN's hidden JSON API, nflverse's GitHub-hosted
CSVs) — it doesn't touch `ODDS_API_KEY` or any other secret. It's pinned to
an explicit host allowlist inside the function source (`site.api.espn.com`,
`site.web.api.espn.com`, `sports.core.api.espn.com`, nflverse's GitHub
release host) precisely so it can't be pointed at arbitrary URLs and used as
an open relay.

You do **not** need to redeploy `odds-proxy` — it's byte-for-byte unchanged.
If your existing `ODDS_API_KEY` secret is already set (it is, since MLB uses
it today), it already covers NFL requests too: The Odds API bills and scopes
by API key and request count, not by sport, so the same key that pulls MLB
odds pulls NFL odds.

**Checkpoint:** run `supabase functions list` and confirm `nfl-stats-proxy`
shows up alongside `odds-proxy` and `statcast-proxy` with status `ACTIVE`.
You can also hit it directly to sanity-check it's live:

```bash
curl "https://jkpctgapbsyzqjfiiuoe.supabase.co/functions/v1/nfl-stats-proxy?url=https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard" \
  -H "apikey: <your anon key>"
```

(Grab `<your anon key>` from Supabase Dashboard → Project Settings → API →
"anon public" — it's also already hardcoded client-side in both `App.tsx`
and `NFLApp.tsx`, since anon keys are safe to expose in the browser; only
`ODDS_API_KEY` is a real secret and it lives server-side only.) A working
response is a JSON scoreboard payload, not an error object.

## 7. Push to GitHub, then pull into StackBlitz

Same as your existing workflow:

```bash
cd "/Users/huntervogel/Desktop/MLB Edge Finder FULL TESTER (Patched)"
git add .
git commit -m "Add NFL Edge Finder"
git push
```

GitHub will prompt for credentials:
- Username: `vunterhogel`
- Password: your GitHub Personal Access Token (regenerate at GitHub →
  Settings → Developer settings → PATs if it's expired)

Then open `https://stackblitz.com/github/vunterhogel/MLB-Edge-Finder-w-Supabase`
to pull the latest commit into StackBlitz. Give it a minute to install
dependencies and boot the dev server there.

**Checkpoint:** the same visual check as step 5, but now inside StackBlitz —
sport switcher renders, both tabs load without a red error overlay.

## 8. Test it end-to-end with real data

Back in the running app (local `npm run dev` or StackBlitz — either works
once step 6 and step 7 are done):

1. Click **🏈 NFL Edge Finder**.
2. On the Slate tab, check the Week / Season-type / Year controls — they
   default to a best guess at the current week, but override them if you
   want a specific week (e.g. during the regular season, `seasonType =
   Regular Season`, and whatever week number you want).
3. Click **Refresh**. You should see a list of that week's games populate.
   If it comes back empty, you're probably looking at a bye-heavy week or a
   week with no games yet scheduled/played — try a different week to
   confirm the plumbing works before assuming something's broken.
4. Expand a game (click on it). Rosters, injury statuses, and depth charts
   should populate for both teams.
5. Click **"Fetch odds & build board"**. This calls `odds-proxy` for that
   game's player-prop and game-line markets and prices them against the
   model's projections. You should see priced candidates appear on the Board
   tab.
6. Go to the **Player Analysis** tab and try the new player search: type a
   player's name (any NFL player, not just someone in the week you loaded)
   and hit Search or Enter. You should get a results list; click a result to
   see their full projection breakdown. If their team isn't playing in the
   week/season/year you currently have loaded (a bye week, or you're on the
   wrong week), you'll get a clear message telling you that — switch weeks
   above and search again rather than treating it as a bug. You can also
   still reach this tab the fast way, by clicking a player's name directly
   on the Slate tab after expanding a game.
7. Track a bet from the Board tab, then check it shows up on **My Bets** with
   the right odds/stake.

**Checkpoint:** you've seen real games, real rosters, a real priced board,
and a real player-search result with live data — not just clean empty
states. This is the point where the integration is genuinely done, not just
"builds without crashing."

## 9. Troubleshooting

- **MLB tab breaks after this integration.** It shouldn't — `App.tsx` and
  `odds-proxy` are untouched. Re-check step 4: if `main.tsx` has a typo (e.g.
  still importing `App` but rendering `<Root/>`, or vice versa) you'll get a
  build error, not a silent MLB break, but it's the first thing to check.
- **NFL tab loads but every fetch fails / spins forever.** Almost always
  means `nfl-stats-proxy` isn't deployed yet, or deployed but not `ACTIVE` —
  re-run step 6's checkpoint. Open your browser's dev tools → Network tab
  and look at the failing request's response body; the proxy returns a
  plain-text or JSON error explaining what it hit (upstream host not
  allow-listed, upstream returned non-200, etc.) rather than failing silently.
- **Odds/board comes back empty but rosters loaded fine.** That's the
  `odds-proxy`/Odds API path, separate from `nfl-stats-proxy`. Confirm
  `ODDS_API_KEY` is actually set (`supabase secrets list` should show it) and
  that you haven't hit your Odds API monthly request cap (check
  `https://the-odds-api.com/account` — used-requests count is in the account
  page, and MLB traffic counts against the same cap).
- **Player search returns "No NFL players matched."** Double check spelling
  first — ESPN's search is name-based, not fuzzy-tolerant of major typos.
  If a name you know is right still returns nothing, it may be a very recent
  roster move ESPN's index hasn't caught up to yet.
- **Player search finds the player but says their team has no game loaded.**
  Expected behavior, not a bug — only 13-16 of the 32 teams play in any given
  week. Switch the Week/Season-type/Year controls on the Slate tab and search
  again.
- **Something else entirely.** Open the browser console (F12 → Console) and
  look for the actual JS error — because this app has no server-side error
  reporting, the console is the first and best place to look, and it'll tell
  you the exact file/line rather than a vague symptom.

## 10. How the NFL app finds the same Supabase backend

`src/nfl/NFLApp.tsx` hardcodes the same `SUPABASE_URL` (`https://jkpctgapbsyzqjfiiuoe.supabase.co`)
and `SUPABASE_ANON_KEY` already hardcoded in `src/App.tsx` — both are safe to
expose client-side (the anon key only grants public access; the real secret,
`ODDS_API_KEY`, lives server-side in the edge function and is never sent to
the browser). One Supabase project, one anon key, two sports — you don't need
to create or manage a second backend.

## 11. Known v1 simplifications (clearly marked in code, easy to extend)

These are deliberate scope cuts to ship a working v1 fast, not bugs. Each is
called out with a comment at its use site in `NFLApp.tsx`:

1. **Opponent-allowed-by-position splits are neutral (1.0×) for now.**
   `oppPassYdsAllowedToPos`, `oppRushYdsAllowed`, etc. are wired into every
   projection function and ready to receive real data (`ctx.oppXAllowed`,
   `ctx.lgXAllowed`) — they just aren't populated from a live source yet. The
   opponent-strength signal you DO get today comes from the team-level
   Moneyline/Spread/Total model (`teamSpread`, `impliedTeamPts`), which already
   flows into every player prop via game script. Wiring the position-specific
   splits is the highest-value next step — ESPN's team `/statistics` endpoint
   likely carries a `defensive` category with this (the code already tries to
   read it defensively via `fetchTeamStats`/`pickCat`); the more reliable
   long-term source is nflverse's play-by-play-derived stats via
   `nfl-stats-proxy`.
2. **No live/in-game layer yet** (MLB's `fractionRemaining`/live-odds-reprice
   machinery). The plumbing (`liveProbabilityOver`, `liveCalc`) is ported over
   and unused — pregame is where the real edge-finding value is for props
   anyway, given NFL's slower pace of state change vs. MLB.
3. **`matchCurrentOdds`/line-refresh (CLV tracking) is ported but not wired
   into a UI button** — MLB's "Refresh Lines" feature on My Bets. Straightforward
   to add; the parsing functions it depends on (`parseEventOdds`,
   `parseGameOdds`) are already there and used elsewhere.
4. **Depth-chart-driven touch share is coarse** (`RB1: 55%, RB2: 25%`,
   `WR1/2/3` target-share priors) rather than learned from real touch data.
   This is a starting prior like everything else — see `NFL_PROJECTION_MODELS.md`
   §5, retune once the Stats tab has settled bets.
5. **`CALIB_KEEP` starts at a uniform ~0.35–0.5 for every category** (see
   `NFL_PROJECTION_MODELS.md` §5) instead of MLB's category-tuned values,
   because there's no settled-bet history yet. Don't hand-tune these from
   vibes — wait for the Stats tab.

Universal player search (free-text lookup on the Player Analysis tab, the
MLB-equivalent of `searchPlayers`) is **not** a simplification anymore — it's
built and live, backed by ESPN's cross-sport search endpoint
(`site.api.espn.com/apis/search/v2`), filtered to NFL results and resolved
back to team/roster/gamelog context automatically. See step 8.6 above to test
it, and `NFL_PROJECTION_MODELS.md`'s data-sources section for how it works.

## 12. What I verified from this end vs. what only you can verify

I confirmed, from this session: the app builds cleanly (`npm run build`),
lints clean (`npx oxlint`) with only pre-existing/intentional unused-export
warnings (the "known simplification" plumbing in section 11 above — ported
but not yet wired to a button, by design), and a headless-browser smoke test
clicking through all five tabs and exercising the new search box produces no
React crashes and degrades to clean error messages (not blank screens) when
network calls fail.

What I could **not** verify from this sandboxed environment: live data from
ESPN/Open-Meteo/Supabase end-to-end, since this environment has no network
path to those hosts. Step 8 above is the real test — that's where you'll
find out if, say, an ESPN response shape has drifted since I verified it live
(August 2026) or your Odds API key needs a scope check. If step 8 turns up a
parsing issue on a specific field, it's almost always isolated to one
function (the defensive-parsing style used throughout means a bad field
degrades to a neutral default rather than crashing the whole app), so it
should be a narrow, fast fix rather than something structural.
