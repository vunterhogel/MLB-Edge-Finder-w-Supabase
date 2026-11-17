/* Small hand-rolled SVG charts. Marks follow one spec: 2px lines, bars capped at 24px with a 4px rounded
   data end, hairline solid grid, ink-coloured text, a hover readout on every chart. */
import React, { useLayoutEffect, useRef, useState } from "react";

const niceStep = (span, n) => { const raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw || 1))), r = raw / mag; return (r >= 5 ? 10 : r >= 2 ? 5 : r >= 1 ? 2 : 1) * mag; };
function ticks(lo, hi, n = 4) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const step = niceStep(hi - lo, n), a = Math.floor(lo / step) * step, out = [];
  for (let v = a; v <= hi + step * 0.999; v += step) out.push(+v.toFixed(6));
  return out;
}
function useTip(fallback = 720) {
  const ref = useRef(null), [tip, setTip] = useState(null), [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const read = () => setWidth(Math.max(260, Math.round(el.clientWidth)));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read); ro.observe(el); return () => ro.disconnect();
  }, []);
  const place = (e, data) => { const r = ref.current.getBoundingClientRect(); setTip({ x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, data }); };
  const node = (render) => (tip ? <div className="tip" style={{ left: tip.x > tip.w - 190 ? undefined : tip.x + 14, right: tip.x > tip.w - 190 ? tip.w - tip.x + 14 : undefined, top: Math.max(0, tip.y - 12) }}>{render(tip.data)}</div> : null);
  return { ref, tip, width, place, clear: () => setTip(null), node };
}

/* series: [{ name, color, values: number[] }], labels: string[] (shared x) */
export function LineChart({ series, labels, height = 240, fmt = (v) => String(v), zero = true }) {
  const t = useTip();
  const W = t.width, H = height, m = { l: 48, r: 60, t: 12, b: 26 };
  const all = series.flatMap((s) => s.values), n = labels.length;
  if (n < 2) return <div className="note" ref={t.ref} style={{ padding: 24 }}>Not enough settled days to draw a trend yet.</div>;
  const tk = ticks(Math.min(zero ? 0 : Infinity, ...all), Math.max(zero ? 0 : -Infinity, ...all));
  const lo = tk[0], hi = tk[tk.length - 1];
  const x = (i) => m.l + (i / (n - 1)) * (W - m.l - m.r), y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const every = Math.ceil(n / Math.max(3, Math.floor(W / 90))), hi_i = t.tip ? t.tip.data : null;
  const move = (e) => { const r = e.currentTarget.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / (W - m.l - m.r)) * (n - 1)))); t.place(e, i); };
  // nudge end labels apart when two series finish close together
  const ends = series.map((s) => ({ s, y: y(s.values[n - 1]) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
  return (
    <div className="chart" ref={t.ref}>
      {series.length > 1 ? <div className="legend" style={{ marginBottom: 6 }}>{series.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}</div> : null}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={series.map((s) => s.name).join(" and ")} onPointerMove={move} onPointerLeave={t.clear}>
        {tk.map((v) => <g key={v}><line x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} stroke={v === 0 ? "var(--axis)" : "var(--grid)"} strokeWidth="1" /><text x={m.l - 8} y={y(v) + 4} textAnchor="end">{fmt(v)}</text></g>)}
        {labels.map((l, i) => (i % every === 0 ? <text key={i} x={x(i)} y={H - 6} textAnchor="middle">{l}</text> : null))}
        {hi_i != null ? <line x1={x(hi_i)} x2={x(hi_i)} y1={m.t} y2={H - m.b} stroke="var(--axis)" strokeWidth="1" /> : null}
        {series.map((s) => <path key={s.name} d={s.values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("")} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />)}
        {series.map((s) => { const i = hi_i != null ? hi_i : n - 1; return <circle key={s.name} cx={x(i)} cy={y(s.values[i])} r="4" fill={s.color} stroke="var(--panel)" strokeWidth="2" />; })}
        {ends.map(({ s, y: yy }) => <text key={s.name} x={W - m.r + 9} y={yy + 4} style={{ fill: "var(--ink-2)" }}>{fmt(s.values[n - 1])}</text>)}
      </svg>
      {t.node((i) => <><span className="t">{labels[i]}</span>{series.map((s) => <span className="l" key={s.name}><i style={{ background: s.color }} />{s.name}<b className="num">{fmt(s.values[i])}</b></span>)}</>)}
    </div>
  );
}

/* buckets: [{ p: predicted (0..1), actual: (0..1), n }] */
export function Calibration({ buckets, height = 300 }) {
  const W = 420, H = height, m = { l: 40, r: 14, t: 10, b: 34 };
  const t = useTip();
  const x = (v) => m.l + v * (W - m.l - m.r), y = (v) => m.t + (1 - v) * (H - m.t - m.b);
  const maxN = Math.max(1, ...buckets.map((b) => b.n));
  const pts = buckets.filter((b) => b.n > 0);
  return (
    <div className="chart" ref={t.ref} style={{ maxWidth: 480 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Predicted win probability against actual hit rate" onPointerLeave={t.clear}>
        {[0, 0.25, 0.5, 0.75, 1].map((v) => <g key={v}><line x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} stroke="var(--grid)" /><text x={m.l - 8} y={y(v) + 4} textAnchor="end">{v * 100}%</text><text x={x(v)} y={H - m.b + 16} textAnchor="middle">{v * 100}%</text></g>)}
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--axis)" strokeWidth="1" />
        <text x={x(0.86)} y={y(0.9) - 6} textAnchor="end" style={{ fill: "var(--ink-3)" }}>perfectly calibrated</text>
        <path d={pts.map((b, i) => `${i ? "L" : "M"}${x(b.p).toFixed(1)},${y(b.actual).toFixed(1)}`).join("")} fill="none" stroke="var(--s1)" strokeWidth="2" strokeLinejoin="round" />
        {pts.map((b, i) => <circle key={i} cx={x(b.p)} cy={y(b.actual)} r={4 + 4 * Math.sqrt(b.n / maxN)} fill="var(--s1)" stroke="var(--panel)" strokeWidth="2" />)}
        {pts.map((b, i) => <circle key={"h" + i} cx={x(b.p)} cy={y(b.actual)} r="16" fill="transparent" onPointerMove={(e) => t.place(e, b)} />)}
        <text x={(m.l + W - m.r) / 2} y={H - 2} textAnchor="middle">Model probability</text>
      </svg>
      {t.node((b) => <><span className="t">Model said {(b.p * 100).toFixed(0)}%</span><span className="l">Actually hit<b className="num">{(b.actual * 100).toFixed(1)}%</b></span><span className="l">Plays<b className="num">{b.n.toLocaleString()}</b></span></>)}
    </div>
  );
}

/* bars: [{ label, sub, v }] oldest first; line: number */
export function FormBars({ bars, line, height = 220, side = "over", inclusive = false, lineLabel = null, fmt = (v) => String(v) }) {
  const t = useTip();
  const n = bars.length, W = t.width, H = height, m = { l: 30, r: 62, t: 14, b: 38 };
  const tk = ticks(0, Math.max(line * 1.25, 1, ...bars.map((b) => b.v)), 4), hi = tk[tk.length - 1] || 1;
  const band = (W - m.l - m.r) / Math.max(1, n), bw = Math.min(24, band - 6);
  const y = (v) => m.t + (1 - v / hi) * (H - m.t - m.b), base = y(0);
  const every = band < 22 ? 3 : band < 36 ? 2 : 1; // label every bar only when there is room
  const hit = (v) => (side === "over" ? (inclusive ? v >= line : v > line) : v < line);
  return (
    <div className="chart" ref={t.ref}>
      <div className="legend" style={{ marginBottom: 6 }}><span><i style={{ background: "var(--s1)", height: 8, width: 8, borderRadius: 2 }} />Cleared the line</span><span><i style={{ background: "var(--line-2)", height: 8, width: 8, borderRadius: 2 }} />Missed</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Game by game results against the line" onPointerLeave={t.clear}>
        {tk.map((v) => <g key={v}><line x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} stroke={v === 0 ? "var(--axis)" : "var(--grid)"} /><text x={m.l - 8} y={y(v) + 4} textAnchor="end">{v}</text></g>)}
        {bars.map((b, i) => {
          const cx = m.l + band * (i + 0.5), top = y(b.v), h = Math.max(0, base - top), r = Math.min(4, h);
          return (
            <g key={i}>
              {h > 0 ? <path d={`M${cx - bw / 2},${base}V${top + r}q0,${-r} ${r},${-r}h${bw - 2 * r}q${r},0 ${r},${r}V${base}z`} fill={hit(b.v) ? "var(--s1)" : "var(--line-2)"} /> : <rect x={cx - bw / 2} y={base - 2} width={bw} height="2" fill="var(--line-2)" />}
              {(n - 1 - i) % every === 0 ? <><text x={cx} y={H - m.b + 15} textAnchor="middle">{b.label}</text><text x={cx} y={H - m.b + 28} textAnchor="middle" style={{ fontSize: 10 }}>{b.sub}</text></> : null}
              <rect x={cx - band / 2} y={m.t} width={band} height={H - m.t - m.b} fill="transparent" onPointerMove={(e) => t.place(e, b)} />
            </g>
          );
        })}
        <line x1={m.l} x2={W - m.r} y1={y(line)} y2={y(line)} stroke="var(--ink)" strokeWidth="1.5" />
        <text x={W - m.r + 8} y={y(line) + 4} style={{ fill: "var(--ink)", fontWeight: 600 }}>{lineLabel || `Line ${line}`}</text>
      </svg>
      {t.node((b) => <><span className="t">{b.tip}</span><span className="l">Result<b className="num">{fmt(b.v)}</b></span><span className="l">{hit(b.v) ? "Cleared" : "Missed"} the line</span></>)}
    </div>
  );
}

export function Spark({ values, width = 96, height = 28, color = "var(--s1)" }) {
  if (!values || values.length < 2) return null;
  const lo = Math.min(...values), hi = Math.max(...values), sp = hi - lo || 1;
  const pt = (v, i) => `${(i / (values.length - 1)) * (width - 6) + 3},${height - 4 - ((v - lo) / sp) * (height - 8)}`;
  const last = pt(values[values.length - 1], values.length - 1).split(",");
  return (
    <svg width={width} height={height} aria-hidden="true">
      <polyline points={values.map(pt).join(" ")} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r="3" fill={color} />
    </svg>
  );
}
