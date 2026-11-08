const PRESETS = {
  midnight: { bg: "#0e1116", panel: "#171b22", border: "#2a3040", text: "#e6e9ef", muted: "#8b93a7", accent: "#4ade80" },
  ocean: { bg: "#08131f", panel: "#0f2233", border: "#1f3d57", text: "#e3f1ff", muted: "#7fa3c2", accent: "#38bdf8" },
  forest: { bg: "#0c140f", panel: "#142019", border: "#25382b", text: "#e6f2e8", muted: "#86a08c", accent: "#84cc16" },
  sunset: { bg: "#170d10", panel: "#241419", border: "#43242d", text: "#fbe9e4", muted: "#b48a8f", accent: "#fb923c" },
  grape: { bg: "#120d1c", panel: "#1c1530", border: "#35294f", text: "#efe9fb", muted: "#9a8dba", accent: "#c084fc" },
  light: { bg: "#f5f7fa", panel: "#ffffff", border: "#d8dee8", text: "#1a2230", muted: "#5b6679", accent: "#16a34a" },
};
const FONTS = { system: "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", serif: "Georgia,'Times New Roman',serif", mono: "ui-monospace,Menlo,Consolas,monospace", rounded: "ui-rounded,'Nunito','Varela Round',system-ui,sans-serif" };

export default function (ctx) {
  const s = ctx.settings.get();
  const t = s.preset === "custom" ? { ...PRESETS.midnight, bg: s.bg, panel: s.panel, text: s.text, accent: s.accent } : PRESETS[s.preset] ?? PRESETS.midnight;
  // Panel uses --panel/--border/--muted; Console websites use --card/--dim. Set both families.
  ctx.css(`:root{--bg:${t.bg};--panel:${t.panel};--card:${t.panel};--border:${t.border};--text:${t.text};--muted:${t.muted};--dim:${t.muted};--accent:${t.accent}}body{font-family:${FONTS[s.font] ?? FONTS.system}}`);
}
