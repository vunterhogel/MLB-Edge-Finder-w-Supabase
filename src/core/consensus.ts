/* Market consensus fair price (2026-11-19).
   A book's own no-vig price can never show an edge against that same book: it is that book's opinion with the
   cut removed. The fair price here comes from the REST of the market instead: every other book in the same odds
   call that prices the same market at the same line, each de-vigged on its own (over / under or home / away),
   then averaged. The bet is still priced at the book you picked; the other books are only the yardstick, never
   where the bet is placed. When that book's price is better than the consensus fair, the row shows +EV.

   Cost: The Odds API charges per (market x region), and every group of up to 10 bookmakers counts as one
   region, so adding books up to 10 total in the call the app already makes costs no extra credits.

   The model sits on top of the consensus with exactly the weight it already had against the book's own price
   (CALIB_KEEP x disagreement weight, read back off the row). Where that weight is 0 (NBA today), the row is
   priced at the consensus alone. One-sided markets (only a "Yes" price) have nothing to de-vig against and
   keep the book's own fair price. */
import { clamp, evPerUnit, impliedProb, probToAmerican } from "./math";

// up to 9 books besides the one you bet at (10 total = 1 region of credits). The Odds API keys.
export const CONSENSUS_BOOKS = ["fanduel", "williamhill_us", "pinnacle", "betmgm", "espnbet", "fanatics", "betrivers", "betonlineag", "hardrockbet"];
export const CONSENSUS_MIN_BOOKS = 2;   // other books that must price the same line before the consensus is used
export const MAX_BOOKS_PER_CALL = 10;

export function consensusBooks(booksNeeded) {
  const room = Math.max(0, MAX_BOOKS_PER_CALL - booksNeeded.length);
  return CONSENSUS_BOOKS.filter((b) => !booksNeeded.includes(b)).slice(0, room);
}

const SPREAD_TYPES = new Set(["Spread", "Puck Line", "Run Line"]);
const OPP = { over: "under", under: "over", home: "away", away: "home" };
// the other side of the same market at the same line (a spread's other side carries the negated point)
export function oppositeOf(e) {
  const side = OPP[e.side];
  if (!side) return null;
  const ln = Number(e.line);
  return { ...e, side, line: SPREAD_TYPES.has(e.type) && Number.isFinite(ln) ? String(-ln) : e.line };
}

// one book's de-vigged probability for this row's side, or null if it doesn't price both sides at this line
export function bookFair(matchCurrentOdds, e, rows, gl) {
  const opp = oppositeOf(e);
  if (!opp) return null;
  const a = matchCurrentOdds(e, rows, gl), b = matchCurrentOdds(opp, rows, gl);
  if (a == null || b == null) return null;
  const ia = impliedProb(Number(a)), ib = impliedProb(Number(b));
  return ia > 0 && ib > 0 ? ia / (ia + ib) : null;
}

/* Re-price one board row against the consensus. Keeps the model's own weight on its lean:
   w = (calibrated - bookNoVig) / (raw - bookNoVig), the same CALIB_KEEP x disagreement weight the engine used. */
export function applyConsensus(e, byBook, matchCurrentOdds) {
  if (!e || e.odds == null || !OPP[e.side]) return e;
  const fairs = [], books = [];
  for (const [bk, p] of Object.entries(byBook)) {
    const f = bookFair(matchCurrentOdds, e, p.rows, p.gl);
    if (f != null) { fairs.push(f); books.push(bk); }
  }
  if (fairs.length < CONSENSUS_MIN_BOOKS) return { ...e, fairP: null, fairBooks: fairs.length };
  const fair = fairs.reduce((s, x) => s + x, 0) / fairs.length;
  if (e.modelP == null || e.novig == null) return { ...e, fairP: fair, fairBooks: fairs.length };
  const raw = e.rawModelP;
  const w = raw != null && Math.abs(raw - e.novig) > 1e-6 ? clamp((e.modelP - e.novig) / (raw - e.novig), 0, 1) : 0;
  const modelP = clamp(fair + w * ((raw != null ? raw : fair) - fair), 0.001, 0.999);
  return {
    ...e,
    modelP, edge: modelP - e.novig, ev: evPerUnit(modelP, Number(e.odds)), fair: probToAmerican(modelP),
    fairP: fair, fairBooks: fairs.length, fairBookKeys: books, bookModelP: e.modelP,
  };
}
