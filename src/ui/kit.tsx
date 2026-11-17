/* Edge Finder interface kit: the shared building blocks every page uses (buttons, selects, tables,
   popovers, toasts, dialogs, team tiles, icons) plus the number formatters. Styling lives in
   ui/styles.css. Nothing here knows about a sport or a model. */
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Menu, Search, X } from "lucide-react";
import { teamColor } from "./teams";

export const cx = (...a) => a.filter(Boolean).join(" ");

/* ---------- formatting ---------- */
const M = "−", DASH = "–";
export const fOdds = (o) => (o == null || o === "" || isNaN(Number(o)) ? DASH : Number(o) > 0 ? `+${Number(o)}` : `${M}${Math.abs(Number(o))}`);
export const fPct = (x, d = 1) => (x == null || isNaN(x) ? DASH : `${(x * 100).toFixed(d)}%`);
export const fSigned = (x, d = 1) => (x == null || isNaN(x) ? DASH : `${x > 0 ? "+" : x < 0 ? M : ""}${Math.abs(x * 100).toFixed(d)}%`);
export const fUnits = (x, d = 2) => (x == null || isNaN(x) ? DASH : `${x > 0 ? "+" : x < 0 ? M : ""}${Math.abs(x).toFixed(d)}u`);
export const fNum = (x, d = 1) => (x == null || x === "" || isNaN(Number(x)) ? DASH : Number(x).toFixed(d));
export const fDelta = (x, d = 2) => (x == null || isNaN(x) ? "" : `${x > 0 ? "+" : x < 0 ? M : ""}${Math.abs(x).toFixed(d)}`);
export const tone = (x) => (x == null || isNaN(x) || Math.abs(x) < 1e-9 ? "mid" : x > 0 ? "pos" : "neg");
export const fDay = (ymd) => { if (!ymd) return ""; const [y, m, d] = String(ymd).split("-").map(Number); if (!y || !m || !d) return String(ymd); return new Date(y, m - 1, d).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }); };
export const fTime = (iso) => { const t = iso ? new Date(iso) : null; return t && !isNaN(t.getTime()) ? t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""; };
export const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export const cmp = (k, d) => (a, b) => { const x = a[k], y = b[k]; if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (typeof x === "string" ? x.localeCompare(y) : x - y) * d; };
export const cap = (s) => (s ? String(s)[0].toUpperCase() + String(s).slice(1) : "");
// "Over 1.5" / "Yes" / a game-line pick, in plain words
export function pickLabel(e, { isLineType, isYesNoType }) {
  if (isLineType && isLineType(e.type)) return e.side === "over" ? `Over ${e.line}` : e.side === "under" ? `Under ${e.line}` : (e.name || cap(e.side));
  if (isYesNoType && isYesNoType(e.type)) return e.side === "over" ? "Yes" : "No";
  return `${e.side === "over" ? "Over" : e.side === "under" ? "Under" : cap(e.side)} ${e.line}`;
}

/* ---------- small saved settings ---------- */
export const readLS = (k, fb) => { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch { return fb; } };
export const writeLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };

/* ---------- app chrome state: theme, sidebar, toasts, confirm dialog ---------- */
const chrome = { v: 0, theme: readLS("ef_theme_v1", "dark"), navMin: readLS("ef_nav_min_v1", false), navOpen: false, toasts: [], dialog: null };
const subs = new Set();
const bump = () => { chrome.v++; subs.forEach((f) => f()); };
export function useChrome() { useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => chrome.v); return chrome; }
export function applyTheme() { try { document.documentElement.dataset.theme = chrome.theme; } catch { /* ignore */ } }
export function setTheme(t) { chrome.theme = t; writeLS("ef_theme_v1", t); applyTheme(); bump(); }
export function setNavMin(v) { chrome.navMin = v; writeLS("ef_nav_min_v1", v); bump(); }
export function setNavOpen(v) { chrome.navOpen = v; bump(); }
let toastId = 0;
// toast("Tracked 12 plays") or toast("Removed bet", undoFn)
export function toast(text, undo = null) {
  const id = ++toastId;
  chrome.toasts = [...chrome.toasts, { id, text, undo }]; bump();
  setTimeout(() => dismissToast(id), undo ? 7000 : 3600);
}
export function dismissToast(id) { if (!chrome.toasts.some((t) => t.id === id)) return; chrome.toasts = chrome.toasts.filter((t) => t.id !== id); bump(); }
// in-app replacement for window.confirm: confirmDialog({ title, body, confirm, danger, onConfirm })
export function confirmDialog(d) { chrome.dialog = d; bump(); }
const closeDialog = () => { chrome.dialog = null; bump(); };

export function Toasts() {
  const c = useChrome();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {c.toasts.map((t) => (
        <div className="toast" key={t.id}>
          <span className="grow">{t.text}</span>
          {t.undo ? <button type="button" onClick={() => { t.undo(); dismissToast(t.id); }}>Undo</button> : null}
          <button type="button" className="dim" aria-label="Dismiss" onClick={() => dismissToast(t.id)} style={{ color: "var(--ink-3)" }}><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}
export function DialogHost() {
  const c = useChrome(), d = c.dialog;
  useEffect(() => { if (!d) return; const k = (e) => { if (e.key === "Escape") closeDialog(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [d]);
  if (!d) return null;
  return (
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) closeDialog(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={d.title}>
        <h2>{d.title}</h2>
        {d.body ? <p>{d.body}</p> : null}
        <footer>
          {d.onConfirm ? <Btn onClick={closeDialog}>Cancel</Btn> : null}
          <Btn kind={d.danger ? "danger" : "primary"} autoFocus onClick={() => { closeDialog(); if (d.onConfirm) d.onConfirm(); }}>{d.confirm || "OK"}</Btn>
        </footer>
      </div>
    </div>
  );
}
export const MenuBtn = () => <Btn icon kind="ghost" className="menu-btn" aria-label="Open menu" onClick={(e) => { e.stopPropagation(); setNavOpen(true); }}><Menu /></Btn>;

/* ---------- controls ---------- */
export function Btn({ kind = "", sm = false, icon = false, on = false, className = "", ...p }) {
  return <button type="button" className={cx("btn", kind, sm && "sm", icon && "icon", on && "on", className)} {...p} />;
}
export function Seg({ value, onChange, options, label }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return <button type="button" key={v} className={value === v ? "on" : ""} aria-pressed={value === v} onClick={() => onChange(v)}>{l}</button>; })}
    </div>
  );
}
export function Switch({ on, onChange, children, title }) {
  return <button type="button" role="switch" aria-checked={on} title={title} className={cx("sw", on && "on")} onClick={() => onChange(!on)}><i />{children}</button>;
}
export function SearchField({ value, onChange, placeholder, width = 220, sm = false, onEnter = null }) {
  return (
    <label className={cx("field", sm && "sm")} style={{ width }}>
      <Search />
      <input value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && onEnter) onEnter(); }} placeholder={placeholder} aria-label={placeholder} />
      {value ? <button type="button" aria-label="Clear search" onClick={() => onChange("")}><X /></button> : null}
    </label>
  );
}
// options: ["a", "b"] or [["value", "Label"], ...]
export function Select({ value, onChange, options, label, sm = false, width, title }) {
  return (
    <select className={cx("field", sm && "sm")} style={{ width }} value={value} aria-label={label} title={title || label} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return <option key={v} value={v}>{l}</option>; })}
    </select>
  );
}
// a labelled field in a filter popover or form
export const Field = ({ label, children, title }) => <label className="frow" title={title}><span>{label}</span>{children}</label>;
export const TextIn = ({ value, onChange, placeholder = "any", width, num = true, ...p }) => <input className={cx("field sm", num && "num")} style={{ width }} value={value} placeholder={placeholder} inputMode={num ? "decimal" : undefined} onChange={(e) => onChange(e.target.value)} {...p} />;
export function Pop({ button, children, right = false, width }) {
  const [open, setOpen] = useState(false), ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const k = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", h); document.addEventListener("keydown", k);
    return () => { document.removeEventListener("pointerdown", h); document.removeEventListener("keydown", k); };
  }, [open]);
  return (
    <span className="pop-wrap" ref={ref}>
      {button(open, () => setOpen((o) => !o))}
      {open ? <div className={cx("pop", right && "right")} style={{ width }}>{typeof children === "function" ? children(() => setOpen(false)) : children}</div> : null}
    </span>
  );
}
// pick several values from a list (games, categories, books)
export function MultiPick({ label, selected, options, labels = null, onChange }) {
  const lab = (o) => (labels && labels[o] != null ? labels[o] : o);
  const summary = selected.length === 0 ? label : selected.length === 1 ? lab(selected[0]) : `${label}: ${selected.length}`;
  return (
    <Pop width={240} button={(open, t) => <Btn on={open || selected.length > 0} onClick={t}><span className="trunc" style={{ maxWidth: 150 }}>{summary}</span><ChevronDown /></Btn>}>
      <div style={{ maxHeight: 280, overflow: "auto", display: "grid", gap: 2 }}>
        {options.length === 0 ? <span className="note">Nothing to pick yet.</span> : null}
        {options.map((o) => { const on = selected.includes(o); return (
          <button type="button" className="menu-item" key={o} onClick={() => onChange(on ? selected.filter((x) => x !== o) : [...selected, o])}>{on ? <Check size={14} /> : <span style={{ width: 14 }} />}<span className="trunc">{lab(o)}</span></button>
        ); })}
      </div>
      {selected.length ? <Btn sm kind="ghost" onClick={() => onChange([])}>Clear</Btn> : null}
    </Pop>
  );
}

/* ---------- data display ---------- */
export const Team = ({ sport, ab, lg = false }) => <span className={cx("team", lg && "lg")} style={teamColor(sport, ab)}>{ab}</span>;
export function GameTag({ sport, game }) {
  const parts = String(game || "").split("@");
  if (parts.length !== 2) return <span className="mid">{game}</span>;
  return <span className="row" style={{ gap: 4 }}><Team sport={sport} ab={parts[0].trim()} /><span className="dim" style={{ fontSize: 11 }}>@</span><Team sport={sport} ab={parts[1].trim()} /></span>;
}
export const Badge = ({ kind = "", children, title }) => <span className={cx("badge", kind)} title={title}>{children}</span>;
export function StatusBadge({ status }) {
  const map = { open: ["line", "Open"], won: ["won", "Won"], lost: ["lost", "Lost"], push: ["", "Push"], void: ["", "Void"] };
  const [k, l] = map[status] || ["", cap(status)];
  return <Badge kind={k}>{l}</Badge>;
}
// sortable column header. sort = { k, d } with d = 1 ascending, -1 descending
export function Th({ k, sort, onSort, r = false, c = false, children, className = "", title, style }) {
  if (!k) return <th className={cx(r && "r", c && "c", className)} title={title} style={style}>{children}</th>;
  const on = sort.k === k;
  return (
    <th className={cx(r && "r", c && "c", on && "sorted", className)} aria-sort={on ? (sort.d > 0 ? "ascending" : "descending") : "none"} title={title} style={style}>
      <button type="button" onClick={() => onSort({ k, d: on ? -sort.d : -1 })}>{children}{on ? (sort.d > 0 ? <ArrowUp /> : <ArrowDown />) : null}</button>
    </th>
  );
}
export const Expander = ({ open, onClick, label }) => <button type="button" className="exp" aria-expanded={open} aria-label={label} title={label} onClick={onClick}><ChevronRight style={open ? { transform: "rotate(90deg)" } : undefined} /></button>;
/* Edge as a number plus a diverging bar: the market is the centre tick, the bar runs toward the model. */
export function Edge({ value, scale = 0.12, digits = 1 }) {
  const w = Math.min(50, (Math.abs(value || 0) / scale) * 50);
  return (
    <span className="edge">
      <span className={cx("num", tone(value))}>{fSigned(value, digits)}</span>
      <span className="edgebar" aria-hidden="true"><i className={value >= 0 ? "p" : "n"} style={{ width: `${w}%` }} /></span>
    </span>
  );
}
export const HBar = ({ value, max = 1, width = 72, color }) => <span className="hbar" style={{ width }} aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(1, (value || 0) / max)) * 100}%`, background: color }} /></span>;
export const Stat = ({ k, v, s, cls = "", title }) => <div className="stat" title={title}><div className="k">{k}</div><div className={cx("v", cls)}>{v}</div>{s ? <div className="s">{s}</div> : null}</div>;
export function Panel({ title, sub, actions, children, flush = false, style, className = "" }) {
  return (
    <section className={cx("panel", className)} style={style}>
      {title ? <header><div className="grow"><h2>{title}</h2>{sub ? <p>{sub}</p> : null}</div>{actions}</header> : null}
      {flush ? children : <div className="body">{children}</div>}
    </section>
  );
}
export const Empty = ({ title, children, action }) => <div className="empty"><b>{title}</b>{children ? <div style={{ maxWidth: 520 }}>{children}</div> : null}{action}</div>;
export const Banner = ({ kind = "warn", children, onClose = null }) => <div className={cx("banner", kind)}><span className="grow">{children}</span>{onClose ? <button type="button" aria-label="Dismiss" onClick={onClose}><X size={14} /></button> : null}</div>;

/* ---------- marks ---------- */
export const Logo = () => (
  <svg className="mark" viewBox="0 0 26 26" aria-hidden="true">
    <rect width="26" height="26" rx="6" fill="var(--accent)" />
    <rect x="7" y="6" width="2" height="14" rx="1" fill="var(--accent-ink)" />
    <rect x="9" y="10" width="11" height="6" rx="1.5" fill="var(--accent-ink)" />
  </svg>
);
const I = (p) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p} />;
export function SportIcon({ sport, size = 17 }) {
  const s = { width: size, height: size, flex: "none" };
  if (sport === "mlb") return <I style={s}><circle cx="12" cy="12" r="9" /><path d="M6.2 5.2c2.4 2 2.4 11.6 0 13.6M17.8 5.2c-2.4 2-2.4 11.6 0 13.6" /></I>;
  if (sport === "nfl") return <I style={s}><path d="M4 20c-1-7 3-15 16-16 1 7-3 15-16 16z" /><path d="M9.5 14.5l5-5M11 11l2 2" /></I>;
  if (sport === "nba") return <I style={s}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3v18M5.6 5.6c3 2.8 3 10 0 12.8M18.4 5.6c-3 2.8-3 10 0 12.8" /></I>;
  if (sport === "nhl") return <I style={s}><path d="M5 4l6 12c.6 1.3 1.6 2 3 2h6v3h-7c-2.2 0-3.8-1-4.700-3L3 6" /><ellipse cx="18" cy="13" rx="3" ry="1.3" /></I>;
  return <I style={s}><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M8 5v14M16 5v14" /></I>;
}
export const SportTag = ({ sport, label, icon = false }) => <span className="row mid" style={{ gap: 6 }} title={label}><SportIcon sport={sport} size={15} />{icon ? null : label}</span>;
