/* The NFL's slate picker: a week dropdown that sits in the same header box as the date input other
   sports use (the shell owns the ◂ ▸ today buttons around it). Everything else on the NFL page is the
   shared shell; NFL content comes from the adapter as data. */
import { PICKER_CLASS } from "../../core/slate";

const MAX_WEEK = { 1: 4, 2: 18, 3: 5 };
const ST_PREFIX = { 1: "Pre ", 2: "", 3: "Post " };
export function WeekPicker({ value, onChange }) {
  const y = Number(String(value).split("-")[0]) || new Date().getFullYear();
  const opts = [];
  for (const yr of [y, y - 1]) for (const st of [3, 2, 1]) for (let w = MAX_WEEK[st]; w >= 1; w--) opts.push(`${yr}-${st}-${w}`);
  if (!opts.includes(value)) opts.unshift(value);
  const label = (k) => { const [yr, st, w] = k.split("-"); return `${yr} ${ST_PREFIX[st] || ""}Wk ${w}`; };
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={PICKER_CLASS}>
      {opts.map((k) => <option key={k} value={k}>{label(k)}</option>)}
    </select>
  );
}
export const weekShift = (k, n) => {
  const [y, st, w] = String(k).split("-").map(Number);
  return `${y}-${st}-${Math.min(MAX_WEEK[st] || 22, Math.max(1, w + n))}`;
};

