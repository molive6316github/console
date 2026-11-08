// Minimal 5-field cron: minute hour day-of-month month day-of-week. Supports *, lists, ranges, steps (*/5, 1-10/2).
// Day-of-week is 0-6 (0 = Sunday; 7 also accepted). Like classic cron, if BOTH day-of-month and day-of-week
// are restricted, either one matching is enough. Times are evaluated in a named time zone.

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
];

function parseField(text, { name, min, max }) {
  const out = new Set();
  for (const part of text.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`Bad ${name} field: "${part}"`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) throw new Error(`Bad step in ${name} field`);
    let lo, hi;
    if (m[1] === "*") [lo, hi] = [min, max];
    else if (m[1].includes("-")) [lo, hi] = m[1].split("-").map(Number);
    else {
      lo = Number(m[1]);
      hi = m[2] === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`${name} must be ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(name === "day of week" && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expr) {
  if (typeof expr !== "string") throw new Error("Schedule is required");
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("A schedule has 5 fields: minute hour day-of-month month day-of-week");
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  return { minute, hour, dom, month, dow, domAny: parts[2] === "*", dowAny: parts[4] === "*" };
}

export function matches(c, p) {
  if (!c.minute.has(p.minute) || !c.hour.has(p.hour) || !c.month.has(p.month)) return false;
  const domOk = c.dom.has(p.dom);
  const dowOk = c.dow.has(p.dow);
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk;
}

const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function validTimezone(tz) {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// The wall-clock fields of an instant in a time zone.
export function partsIn(date, tz) {
  const o = {};
  for (const { type, value } of formatter(tz).formatToParts(date)) o[type] = value;
  return { minute: +o.minute, hour: +o.hour % 24, dom: +o.day, month: +o.month, dow: DOW[o.weekday] };
}

// Next time (ms) this schedule fires after `fromMs`, looking ahead up to `days`. null if none in that window.
export function nextRun(expr, tz, fromMs, days = 40) {
  const c = parseCron(expr);
  let t = Math.floor(fromMs / 60000) * 60000 + 60000;
  const end = t + days * 86_400_000;
  for (; t < end; t += 60000) if (matches(c, partsIn(new Date(t), tz))) return t;
  return null;
}
