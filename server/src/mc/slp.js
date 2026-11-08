import net from "node:net";

// Minecraft "server list ping": the same quick question the game's server list asks. It needs no console commands,
// so it can run as often as we like without filling the server log.
const varint = (n) => {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
};
const str = (s) => Buffer.concat([varint(Buffer.byteLength(s)), Buffer.from(s)]);
const packet = (payload) => Buffer.concat([varint(payload.length), payload]);

function readVarint(buf, at) {
  let n = 0, shift = 0, i = at;
  for (;;) {
    if (i >= buf.length) return null;
    const b = buf[i++];
    n |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return { value: n, next: i };
    shift += 7;
    if (shift > 35) throw new Error("bad varint");
  }
}

const strip = (s) => String(s ?? "").replace(/§./g, "");
function flatten(d) {
  if (d == null) return "";
  if (typeof d === "string") return d;
  return (d.text ?? "") + (Array.isArray(d.extra) ? d.extra.map(flatten).join("") : "");
}

export function ping(host, port, { timeout = 3000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let buf = Buffer.alloc(0);
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    const sock = net.connect({ host, port });
    sock.setTimeout(timeout, () => finish({ online: false }));
    sock.on("error", () => finish({ online: false }));
    sock.on("close", () => finish({ online: false }));
    sock.on("connect", () => {
      const port2 = Buffer.alloc(2); port2.writeUInt16BE(port);
      const handshake = Buffer.concat([varint(0), varint(765), str(host), port2, varint(1)]);
      sock.write(Buffer.concat([packet(handshake), packet(varint(0))]));
    });
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > 262144) return finish({ online: false });
      try {
        const len = readVarint(buf, 0);
        if (!len || buf.length < len.next + len.value) return;
        const id = readVarint(buf, len.next);
        const sl = readVarint(buf, id.next);
        if (!sl || buf.length < sl.next + sl.value || id.value !== 0) return finish({ online: false });
        const j = JSON.parse(buf.subarray(sl.next, sl.next + sl.value).toString("utf8"));
        finish({
          online: true,
          version: strip(j.version?.name),
          players: { online: j.players?.online ?? 0, max: j.players?.max ?? 0, names: (j.players?.sample ?? []).map((p) => strip(p.name)).filter(Boolean) },
          motd: strip(flatten(j.description)),
        });
      } catch {
        finish({ online: false });
      }
    });
  });
}
