import SportApp from "../../core/SportApp";
import NFL from "./adapter";

/* NFL page = the shared shell + the NFL adapter. */
export default function NFLPage(props) {
  return <SportApp sport={NFL} {...props} />;
}
