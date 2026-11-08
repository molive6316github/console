import { SetupError, nameAndId, intIn, str, parseEnvText, commandExists, fail } from "./common.js";

// Add more apps by adding an entry here. `ports` are [containerPort, defaultHostPort, label]; `volumes` are paths inside the container.
export const DOCKER_APPS = {
  "uptime-kuma": { title: "Uptime Kuma", blurb: "Pretty uptime monitoring and status pages.", image: "louislam/uptime-kuma:latest", ports: [[3001, 3001, "web"]], volumes: ["/app/data"] },
  portainer: { title: "Portainer", blurb: "A web UI for managing Docker.", image: "portainer/portainer-ce:latest", ports: [[9443, 9443, "web (https)"]], volumes: ["/data"], mounts: ["/var/run/docker.sock:/var/run/docker.sock"] },
  vaultwarden: { title: "Vaultwarden", blurb: "Self-hosted password manager (Bitwarden compatible). Put it behind HTTPS before real use.", image: "vaultwarden/server:latest", ports: [[80, 8222, "web"]], volumes: ["/data"] },
  "nginx-proxy-manager": { title: "Nginx Proxy Manager", blurb: "Point domains at your apps with a web UI. Uses ports 80 and 443, so it clashes with Console's own HTTPS (Caddy).", image: "jc21/nginx-proxy-manager:latest", ports: [[81, 81, "admin"], [80, 80, "http"], [443, 443, "https"]], volumes: ["/data", "/etc/letsencrypt"], warn: "Uses ports 80/443. Don't install this if Console already serves HTTPS through Caddy." },
  filebrowser: { title: "File Browser", blurb: "Browse and share files from a web page.", image: "filebrowser/filebrowser:latest", ports: [[80, 8081, "web"]], volumes: ["/srv", "/database"] },
};

const IMAGE = /^[a-z0-9][a-z0-9._\-/]{0,120}(:[A-Za-z0-9._-]{1,100})?(@sha256:[a-f0-9]{64})?$/;

export function dockerArgs(c, app) {
  const args = ["run", "-d", "--name", c.id, "--restart", "unless-stopped"];
  for (const [cport, hport] of c.ports) args.push("-p", `${hport}:${cport}`);
  (app.volumes ?? []).forEach((v, i) => args.push("-v", `console-${c.id}-${i}:${v}`));
  for (const m of app.mounts ?? []) args.push("-v", m);
  for (const [k, v] of c.env) args.push("-e", `${k}=${v}`);
  args.push(c.image);
  return args;
}

export default {
  id: "docker",
  title: "Docker app",
  blurb: "One-click apps like Uptime Kuma and Portainer, or any Docker image.",
  category: "Apps",
  level: "simple",
  fields: [
    { key: "app", label: "App", type: "select", options: [...Object.entries(DOCKER_APPS).map(([value, a]) => ({ value, label: `${a.title}: ${a.blurb}` })), { value: "custom", label: "Any Docker image…" }], default: "uptime-kuma", required: true },
    { key: "name", label: "Name", type: "text", required: true },
    { key: "hostPort", label: "Port on this server", type: "number", level: "standard", help: "Leave blank for the app's usual port." },
    { key: "image", label: "Docker image", type: "text", level: "standard", showWhen: { app: "custom" }, help: "For example ghcr.io/me/my-bot:latest" },
    { key: "containerPort", label: "Port inside the container", type: "number", level: "standard", showWhen: { app: "custom" } },
    { key: "envText", label: "Environment variables", type: "textarea", level: "standard", help: "One NAME=value per line (tokens, settings).", showWhen: { app: "custom" } },
    { key: "id", label: "ID", type: "text", level: "advanced" },
  ],
  validate(inp, env) {
    const key = str(inp.app, 40);
    const custom = key === "custom";
    const app = DOCKER_APPS[key];
    if (!app && !custom) throw new SetupError("Pick an app");
    const { name, id } = nameAndId(inp, env.db, app?.title ?? "My container");
    const image = custom ? str(inp.image, 200) : app.image;
    if (!IMAGE.test(image)) throw new SetupError("That doesn't look like a Docker image name");
    let ports;
    if (custom) {
      const cp = inp.containerPort === "" || inp.containerPort === undefined ? null : intIn(inp.containerPort, 1, 65535, "Container port");
      const hp = inp.hostPort === "" || inp.hostPort === undefined ? cp : intIn(inp.hostPort, 1, 65535, "Port");
      ports = cp ? [[cp, hp]] : [];
    } else {
      ports = app.ports.map(([cp, hp], i) => [cp, i === 0 && inp.hostPort ? intIn(inp.hostPort, 1, 65535, "Port") : hp]);
    }
    for (const [, hp] of ports) if (hp < 1024) throw new SetupError("Pick a port of 1024 or higher (low ports need root and clash with HTTPS).");
    return { key, custom, name, id, image, ports, env: custom ? parseEnvText(inp.envText) : [], app: app ?? { volumes: [], mounts: [] } };
  },
  async run(c, ctx, env) {
    if (!(await commandExists(env.run, "docker"))) {
      throw fail("Docker isn't installed on this server. Install it first (Oracle Linux: https://docs.docker.com/engine/install/rhel/), then try again.");
    }
    const info = await env.run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 15_000 });
    if (info.code !== 0) {
      if (/permission denied/i.test(info.stderr)) {
        throw fail(`Console's user isn't allowed to use Docker. Fix: sudo usermod -aG docker ${env.user}, then restart Console (Settings > Restart Console).`);
      }
      throw fail(`Docker isn't running: ${info.stderr.trim().split("\n")[0] || "no answer"}. Try: sudo systemctl enable --now docker`);
    }
    if (c.app.warn) ctx.log(`⚠ ${c.app.warn}`);
    ctx.log(`Downloading ${c.image} (the first time can take a minute)…`);
    await ctx.exec("docker", ["pull", c.image]);
    const args = dockerArgs(c, c.app);
    await ctx.exec("docker", args, { label: `docker run ${c.id} (${c.image})` }); // env values stay out of the log
    const web = c.ports[0]?.[1];
    return {
      id: c.id,
      name: c.name,
      type: "docker",
      target: { container: c.id },
      note: web ? `Open http://${env.publicIp || "<your server IP>"}:${web} (and allow TCP ${web} in your Oracle VCN)` : undefined,
    };
  },
};
