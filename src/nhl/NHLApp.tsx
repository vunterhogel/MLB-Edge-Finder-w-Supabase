import TrackedSportApp, { type SportConfig } from "../shared/TrackedSportApp";

/* NHL is the first sport built entirely on the shared tracking page. Its model, odds pulls and
   grading live server-side in the nhl-collector edge function; this file is just configuration.
   MLB / NFL / NBA move onto the same page by supplying their own config + collector. */
const NHL_CONFIG: SportConfig = {
  sport: "nhl",
  title: "NHL",
  emoji: "🏒",
  collector: "nhl-collector",
  keep: 0.4, // unproven v0 model: keep only 40% of its disagreement with the market until Results justify more
  monthlyCap: 1500,
  markets: {
    player_shots_on_goal: { label: "Shots on Goal", unit: "shots" },
    player_total_saves: { label: "Saves", unit: "saves" },
    player_points: { label: "Points", unit: "points" },
  },
  modelNote:
    "NHL model v0 (paper only): season rates shrunk toward last season and league priors, plus opponent shot suppression. Known gaps: no power-play role or linemates (points run pessimistic), goalie saves ignore team shot suppression. Use Results to judge it before trusting any edge.",
};

export default function NHLApp() {
  return <TrackedSportApp config={NHL_CONFIG} />;
}
