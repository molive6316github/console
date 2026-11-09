import { test } from "node:test";
import assert from "node:assert/strict";
import { scan } from "../src/mc/connfail.js";

test("connfail: real server-side join errors are caught, normal disconnects are not", () => {
  const bad = scan([
    "[19:10:01 INFO]: Steve lost connection: Internal Exception: io.netty.handler.codec.DecoderException: java.lang.NullPointerException",
    "[19:10:02 ERROR]: Could not pass event PlayerJoinEvent to Essentials v2.21",
    "[19:10:03 WARN]: Failed to verify username! Alex",
  ].join("\n"));
  assert.deepEqual(bad.map((b) => [b.kind, b.player, b.plugin]), [["error", "Steve", null], ["error", null, "Essentials"], ["auth", "Alex", null]]);
  const fine = scan([
    "[19:11:00 INFO]: Steve lost connection: Disconnected",
    "[19:11:01 INFO]: Steve lost connection: Timed out",
    "[19:11:02 INFO]: Alex left the game",
    "[19:11:03 INFO]: Disconnecting Bob: You are not whitelisted on this server!",
    "[19:11:04 INFO]: Done (5s)!",
  ].join("\n"));
  assert.deepEqual(fine, []);
});
