import SportApp from "../../core/SportApp";
import NBA from "./adapter";

/* NBA page = the shared shell + the NBA adapter. */
export default function NBAPage(props) {
  return <SportApp sport={NBA} {...props} />;
}
