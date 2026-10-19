import SportApp from "../../core/SportApp";
import NHL from "./adapter";

/* NHL page = the shared shell + the NHL adapter. */
export default function NHLPage() {
  return <SportApp sport={NHL} />;
}
