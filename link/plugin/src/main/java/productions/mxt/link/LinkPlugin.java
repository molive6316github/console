package productions.mxt.link;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.bukkit.Bukkit;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

/**
 * Console Link: pushes this server's status to a Console Link hub every few seconds and runs the
 * small set of dashboard commands the hub hands back. It only makes outbound HTTPS requests.
 */
public final class LinkPlugin extends JavaPlugin {
    // Same allowlist as the hub. The plugin never trusts the hub to have checked.
    private static final Pattern NAME = Pattern.compile("^[A-Za-z0-9_]{1,16}$");
    private static final Pattern SAY = Pattern.compile("^[^\\n\\r/§]{1,200}$");

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(8)).build();
    private final Gson gson = new Gson();
    private final AtomicBoolean busy = new AtomicBoolean(false);
    private final ConcurrentLinkedQueue<JsonObject> done = new ConcurrentLinkedQueue<>();
    private volatile String lastStatus = "Not pushed yet.";
    private volatile int failures = 0;
    private volatile long pauseUntil = 0;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        String key = getConfig().getString("key", "").trim();
        String url = getConfig().getString("hub-url", "").trim();
        if (key.isEmpty() || url.isEmpty()) {
            lastStatus = "Not configured. Set hub-url and key in plugins/ConsoleLink/config.yml, then /consolelink reload.";
            getLogger().warning(lastStatus);
            return;
        }
        if (!url.startsWith("https://") && !url.startsWith("http://127.0.0.1") && !url.startsWith("http://localhost")) {
            lastStatus = "hub-url must be https:// (plain http is only allowed for localhost).";
            getLogger().severe(lastStatus);
            return;
        }
        long every = Math.max(5, getConfig().getLong("interval-seconds", 10)) * 20L;
        // The snapshot is read on the main thread (Bukkit isn't thread-safe), the network call happens off it.
        Bukkit.getScheduler().runTaskTimer(this, this::tick, 100L, every);
        getLogger().info("Pushing status to " + url + " every " + (every / 20) + "s.");
    }

    private void tick() {
        if (System.currentTimeMillis() < pauseUntil || !busy.compareAndSet(false, true)) return;
        final JsonObject body = snapshot();
        Bukkit.getScheduler().runTaskAsynchronously(this, () -> {
            try {
                push(body);
            } finally {
                busy.set(false);
            }
        });
    }

    private JsonObject snapshot() {
        JsonObject o = new JsonObject();
        o.addProperty("version", Bukkit.getMinecraftVersion());
        o.addProperty("max", Bukkit.getMaxPlayers());
        try { o.addProperty("tps", Math.round(Bukkit.getTPS()[0] * 10.0) / 10.0); } catch (Throwable ignored) { /* not Paper */ }
        try { o.addProperty("motd", Bukkit.getMotd()); } catch (Throwable ignored) { }
        JsonArray ps = new JsonArray();
        if (getConfig().getBoolean("share-player-names", true)) {
            for (Player p : Bukkit.getOnlinePlayers()) {
                JsonObject j = new JsonObject();
                j.addProperty("name", p.getName());
                j.addProperty("uuid", p.getUniqueId().toString());
                ps.add(j);
            }
        }
        o.add("players", ps);
        JsonArray acks = new JsonArray();
        JsonObject d;
        while ((d = done.poll()) != null) acks.add(d);
        o.add("done", acks);
        return o;
    }

    private void push(JsonObject body) {
        try {
            String url = getConfig().getString("hub-url").replaceAll("/+$", "") + "/v1/ingest";
            HttpRequest req = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofSeconds(10))
                    .header("authorization", "Bearer " + getConfig().getString("key", "").trim())
                    .header("content-type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(gson.toJson(body)))
                    .build();
            HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() == 401) { fail("The hub rejected the key (401). Re-copy it into config.yml.", 300); return; }
            if (res.statusCode() == 429) { fail("The hub says slow down (429).", 60); return; }
            if (res.statusCode() != 200) { fail("The hub answered " + res.statusCode() + ".", 30); return; }
            failures = 0;
            lastStatus = "OK at " + java.time.LocalTime.now().withNano(0);
            JsonElement cmds = JsonParser.parseString(res.body()).getAsJsonObject().get("commands");
            if (cmds != null && cmds.isJsonArray() && cmds.getAsJsonArray().size() > 0) {
                final JsonArray list = cmds.getAsJsonArray();
                Bukkit.getScheduler().runTask(this, () -> run(list));
            }
        } catch (Exception e) {
            fail("Couldn't reach the hub: " + e.getClass().getSimpleName(), 30);
        }
    }

    private void fail(String msg, int minPauseSeconds) {
        failures++;
        long pause = Math.min(300, Math.max(minPauseSeconds, 5L * (1L << Math.min(failures, 6))));
        pauseUntil = System.currentTimeMillis() + pause * 1000;
        lastStatus = msg + " Retrying in " + pause + "s.";
        if (failures == 1 || failures % 10 == 0) getLogger().warning(lastStatus);
    }

    // Main thread. Each command is checked again here, then run as the console.
    private void run(JsonArray list) {
        for (JsonElement el : list) {
            JsonObject c = el.getAsJsonObject();
            long id = c.get("id").getAsLong();
            String cmd = c.get("cmd").getAsString();
            String result = allowed(cmd) ? "ok" : "refused";
            if (allowed(cmd)) {
                try { Bukkit.dispatchCommand(Bukkit.getConsoleSender(), cmd); } catch (Exception e) { result = "error"; }
            } else {
                getLogger().warning("Refused a command from the hub that isn't on the allowlist: " + cmd);
            }
            JsonObject ack = new JsonObject();
            ack.addProperty("id", id);
            ack.addProperty("result", result);
            done.add(ack);
        }
    }

    static boolean allowed(String cmd) {
        String[] v = cmd.split(" ", 3);
        if (v.length >= 2 && v[0].equals("say")) return SAY.matcher(cmd.substring(4)).matches();
        if (v.length == 2) return (v[0].equals("op") || v[0].equals("deop") || v[0].equals("kick")) && NAME.matcher(v[1]).matches();
        if (v.length == 3 && v[0].equals("whitelist")) return (v[1].equals("add") || v[1].equals("remove")) && NAME.matcher(v[2]).matches();
        return false;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (args.length > 0 && args[0].equalsIgnoreCase("reload")) {
            reloadConfig();
            sender.sendMessage("Config reloaded. Restart the server to change the push interval or key.");
            return true;
        }
        sender.sendMessage("Console Link: " + lastStatus);
        return true;
    }
}
