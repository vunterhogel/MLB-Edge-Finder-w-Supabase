/* The four sports as the hub sees them: the same adapters the sport pages use (so the same shared bet
   store per sport), plus the row settings each sport page passes to its bet rows. */
import MLB from "../sports/mlb/adapter";
import NFL from "../sports/nfl/adapter";
import NBA from "../sports/nba/adapter";
import NHL from "../sports/nhl/adapter";
import { makeDeltaSignal } from "../core/signals";

export const HUB_SPORTS = [MLB, NFL, NBA, NHL].map((sport) => ({
  id: sport.id,
  label: sport.meta.title,
  icon: sport.meta.emoji,
  sport,
  rowCfg: { isLineType: sport.config.isLineType, isYesNoType: sport.config.isYesNoType || null, getDeltaSignal: makeDeltaSignal(sport.config.SIGNAL_RULES) },
}));
export const HUB_SPORT = Object.fromEntries(HUB_SPORTS.map((s) => [s.id, s]));
export const SPORT_FILTER_OPTS = ["all", ...HUB_SPORTS.map((s) => s.id)];
export const SPORT_FILTER_LABELS = { all: "All sports", ...Object.fromEntries(HUB_SPORTS.map((s) => [s.id, `${s.icon} ${s.label}`])) };
