/* Parlay pieces shared by the Parlay builder and My bets. */
import React from "react";
import { RotateCcw, X } from "lucide-react";
import { HUB_SPORT } from "../hub/sports";
import { parlayDate, parlayProfitUnits, removeParlay, setLegResult, setParlays, setParlayUnits, unitsOf } from "./store";
import { Badge, Btn, Pop, SportIcon, StatusBadge, cx, fDay, fOdds, fPct, fSigned, fUnits, pickLabel, toast, tone } from "../ui/kit";

export const legPick = (l) => (HUB_SPORT[l.sport] ? pickLabel(l, HUB_SPORT[l.sport].rowCfg) : `${l.side} ${l.line}`);
const legWho = (l) => (l.isLine || !l.name ? String(l.game || "").replace("@", " at ") : l.name);

// one leg, bet-slip style: sport, player or game, the pick, odds, and an optional right slot
export function LegRow({ leg, right = null, sub = null }) {
  return (
    <div className="legrow">
      <span className="trunc"><span className="mid" style={{ display: "inline-block", verticalAlign: "-3px", marginRight: 6 }} title={HUB_SPORT[leg.sport] ? HUB_SPORT[leg.sport].label : leg.sport}><SportIcon sport={leg.sport} size={15} /></span><span className="name">{legWho(leg)}</span> <span className="pick"><b>{legPick(leg)}</b> <span className="mid">{leg.type}</span></span></span>
      <span className="num">{fOdds(leg.odds)}</span>
      {right || <span />}
      <small className="num">{leg.name && !leg.isLine && leg.game ? `${String(leg.game).replace("@", " at ")}, ` : ""}model {fPct(leg.modelP)}{leg.ev != null ? `, EV ${fSigned(leg.ev)}` : ""}{sub}</small>
    </div>
  );
}

// combined numbers line for a parlay or a candidate
export function ParlayNumbers({ american, modelP, edge, ev, sgp }) {
  return (
    <span className="row num wrap" style={{ gap: 14 }}>
      <b style={{ fontSize: 15 }}>{fOdds(american)}</b>
      <span className="mid">win {fPct(modelP)}</span>
      <span className={tone(edge)}>edge {fSigned(edge)}</span>
      <span className={tone(ev)} style={{ fontWeight: 620 }}>EV {fSigned(ev)}</span>
      {sgp ? <Badge kind="warn" title="Legs from the same game move together, so the combined EV is optimistic">Same game</Badge> : null}
    </span>
  );
}

// a tracked parlay: status, combined numbers as built, units, profit, legs with results and a manual override
export function TrackedParlay({ p }) {
  const units = unitsOf(p);
  const profit = parlayProfitUnits(p.status, p.legs, units);
  const remove = () => { removeParlay(p.id); toast("Parlay removed.", () => setParlays((cur) => (cur.some((x) => x.id === p.id) ? cur : [p, ...cur]))); };
  return (
    <section className="panel">
      <header>
        <div className="grow">
          <h2>{p.legs.length}-leg parlay</h2>
          <p title={`Built ${new Date(p.builtAt).toLocaleString()}`}>{fDay(parlayDate(p))}</p>
        </div>
        {p.status !== "open" ? <span className={cx("num", tone(profit))} style={{ fontWeight: 640 }}>{fUnits(profit)}</span> : null}
        <StatusBadge status={p.status} />
        <label className="row" style={{ gap: 6 }}><span className="label">Units</span><input className="cell num" style={{ width: 52 }} aria-label="Units" inputMode="decimal" value={p.units ?? 1} onChange={(e) => setParlayUnits(p.id, e.target.value)} /></label>
        <Btn sm icon kind="ghost" aria-label="Remove parlay" title="Remove parlay" onClick={remove}><X /></Btn>
      </header>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)" }}><ParlayNumbers american={p.builtAmerican} modelP={p.builtModelP} edge={p.builtEdge} ev={p.builtEV} sgp={p.sgp} /></div>
      <div>
        {p.legs.map((l, j) => (
          <LegRow key={j} leg={l}
            sub={l.actualStat != null ? `, actual ${l.actualStat}` : ""}
            right={
              <span className="row" style={{ gap: 4 }}>
                {l.result ? <StatusBadge status={l.result} /> : (
                  <Pop right width={150} button={(o, t) => <button type="button" onClick={t} title="Set this leg's result by hand" aria-label="Set this leg's result by hand"><StatusBadge status="open" /></button>}>
                    {(close) => ["won", "lost", "push", "void"].map((r) => <button type="button" className="menu-item" key={r} onClick={() => { setLegResult(p.id, j, r); close(); }}>{r[0].toUpperCase() + r.slice(1)}</button>)}
                  </Pop>
                )}
                {l.manual ? <Btn sm icon kind="ghost" aria-label="Clear the result set by hand" title="Clear the result you set by hand. Automatic settlement fills it again." onClick={() => setLegResult(p.id, j, null)}><RotateCcw /></Btn> : null}
              </span>
            } />
        ))}
      </div>
    </section>
  );
}
