export default function (ctx) {
  let minute = 0, next = 0;
  ctx.every(60, async () => {
    const s = ctx.settings.get();
    if (++minute % Math.max(1, Number(s.everyMin) || 10) !== 0) return;
    const lines = String(s.messages ?? "").split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 30);
    if (!lines.length) return;
    const st = await ctx.mc.live().catch(() => null);
    if (!st?.online || !(st.players?.online > 0)) return; // nobody to read it
    const text = lines[next++ % lines.length].slice(0, 100);
    const json = JSON.stringify({ text, color: s.color }).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    await ctx.mc.run(`tellraw @a ${json}`);
  });
}
