# NFL Edge Finder — Projection Methodology

This is the design spec for the NFL clone of MLB Edge Finder. It mirrors the MLB
engine's philosophy exactly: build a per-player/per-team base rate from real data,
walk it through a chain of contextual multipliers (matchup, weather, game script,
injuries, pace), convert the resulting mean into a probability distribution, price
it against the sportsbook's no-vig market, and blend model-vs-market by category
(`CALIB_KEEP`) because the model is unproven until the Stats tab has a settled
sample to calibrate against. Every constant below is a **starting prior**, tagged
for retuning — the same posture the MLB file takes ("reasonable but uncalibrated
until real data comes in").

## 1. Data sources (all browser/edge-function reachable, no paid API required)

| Source | Use | Access pattern |
|---|---|---|
| `site.api.espn.com` / `sports.core.api.espn.com` (ESPN hidden API) | schedule, scores, rosters, athlete gamelogs/splits, injuries, depth charts, team stats/standings | direct `fetch()` from the browser — ESPN's site API is public and CORS-open, same posture as `statsapi.mlb.com` in the MLB app |
| `api.the-odds-api.com` v4 | live player-prop + game-line odds | through the **existing `odds-proxy` edge function, unmodified** — it's already sport-agnostic (takes `path`/`query`, just change the sport key to `americanfootball_nfl`) |
| `api.open-meteo.com` | game-time weather at outdoor stadiums | direct `fetch()`, same call shape as MLB |
| `nflverse-data` GitHub releases (Next Gen Stats CSVs: `ngs_{year}_{passing,rushing,receiving}.csv.gz`) | optional advanced-metrics enhancer (air yards, aDOT, separation, time-to-throw, YAC over expected) — the NFL equivalent of the Statcast layer | through a new **`nfl-stats-proxy`** edge function (generic `?url=` passthrough + gzip inflate, mirrors `statcast-proxy`) |

Nothing here needs a paid key except The Odds API, which the project already pays
for and already proxies generically.

### ESPN endpoints actually used

```
Scoreboard/schedule : site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week={w}&seasontype={st}&year={yr}
Team list           : site.api.espn.com/apis/site/v2/sports/football/nfl/teams
Roster               : site.api.espn.com/apis/site/v2/sports/football/nfl/teams/{teamId}/roster
Athlete gamelog       : site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/{athleteId}/gamelog
Athlete splits        : site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/{athleteId}/splits
Team injuries         : sports.core.api.espn.com/v2/sports/football/leagues/nfl/teams/{teamId}/injuries
Depth chart           : sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/{yr}/teams/{teamId}/depthcharts
Standings (PF/PA)     : site.api.espn.com/apis/v2/sports/football/nfl/standings?season={yr}
Boxscore (settling)   : site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event={eventId}
Player search          : site.api.espn.com/apis/search/v2?query={name}&limit=20&type=player
```

Player search powers the Player Analysis tab's free-text lookup (any NFL player,
not just this week's featured slate players). It's ESPN's cross-sport search —
results are filtered client-side to `defaultLeagueSlug === "nfl"` to drop
name collisions from other sports/leagues (NCAAF, soccer, etc.), and each
hit's `subtitle` (the player's current team full name, e.g. "Kansas City
Chiefs") is resolved back to our internal ESPN team id by a nickname match
against `TEAMS`. Verified live August 2026.

NFL doesn't run daily like MLB — it runs by **week**. The Slate tab is keyed by
`(seasonType, week)` instead of a calendar date: `seasonType` 1 = preseason, 2 =
regular season, 3 = postseason. A small date→week resolver defaults to "the
current week" the way MLB defaults to "today."

### The Odds API — sport key & markets

Sport keys: `americanfootball_nfl` (regular/postseason) and
`americanfootball_nfl_preseason` (Aug). Game lines: `h2h`, `spreads`, `totals`
(identical to MLB — reuse `GAME_MARKETS` unchanged). Player props (confirmed
market key strings):

```
Passing:   player_pass_yds, player_pass_tds, player_pass_interceptions,
           player_pass_completions, player_pass_attempts, player_pass_longest_completion
Rushing:   player_rush_yds, player_rush_tds, player_rush_longest
Receiving: player_receptions, player_reception_yds, player_reception_tds, player_reception_longest
Touchdown: player_anytime_td, player_first_td, player_last_td
Kicking:   player_kicking_points, player_field_goals
Defense:   player_sacks, player_tackles_assists, player_defensive_interceptions
```

## 2. Team scoring model (game lines: Moneyline / Spread / Total)

MLB modeled each team's runs as an overdispersed count (Negative Binomial,
`RUNS_PHI=2.0`) and cross-tabbed home×away over a run grid to get win/total/RL
probabilities. NFL scoring is lumpier (TD=6/7/8, FG=3, safety=2) but the same
two-team-NB-grid approach works and stays explainable:

```
teamLambda = LG_PPG * offRating * oppDefRating * homeFieldMult * paceMult
offRating  = team points-for/game ÷ league-avg PPG (last-8-game weighted blend, like MLB's L15)
oppDefRating = opponent points-against/game ÷ league-avg PPG
homeFieldMult = 1.015 (home), 0.985 (away) — small, well-documented NFL home edge (~1-1.5 pts)
paceMult   = team plays/game ÷ league-avg plays/game (fast/slow-pace teams shift both teams' totals)
```

`LG_PPG ≈ 22.0` (prior — retune from settled Stats data). Points/game variance
runs well above Poisson (`phi = var/mean`, prior `NFL_PTS_PHI = 6.5`, i.e. team
points variance ≈ 6.5× the mean — retune once games settle). Grid the same way
`gameProbs`/`jointGameProbs` do in MLB (0..70 in steps of 1, since football
scores are integers), producing:

- **Moneyline**: `P(home points > away points)` (+ push handling for ties, which
  exist in the NFL — unlike MLB).
- **Spread**: `P(home margin > -spread)` via the margin-of-two-NB-variables grid
  (`marginProb` ports directly).
- **Total**: `P(final total > line)` off the same joint grid (`jointGameProbs`
  ports directly, generalized for the live/in-game case using elapsed-game
  fraction instead of innings-remaining).

Injuries feed in as an explicit multiplier on `offRating`/`oppDefRating`: a
starting QB out is the single biggest single-player value swing in football —
see §6.

## 3. Player projection models by position

Every position follows the MLB pattern: **season rate, shrunk toward a league
prior for thin samples** (`shrinkRate`/`shrinkValue`, reused verbatim) **blended
with a recent-form window** (last 4 games instead of MLB's L15 — an NFL season is
17 games, not 162, so the recency window has to be much shorter), then multiplied
by matchup/weather/game-script/injury adjustments, then converted to a
distribution and priced.

### Quarterback (QB)

| Prop | Base rate | Mean formula | Distribution |
|---|---|---|---|
| Pass Attempts | attempts/game | `season attempts/g` blended with L4, × `gameScriptMult` (trailing teams pass more, leading teams run more — derived from Vegas spread: team expected to trail throws more) | Negative Binomial, `phi≈1.3` |
| Pass Completions | attempts × comp% | `attempts × compPct`, compPct adjusted by opponent pass defense comp% allowed | NB, `phi≈1.2` |
| Pass Yards | attempts × Y/A | `compAtt × yardsPerCompletion` (more stable than attempts×Y/A directly — mirrors MLB's per-AB decomposition for hits/TB) adjusted by opponent pass-yards-allowed/game vs league avg, weather (wind ≥15mph knocks down deep passing, heavy rain/snow knocks down all passing — same shape as MLB's `calculateWeatherAdjustment` but keyed off wind speed + precip type, no "hot ball travels further" HR-style term) | NB, `phi≈2.2` (game-to-game QB yardage is far more volatile than a single rate stat) |
| Pass TDs | TD rate per attempt | `attempts × (szn TD/att blended w/ L4) × oppPassTDAllowedMult × redZoneMult` | Poisson/NB, `phi≈1.4` |
| INTs | INT rate per attempt | `attempts × (szn INT/att) × oppDefTakeawayMult × pressureMult` (pressure proxy = opponent sack rate, since pressure forces bad throws) | Poisson |
| Longest completion | correlated with pass yards & opposing secondary big-play rate allowed | empirical percentile off the yards distribution (same trick MLB uses to back into hit-type fractions from TB) | derived, not simulated independently |
| Rush Yards/Rush TDs (mobile QBs) | same RB formula, gated to QBs with meaningful career rush share | see RB | NB |

`gameScriptMult` is the one genuinely new concept vs. MLB (baseball has no
game-script analog): pull the Vegas spread for the QB's team, convert it to
implied point differential, and scale pass-attempt share up/down from a league
baseline (e.g. team favored by 7+ → pass-attempt mult ≈0.93; team underdog by 7+
→ ≈1.07). This directly extends the "de-vig, don't just take the raw market"
philosophy MLB already applies to the odds side — here it's applied to play-calling.

### Running Back (RB)

| Prop | Mean formula | Distribution |
|---|---|---|
| Rush Attempts | season carries/g blended w/ L4, × `touchShareMult` from current depth chart (a committee backfield caps any one RB's ceiling — pull depth chart, not just season average, exactly the way MLB pulls the *posted* lineup instead of trusting a static roster) × inverse game-script (leading teams run more) | NB, `phi≈1.3` |
| Rush Yards | `attempts × YPC`, YPC adjusted by opponent run-defense yards/carry allowed vs league avg, O-line-strength proxy (team YPC over league avg, same shape as MLB's team-run-environment factor) | NB, `phi≈2.0` |
| Rush TDs | `attempts × goal-line-share × oppRunTDAllowedMult` — goal-line/red-zone carry share is pulled from recent game logs (red-zone touches ÷ red-zone team plays), the single highest-leverage RB input | NB |
| Receptions / Rec. Yards | target share × team pass attempts (RB receiving work rides the *team's* passing volume, so it inherits `gameScriptMult` from the QB side) | NB |

### Wide Receiver / Tight End (WR/TE)

| Prop | Mean formula | Distribution |
|---|---|---|
| Receptions | `targets × catchRate`, targets = season target-share × team pass attempts (this ties every WR/TE prop to the SAME team pass-volume number the QB props use — one consistent pace/game-script read across the whole game, exactly mirroring how MLB's hitter and pitcher props both key off the same `lambdaH`/`lambdaA` team run environment) | NB, `phi≈1.6` |
| Receiving Yards | `targets × yardsPerTarget` (yardsPerTarget baked from aDOT × catchRate × YAC — when the optional NGS layer is present, aDOT/YAC-over-expected refine this the same optional-enhancer way Statcast's xwOBA/barrel% refine MLB's hit/TB/HR rates) adjusted by opponent pass-yards-allowed-to-position vs league avg | NB, `phi≈2.4` |
| Receiving TDs | `targets × redZoneTargetShare × oppPassTDAllowedMult` | NB |
| Longest reception | derived from the yards distribution's upper tail, same as QB's longest completion | derived |

### Kicker (K)

| Prop | Mean formula |
|---|---|
| Kicking Points | `impliedTeamPoints × (1 − redZoneTDRate) × fgPointsPerDrive` — i.e., a kicker's ceiling is capped by how often his OWN offense scores TDs instead of settling for FGs, so this is the one prop that's a *negative* function of the team's red-zone efficiency, not a positive one. Weather (wind, cold) and stadium (dome vs. outdoor) cut into long-FG make% the way MLB's weather layer cuts into HR distance. |
| Field Goals Made | `driveCount × fgAttemptRate × makePct(distance-adjusted)` |

### Defense/Special Teams (DST) — team-level prop, not a single player

| Prop | Mean formula |
|---|---|
| Sacks | `oppSackRateAllowed × oppPassAttempts` |
| Def. Interceptions | `oppINTThrowRate × oppPassAttempts` |
| Points Allowed / Fantasy DST score | direct function of the opponent's `teamLambda` from §2 — DST is the mirror image of the opponent's offense, so it should NEVER be projected independently of the game-line model (a common mistake in cheap DFS tools) |

## 4. Adjustment layers (the multiplier chain — mirrors MLB's calculate* functions)

Each ported 1:1 in spirit from an MLB function, NFL-flavored:

- `calculateOppDefenseAdjustment` (↔ MLB `calculateOppPitchingAdjustment`): opponent's position-specific yards/TDs-allowed vs league average, innings-weighted... here, **snap-share weighted** — if the primary defender for that WR's role (e.g. the CB likely covering him, from ESPN's depth chart) is out hurt, blend toward the backup's/team's aggregate allowed rate instead of just the starter's, exactly the way MLB falls back from starter-FIP to team-RA/G when the starter sample is thin.
- `calculateWeatherAdjustment`: wind (passing yards/deep TDs down, FG range down), temperature (cold suppresses passing efficiency mildly, has ~no effect on rushing), precipitation (turnover rate up, passing down, rushing share up) — dome/retractable-roof stadiums get `dome:true` and skip this layer entirely, same boolean MLB uses per park.
- `calculateGameScriptAdjustment`: NEW vs MLB — derived from the Vegas spread for that team, shifts pass/rush attempt shares. This is the single most important NFL-specific addition, because unlike MLB's fairly fixed 4 AB/PA-per-game structure, NFL play-calling volume is highly game-state-dependent.
- `calculateInjuryAdjustment`: NEW vs MLB (MLB only has same-day scratches via posted lineups; NFL has a graded weekly injury report — Questionable/Doubtful/Out). Pulled from the ESPN injuries endpoint: `Out`/injured-reserve → player excluded from the slate entirely (same treatment as an MLB scratch); `Doubtful` → heavy shrink toward backup usage; `Questionable` → light shrink. A starting-QB injury additionally re-runs the team's `offRating` in §2, because it changes the whole game environment, not just one prop.
- `calculateRestTravelAdjustment`: small, well-documented mult for short weeks (Thursday night off a Sunday game) and cross-country travel — MLB has no analog (every game is daily-cadence), this is purely additive for NFL.
- `calculateRecentFormAdjustment`: L4-game blend, same shrinkage math as MLB's L15 (`blendRate`, `MIN_L15_AB`-style gate — rename to `MIN_L4_SNAPS`), just a shorter window because the season is shorter.

## 5. Calibration & pricing (reused verbatim from MLB — sport-agnostic)

`impliedProb`, `probToAmerican`, `evPerUnit`, `noVigProb`, `calibrateToMarket`,
`suggestedUnits` (quarter-Kelly stake sizing), the Negative-Binomial/Poisson/Gamma
Monte-Carlo primitives, and the whole "board log every candidate, settle it
later, retune `CALIB_KEEP` per category from real win-rate data" workflow port
over **unchanged**. `CALIB_KEEP` starts at a conservative uniform 0.4-0.5 for
every NFL category (vs. MLB's per-category-tuned values, which took months of
settled bets to arrive at) — this is explicitly a Day-1 prior, and the Stats tab
is what lets it get tuned the same way MLB's did.

## 6. What's genuinely new vs. the MLB engine (don't try to reuse these)

1. **Game script** (§4) — no baseball analog.
2. **Graded weekly injury report** driving both player AND team-level projections.
3. **Weekly cadence** (Slate keyed by week, not date) and **bye weeks** (a team
   simply has no game that week — the slate for that team is empty, not an error).
4. **Depth-chart-driven touch share** for RB/WR (MLB has a *lineup*, which is a
   strict batting order; NFL has a depth chart, which is a soft usage prior that
   the recent-snap-share data should override when it disagrees — the season is
   too short to wait out a stale depth chart).
5. **Ties** in the game-line model (rare, but the grid math has to allow
   `home == away` as a genuine outcome, not just a rounding push).
