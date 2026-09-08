# NBA Edge Finder — Projection Methodology

This is the design spec for the NBA clone of MLB/NFL Edge Finder. It mirrors both
engines' philosophy exactly: build a per-player/per-team base rate from real data,
walk it through a chain of contextual multipliers (matchup, pace, rest, injuries,
usage), convert the resulting mean into a probability distribution, price it against
the sportsbook's no-vig market, and blend model-vs-market by category (`CALIB_KEEP`)
because the model is unproven until the Stats tab has a settled sample to calibrate
against. Every constant below is a **starting prior**, tagged for retuning — same
posture as the other two sports' docs ("reasonable but uncalibrated until real data
comes in").

## 1. Data sources (all browser/edge-function reachable, no paid API required)

| Source | Use | Access pattern |
|---|---|---|
| `site.api.espn.com` / `site.web.api.espn.com` / `sports.core.api.espn.com` (ESPN hidden API, `basketball/nba`) | schedule/scoreboard, rosters, athlete gamelogs, injuries, depth charts (starter/bench rank), team stats (pace/ORTG/DRTG), standings | direct `fetch()` from the browser — same CORS-open posture verified for `.../football/nfl` in `NFLApp.tsx`; the URL shape is identical with `basketball/nba` swapped in, but I could not hit these NBA-specific paths live from this sandboxed environment (no network egress to espn.com here) the way the NFL integration verified its endpoints live in August 2026. Treat every ESPN parser below as **unverified-live, shape-tolerant** until you run it — same defensive posture (`pickCat`/alias tables that degrade to `null`/a league prior instead of throwing) is used throughout for exactly this reason. |
| `api.the-odds-api.com` v4 | live player-prop + game-line odds | through the **existing `odds-proxy` edge function, unmodified** — sport key `basketball_nba` |
| `nba-stats-proxy` (new edge function, mirrors `nfl-stats-proxy`) | generic `?url=` passthrough for the ESPN hosts above, so the browser never has to fight CORS/rate-limits directly | new, no secrets required |

Nothing here needs a paid key except The Odds API, which the project already pays for
and already proxies generically.

### ESPN endpoints used (by analogy with the verified NFL shape — see §1 caveat above)

```
Scoreboard/schedule (by date) : site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={YYYYMMDD}
Team schedule (for rest/B2B)  : site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{teamId}/schedule
Team list                     : site.api.espn.com/apis/site/v2/sports/basketball/nba/teams
Roster                        : site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{teamId}/roster
Athlete gamelog                : site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/{athleteId}/gamelog
Team injuries                  : sports.core.api.espn.com/v2/sports/basketball/leagues/nba/teams/{teamId}/injuries
Depth chart (starter/bench rank): sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/{yr}/teams/{teamId}/depthcharts
Standings (net rtg, pace proxy) : site.api.espn.com/apis/v2/sports/basketball/nba/standings?season={yr}
Team statistics (pace/ORTG/DRTG): site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{teamId}/statistics
Boxscore (settling)             : site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={eventId}
Player search                   : site.api.espn.com/apis/search/v2?query={name}&limit=20&type=player
```

Player search powers the Player Analysis tab's free-text lookup, filtered client-side
to `defaultLeagueSlug === "nba"` (same pattern as the NFL app's `"nfl"` filter), each
hit's `subtitle` resolved back to our internal ESPN team id by a nickname match
against `TEAMS`.

NBA runs a **near-daily** schedule (not weekly like NFL) — the Slate tab is keyed by
**calendar date**, the same cadence MLB uses, not by week. A small date resolver
defaults to "today" (or the next date with games, if today has none).

### The Odds API — sport key & markets

Sport key: `basketball_nba`. Game lines: `h2h`, `spreads`, `totals` (reuse
`GAME_MARKETS` unchanged, same as MLB/NFL). Player props (confirmed market key
strings, from The Odds API's published betting-markets reference):

```
player_points, player_rebounds, player_assists, player_threes, player_blocks,
player_steals, player_turnovers, player_blocks_steals,
player_points_rebounds_assists, player_points_rebounds, player_points_assists,
player_rebounds_assists, player_double_double, player_triple_double
```

v1 scope note: `player_field_goals`, `player_frees_made`, `player_frees_attempts`,
`player_first_basket`, `player_first_team_basket`, `player_method_of_first_basket`,
`player_fantasy_points`, and all `_q1` quarter markets are **not** wired up in v1 —
easy to add later the same way every other prop is (see §6 "known v1
simplifications").

## 2. Team scoring model (game lines: Moneyline / Spread / Total)

NBA scoring is high-volume and possession-driven, unlike NFL's lumpy TD/FG scoring —
closer in spirit to MLB's run-environment model, just with a much higher mean and
much lower *relative* variance (a 220-point combined final is far more predictable,
proportionally, than a 9-run baseball game or a 44-point football total). Same
two-team-Negative-Binomial-grid approach as the other two sports, tuned for hoops:

```
teamLambda = LG_PPG * offRating * oppDefAllowedRating * paceMult * homeCourtMult
offRating  = team points-for/game ÷ league-avg PPG (season blended with L10, like MLB's L15 / NFL's L4)
oppDefAllowedRating = opponent points-against/game ÷ league-avg PPG
paceMult   = avg(team pace, opponent pace) ÷ league-avg pace — pace is shared by
             both teams in one game (a fast-pace matchup inflates BOTH teams' totals,
             not just one), so it's applied once to the pair, not per-team like
             NFL's plays/game multiplier
homeCourtMult = 1.015 (home), 0.985 (away) — same magnitude as NFL's HOME_FIELD_MULT;
             NBA home-court edge (~2.5-3 pts on a ~225-pt combined total) is
             proportionally similar to NFL's ~1-1.5 pts on ~44
```

`LG_PPG ≈ 114.0`, `LG_PACE ≈ 99.5` (possessions/48 min — both priors, retune from
settled Stats data as the season plays out). Team point totals are overdispersed
but far less so than NFL's lumpy scoring: `NBA_PTS_PHI = 1.3` (prior — team points
variance ≈ 1.3× the mean, vs NFL's 6.5). Grid runs 0..179 in steps of 1 (NBA teams
routinely score 90-140), producing Moneyline / Spread / Total exactly the way
`gameProbs`/`jointGameProbs`/`marginProb` do for MLB/NFL. Real ties don't exist
(overtime resolves every game) but the grid keeps a `tie` bucket at ~0 probability
rather than special-casing it out, for structural parity with the other sports'
math.

Injuries feed in as an explicit multiplier on `offRating`/`oppDefAllowedRating`: a
missing top-usage scorer is NBA's single biggest same-game value swing (comparable
to an NFL starting-QB injury) — see §4.

## 3. Player projection model (unified across positions)

Unlike NFL, which needs distinct QB/RB/WR/K/DST projector functions because those
positions touch the ball in structurally different ways, NBA player stats (points,
rebounds, assists, threes, blocks, steals, turnovers) are all **counting stats that
scale off the same two numbers: minutes played and per-36-minute rate** — so there is
ONE `projectPlayer` engine, with position (PG/SG/SF/PF/C) only shifting the
league-prior rate used to shrink thin samples (a center's prior rebound rate is much
higher than a point guard's, etc.), the same role MLB's park factors or NFL's
position-specific target-share priors play elsewhere.

### Step 1 — minutes projection (the base every prop scales from)

```
minutes = shrinkValue(
            blendRate(seasonMPG, recentMPG(L10), RECENT_WEIGHT),
            gamesPlayed, POSITION_MPG_PRIOR, SHRINK_N.minutes
          ) × availability(injuryStatus) × restMult(b2b/restDays) × blowoutRiskMult(|spread|)
```

`blowoutRiskMult` is the NBA-specific new concept (see §6): when the model's own
game line projects a large spread, the favored team's starters historically see
reduced 4th-quarter run as blowouts develop — this doesn't exist in NFL (starters sit
for injury/veteran-rest reasons, not blowout garbage time, which is a distinct NBA
in-game coaching pattern) or MLB (no concept of "garbage time" innings).

### Step 2 — per-36 rate, shrunk toward a position-based league prior

```
ratePer36[stat] = shrinkRate(observedPer36, minutesPlayed, POS_PRIOR[pos][stat], SHRINK_N.rate)
```

`POS_PRIOR` is a small position→stat table (PG/SG/SF/PF/C × pts/reb/ast/stl/blk/tov/3pm
per 36) built from well-known modern-NBA positional benchmarks — exists ONLY to
stabilize thin samples (a rookie's first 5 games, a two-way call-up), the same role
MLB's `LG_PRIOR` and NFL's `LG` play. Once a player has real minutes, his own rate
dominates via `shrinkRate`'s sample-size weighting.

### Step 3 — the multiplier chain, then convert to mean

```
mean[stat] = (minutes / 36) × ratePer36[stat] × paceMult × oppAllowedMult[stat] × usageMult[stat]
```

| Prop | `oppAllowedMult` source | `usageMult` notes |
|---|---|---|
| Points | opponent DRTG (points allowed/100 poss) ÷ league-avg DRTG | boosted when a teammate with meaningful usage/points share is OUT — see §4 |
| Rebounds | opponent rebound rate allowed ÷ league avg (v1: neutral 1.0 until wired — see §6) | boosted when a top rebounder teammate is OUT |
| Assists | opponent assists-allowed ÷ league avg (v1: neutral — see §6) | tied to team pace/ball-movement, not a separate usage boost |
| Threes made | opponent 3PT defense (3P% allowed) ÷ league avg (v1: neutral — see §6) | rides the player's own attempt-rate shrinkage |
| Blocks / Steals | opponent turnover rate / shot profile (v1: neutral — see §6) | — |
| Turnovers | — | scales with usage boost the same direction as points (more touches, more cough-ups) |

Every `mean[stat]` becomes a `probabilityOver(family, line, side, seed, {mean, phi})`
call exactly like MLB/NFL — Negative Binomial, per-category dispersion prior in
`NB_PHI` (points `φ≈1.8`, rebounds `φ≈1.5`, assists `φ≈1.6`, threes `φ≈1.7`,
steals/blocks `φ≈1.6`, turnovers `φ≈1.4` — all Day-1 priors, retune from the Stats
tab).

### Step 4 — combo props (Pts+Reb+Ast, Pts+Reb, Pts+Ast, Reb+Ast, Blocks+Steals)

A combo prop's mean is the sum of its component means, but its variance is NOT the
sum of the components' independent variances — all of a player's counting stats
share the same underlying minutes/usage swings (foul trouble, a blowout, a hot
shooting night extending or shortening his night), so they're positively correlated.
Summing independent NB draws would understate the real combo variance and misprice
the tails. `projectCombo` sums the means directly and applies an **inflated φ**
(`NB_PHI.combo`, prior `2.6` — higher than any single component) to approximate that
correlation without a full joint simulation, the same explainable-shortcut spirit as
MLB's derived-longest-hit / NFL's derived-longest-completion tricks.

### Step 5 — Double-Double / Triple-Double

These need genuine joint simulation, not a shortcut, because they're a *count of
categories clearing a threshold*, not a sum. `projectDoubleDouble` runs its own
Monte Carlo loop (reusing the same `sampleGamma`/`samplePoisson`/`mulberry32`
primitives every other Monte Carlo path uses): each simulated game draws ONE shared
minutes-multiplier (captures the "big-night/foul-trouble" correlation across all
categories at once), then draws points/rebounds/assists/steals/blocks conditional on
that game's scaled means; a "double-double" is ≥2 of {points, rebounds, assists}
≥10, "triple-double" is ≥3. This is the NBA equivalent of NFL's Anytime-TD union
calculation — same idea (turn several correlated single-stat models into one
compound probability) but needs simulation instead of a closed-form union because
more than two correlated events are involved and the categories aren't
mutually exclusive the way rush-TD/rec-TD are for one player.

## 4. Adjustment layers (the multiplier chain — mirrors MLB/NFL's calculate* functions)

- `calculatePaceAdjustment` (NEW framing vs NFL, though conceptually close to NFL's
  play-count pace multiplier): `avg(teamPace, oppPace) / LG_PACE`. Applied once per
  game to every counting stat for both teams — a fast-pace matchup (more
  possessions) inflates points/rebounds/assists for everyone on the floor, the
  single most important NBA-specific multiplier alongside minutes.
- `calculateOppDefenseAdjustment` (↔ MLB `calculateOppPitchingAdjustment` / NFL
  `calculateOppDefenseAdjustment`): opponent DRTG vs league average for points;
  position-specific allowed splits (rebounds/assists/3PT/blocks/steals allowed) are
  **neutral (1.0×) in v1** — see §6, same honest scope-cut NFL made for its
  opponent-allowed-by-position splits.
- `calculateInjuryAvailability`: NBA's official injury report uses
  Out/Doubtful/Questionable/Probable (plus "Day-To-Day", treated as Questionable) —
  `Out` → excluded from the slate entirely (0 minutes), `Doubtful` → heavy shrink,
  `Questionable`/`Day-To-Day` → light shrink, `Probable` → almost no shrink. Same
  shape as NFL's graded weekly report, just NBA's report refreshes daily instead of
  weekly.
- `calculateUsageBoost`: NEW framing vs NFL's `injuredTeammateBoost` (which only
  applied to WR2/3 target share) — in NBA this applies broadly: when a teammate with
  meaningful minutes/usage is ruled out, every remaining rotation player's usage
  ticks up a little, concentrated most heavily on the next-highest-usage player left
  on the floor. `usageMult = clamp(1 + missingUsageShare × 0.6, 1, 1.35)`.
- `calculateRestAdjustment`: **back-to-back is the single biggest NBA-specific rest
  signal** (no analog this strong in NFL, which plays once a week, or MLB, which has
  no true "second game with zero rest" case) — a team playing zero days after its
  previous game sees a well-documented dip in minutes/efficiency for its top players
  (load management, fatigue). `restMult`: b2b → −6%, 1 day rest → neutral, 2+ days →
  +2%. Computed from each team's real schedule (`fetchTeamSchedule`), not guessed.
- `calculateBlowoutRiskAdjustment` (§3 step 1, NEW vs both other sports): a team
  favored/underdog by a wide model-projected margin sees its starters' 4th-quarter
  minutes cut as the game gets out of hand. `blowoutRiskMult`: neutral until
  `|projSpread| ≥ 10`, then scales down to about −8% minutes at `|projSpread| ≥ 20`.

## 5. Calibration & pricing (reused verbatim from MLB/NFL — sport-agnostic)

`impliedProb`, `probToAmerican`, `evPerUnit`, `noVigProb`, `calibrateToMarket`,
`suggestedUnits` (quarter-Kelly stake sizing), the Negative-Binomial/Poisson/Gamma
Monte-Carlo primitives, and the whole "board log every candidate, settle it later,
retune `CALIB_KEEP` per category from real win-rate data" workflow port over
**unchanged**. `CALIB_KEEP` starts at a conservative uniform 0.40-0.50 for every NBA
category — Day-1 prior, same posture NFL took (MLB's per-category-tuned values took
months of settled bets to earn). Retune from the Stats tab once real graded volume
exists — do not hand-tune from vibes.

## 6. What's genuinely new vs. the MLB/NFL engines (don't try to reuse these)

1. **Pace as a shared, per-game multiplier** applied to both teams' counting stats
   at once (§3 step 3, §4) — no analog in NFL (play volume is more fixed) or MLB (no
   possession concept).
2. **Blowout-risk minutes reduction** (§3 step 1, §4) — a real NBA coaching pattern
   (garbage time) with no MLB/NFL equivalent.
3. **Back-to-back / rest-days as the dominant fatigue signal** (§4) — much stronger
   and much more common than NFL's short-week effect, and MLB has no equivalent at
   all (no true zero-rest scheduling quirk of comparable magnitude).
4. **A single unified per-player projector** instead of position-specific functions
   (§3) — NBA stat categories don't split by role the way NFL's passing/rushing/
   receiving or MLB's hitting/pitching do.
5. **Joint double-double/triple-double simulation** (§3 step 5) — a genuinely
   different technique (correlated multi-category Monte Carlo) vs. NFL's closed-form
   Anytime-TD union, needed because 3+ non-exclusive categories are involved.
6. **Daily cadence, not weekly** — Slate is keyed by calendar date like MLB, not by
   week like NFL, but NBA adds back-to-backs (§4) which MLB's daily cadence never
   produces (MLB teams get built-in rest via off-days/rotations in a way NBA
   schedules don't guarantee).

## 7. Known v1 simplifications (clearly marked in code, easy to extend)

Same posture as `INTEGRATION.md` §11 for the NFL app — deliberate scope cuts to ship
a working v1 fast, not bugs, each commented at its use site in `NBAApp.tsx`:

1. **Opponent-allowed-by-position/category splits are neutral (1.0×)** for
   rebounds/assists/threes/blocks/steals — only points uses a real opponent DRTG
   signal in v1. The plumbing (`ctx.oppReboundRateAllowed`, `ctx.oppAstAllowed`,
   `ctx.opp3ptPctAllowed`, etc.) is wired into every projection call and ready to
   receive real data once a verified per-category-allowed source is confirmed live.
2. **No live/in-game layer** (MLB's `fractionRemaining`/live-odds-reprice
   machinery) — pregame is where the model spends its effort, exactly like NFL's v1
   scope cut for the same reason (basketball's pace of state change makes live
   pricing valuable but pregame edge-finding is the higher-value place to start).
3. **`matchCurrentOdds`/line-refresh (CLV tracking) is ported but not wired into a
   UI button** — same as NFL's v1 note; the parsing functions it depends on already
   exist and are used elsewhere.
4. **Starter/bench minutes prior is depth-chart-rank-driven**, not learned from
   real rotation data beyond season/L10 MPG — a starting posture like everything
   else here, retune once the Stats tab has settled bets.
5. **`CALIB_KEEP` starts uniform ~0.40-0.50** for every category (§5) instead of
   MLB's category-tuned values, for the same "no settled-bet history yet" reason
   NFL's did.
6. **Back-to-back detection uses each team's own real schedule**
   (`fetchTeamSchedule`), which is a real signal, but travel distance/time-zone
   changes (the NBA equivalent of NFL's cross-country-travel flag) are **not**
   wired in v1 — the plumbing (`ctx.crossCountryTravel`) exists and defaults neutral.
7. **`player_field_goals`/`player_frees_made`/`player_frees_attempts`/
   `player_first_basket`/quarter markets are not wired** (§1) — same "ship the core
   props first" scope cut NFL made for CLV tracking.

## 8. What I could not verify from this environment

Exactly the caveat `INTEGRATION.md` gives for the NFL build: this was built in a
sandboxed environment with no network path to espn.com/the-odds-api.com, so none of
the ESPN NBA endpoint shapes above were confirmed live the way the NFL endpoints
were (verified August 2026). They follow the identical, well-documented URL
convention ESPN uses across every sport it serves (`site.api.espn.com/apis/site/v2/
sports/{sport}/{league}/...`, `sports.core.api.espn.com/v2/sports/{sport}/leagues/
{league}/...`) with `basketball/nba` substituted for `football/nfl`, and every
parser degrades to a neutral default instead of throwing if a field has moved — but
step 8 of `NBA_INTEGRATION.md` (real end-to-end testing) is where you'll find out if
anything has actually drifted, exactly like it was for the NFL rollout.
