# Integrating the NBA Edge Finder — full step-by-step walkthrough

This zip is your existing MLB/NFL Edge Finder StackBlitz project with the NBA clone
added alongside them. **Nothing in the MLB or NFL apps was touched** except one line
in `Root.tsx` (step 4 below, already applied in this zip). Read
`NBA_PROJECTION_MODELS.md` first if you want the projection methodology — this file
is the "how do I actually get this running" walkthrough, written the same way
`INTEGRATION.md` was for the NFL rollout:

- **GitHub repo:** `vunterhogel/MLB-Edge-Finder-w-Supabase`
- **StackBlitz:** `https://stackblitz.com/github/vunterhogel/MLB-Edge-Finder-w-Supabase`
- **Supabase project:** `jkpctgapbsyzqjfiiuoe` (dashboard: `https://supabase.com/dashboard/project/jkpctgapbsyzqjfiiuoe`)
- **Local folder:** wherever you keep the project locally (same one `WORKFLOW.md` refers to)

Follow the steps in order.

---

## 0. What you're about to add, in plain terms

Right now your project is three React apps (`src/App.tsx` MLB, `src/nfl/NFLApp.tsx`
NFL) behind `src/Root.tsx`'s sport switcher, plus a Supabase backend with
`odds-proxy`, `statcast-proxy`, and `nfl-stats-proxy`. After this integration, the
same project has a **third** app — NBA — added to that switcher, sharing the same
Supabase backend plus one new edge function (`nba-stats-proxy`). No new Supabase
project, GitHub repo, or StackBlitz.

## 1. What's new in this zip

```
supabase/functions/nba-stats-proxy/     NEW edge function (ESPN proxy, mirrors nfl-stats-proxy)
supabase/config.toml                    ADDED a [functions.nba-stats-proxy] block
src/nba/NBAApp.tsx                      NEW — the entire NBA engine + UI (self-contained,
                                         mirrors NFLApp.tsx's structure/patterns exactly)
src/Root.tsx                            CHANGED — sport switcher now has a 3rd (🏀 NBA) tab
NBA_PROJECTION_MODELS.md                NEW — the design doc this code implements
NBA_INTEGRATION.md                      this file
```

`src/App.tsx` (MLB) and `src/nfl/NFLApp.tsx` (NFL) are **byte-for-byte unchanged**.
`supabase/functions/odds-proxy` is **byte-for-byte unchanged** — sport key
`basketball_nba` costs zero new backend code there. `supabase/functions/
statcast-proxy` and `supabase/functions/nfl-stats-proxy` are also untouched; the new
`nba-stats-proxy` sits next to them.

## 2. Merge into your local folder

1. Copy `src/nba/`, the new `supabase/functions/nba-stats-proxy/` folder,
   `NBA_PROJECTION_MODELS.md`, and `NBA_INTEGRATION.md` into your real project,
   same as the NFL rollout did.
2. `src/Root.tsx` in this zip already has the 3-way switcher wired up — copy it over
   your existing one (it's a tiny file; diff it first if you've since customized it).
3. Do **not** copy `node_modules/`, `dist/`, or `supabase/.temp/`.

**Checkpoint:** `ls src/nba supabase/functions` from your project root should show
`NBAApp.tsx` and `nba-stats-proxy` (alongside `odds-proxy`, `statcast-proxy`,
`nfl-stats-proxy`).

## 3. Add the new edge function's config block

Already applied in this zip's `supabase/config.toml` — it now has, after the
`[functions.nfl-stats-proxy]` block:

```toml
[functions.nba-stats-proxy]
enabled = true
verify_jwt = false
import_map = "./functions/nba-stats-proxy/deno.json"
entrypoint = "./functions/nba-stats-proxy/index.ts"
```

If you're hand-merging into your own `config.toml` instead of overwriting it, add
that block yourself and double-check nothing else you'd customized got reverted.

**Checkpoint:** `grep nba-stats-proxy supabase/config.toml` should print the block
above.

## 4. Sport switcher — already wired

Unlike the NFL rollout (which needed a one-line hand-edit to `main.tsx`), NBA slots
into the *existing* `Root.tsx` switcher — `main.tsx` still renders `<Root/>`,
unchanged. `Root.tsx` itself is the one file that changed (see step 2) to add the
🏀 tab.

**Checkpoint:** open `src/Root.tsx` and confirm it imports `NBAApp` from
`./nba/NBAApp` and renders it when `sport === "nba"`.

## 5. Run it locally first

```bash
npm install
npm run dev
```

Open the printed local URL. You should see three tabs at the top: ⚾ MLB, 🏈 NFL,
🏀 NBA.

- Click ⚾ and 🏈 first — both should look and behave exactly as they always have.
  If either is broken, stop here; `App.tsx` and `NFLApp.tsx` are untouched, so
  something went wrong in step 2's merge, not in the new NBA code.
- Click 🏀 NBA Edge Finder. The tab bar (Slate / Board / Player Analysis / My Bets /
  Stats) should render, with a date picker (NBA runs a near-daily schedule, so the
  Slate tab is keyed by calendar date, like MLB — not by week, like NFL). Data won't
  load yet — that needs the edge function deployed (step 6) — but you should see
  clean "loading" or empty states, not a blank white screen or a red error overlay.

**Checkpoint:** no red Vite/React error overlay on any of the three tabs, and the
sport-switcher buttons visibly toggle between all three apps. This was verified
locally in the build environment (`npm run build`, `npx oxlint`, and a headless
browser click-through of all five NBA tabs — see §7 below for exactly what that
did and didn't confirm).

## 6. Deploy the new edge function to Supabase

```bash
cd "<your project folder>"
supabase functions deploy nba-stats-proxy
```

No new secrets required — same posture as `nfl-stats-proxy`. You do **not** need to
redeploy `odds-proxy`, `statcast-proxy`, or `nfl-stats-proxy` — none of them changed.

**Checkpoint:** `supabase functions list` should show `nba-stats-proxy` alongside the
other three, status `ACTIVE`.

## 7. Push to GitHub, then pull into StackBlitz

Same as always (see `WORKFLOW.md`):

```bash
git add .
git commit -m "Add NBA Edge Finder"
git push
```

Then open `https://stackblitz.com/github/vunterhogel/MLB-Edge-Finder-w-Supabase` to
pull the latest commit into StackBlitz.

**Checkpoint:** same visual check as step 5, but inside StackBlitz.

## 8. Test it end-to-end with real data

1. Click 🏀 NBA Edge Finder.
2. On the Slate tab, the date defaults to today — use the ◂/▸ buttons or the date
   picker to jump around. Click **Refresh**. You should see that date's games
   populate. An empty result on an off-day, the All-Star break, or the offseason is
   expected, not a bug — try a different date to confirm the plumbing works.
3. Expand a game (click on it). Rosters, injury statuses, starter/bench rank, and
   each team's rest status (days rest / back-to-back) should populate for both
   teams.
4. Click **"Fetch odds & build board"**. This calls `odds-proxy` for that game's
   player-prop and game-line markets (sport key `basketball_nba`) and prices them
   against the model's projections. You should see priced candidates on the Board
   tab.
5. Go to **Player Analysis** and try the player search: type a name and hit Search
   or Enter. If their team isn't playing on the currently-loaded date, you'll get a
   clear message telling you that — switch dates and search again. You can also
   click a player name directly on the Slate tab after expanding a game.
6. Track a bet from the Board tab, then check it shows up on **My Bets**.

**Checkpoint:** real games, real rosters, a real priced board, and a real player
search result — not just clean empty states. This is the point where the
integration is genuinely done.

## 9. Troubleshooting

- **MLB or NFL breaks after this integration.** It shouldn't — neither file was
  touched. Re-check step 2/4: confirm `Root.tsx` still imports both `MLBApp` and
  `NFLApp` correctly.
- **NBA tab loads but every fetch fails / spins forever.** Almost always means
  `nba-stats-proxy` isn't deployed yet, or the ESPN endpoint shapes this file was
  written against (**not verified live** — see `NBA_PROJECTION_MODELS.md` §8 and
  §1's caveat, since this was built in a sandboxed environment with no network path
  to espn.com) have drifted. Open the browser console (F12) and look at the failing
  request's response — every parser here degrades to a neutral default instead of
  throwing, so a shape mismatch should show up as thin/empty data for one field, not
  a crash; if something crashes instead, that's the bug to report.
- **Odds/board comes back empty but rosters loaded fine.** That's the `odds-proxy`/
  Odds API path. Confirm `ODDS_API_KEY` is set and you haven't hit your monthly
  request cap — same troubleshooting as MLB/NFL, since NBA traffic counts against
  the same cap.
- **Player search returns "No NBA players matched."** Check spelling — ESPN's search
  is name-based, not fuzzy-tolerant of major typos.
- **Something else entirely.** Browser console (F12 → Console) is the first and best
  place to look.

## 10. Backend wiring

`src/nba/NBAApp.tsx` hardcodes the same `SUPABASE_URL`/`SUPABASE_ANON_KEY` already
hardcoded in `App.tsx` and `NFLApp.tsx` — one Supabase project, one anon key, three
sports.

## 11. Known v1 simplifications

See `NBA_PROJECTION_MODELS.md` §7 for the full, code-commented list (opponent-allowed
splits beyond points, no live/in-game layer, CLV tracking ported-but-unwired,
depth-chart-driven minutes prior, uniform-prior `CALIB_KEEP`, no travel/time-zone
signal, and a handful of Odds API markets not yet wired). Same posture as
`INTEGRATION.md` §11 took for the NFL rollout: deliberate Day-1 scope cuts, not bugs,
each commented at its use site in the code.

## 12. What I verified from this end vs. what only you can verify

Verified from this session: the app builds cleanly (`npm run build`), lints clean
(`npx oxlint`) with only the same class of pre-existing/intentional unused-export
warnings the MLB and NFL files already carry (ported-but-not-yet-wired plumbing,
same as NFL's §12 note), and a headless-browser smoke test clicking through all five
NBA tabs plus the sport switcher produces no React crashes and degrades to clean
error messages (not blank screens) when network calls fail — which they do in this
sandboxed build environment, since it has no network path to espn.com or
the-odds-api.com.

What I could **not** verify: live data from ESPN/The Odds API end-to-end, for the
same reason. This is a materially bigger unknown here than it was for the NFL
rollout, which verified its ESPN endpoint shapes live before shipping — the NBA
endpoints in this file follow the identical, well-documented ESPN URL convention
(`site.api.espn.com/apis/site/v2/sports/basketball/nba/...` etc.) with every parser
written defensively (degrade to a neutral default, never throw), but step 8 above is
where you'll actually find out whether anything has drifted. If it turns up a
parsing issue on a specific field, the defensive-parsing style used throughout means
it should be a narrow, isolated fix — but budget more real-data debugging time for
this rollout than the NFL one got.
