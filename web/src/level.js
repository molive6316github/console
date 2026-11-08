// How much of Console to show. Saved per browser; it only changes what's visible, never what anyone is allowed to do.
export const LEVELS = [
  { id: "simple", label: "Simple", blurb: "Just the essentials: your servers and one-click setup." },
  { id: "standard", label: "Standard", blurb: "Adds metrics, schedules, discovery, users and updates." },
  { id: "advanced", label: "Advanced", blurb: "Everything: audit log, raw options, terminal and Linux users." },
];
const ORDER = LEVELS.map((l) => l.id);
let current = "standard";
let stored = false;
try {
  const v = localStorage.getItem("console.level");
  if (ORDER.includes(v)) ((current = v), (stored = true));
} catch { /* storage blocked: keep the default */ }

// A first-time visitor on a Minecraft-mode install starts on Simple. Anything they chose themselves wins.
export function defaultLevel(id) {
  if (!stored && ORDER.includes(id)) current = id;
}

export const getLevel = () => current;
export function setLevel(id) {
  if (!ORDER.includes(id)) return;
  current = id;
  try { localStorage.setItem("console.level", id); } catch { /* ignore */ }
  window.dispatchEvent(new Event("console:level"));
}
// true when the current level is at least `min`
export const atLeast = (min) => ORDER.indexOf(current) >= ORDER.indexOf(min);
