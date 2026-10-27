import SportApp from "./core/SportApp";
import MLB from "./sports/mlb/adapter";

/* MLB page = the shared shell + the MLB adapter. */
export default function App(props) {
  return <SportApp sport={MLB} {...props} />;
}
