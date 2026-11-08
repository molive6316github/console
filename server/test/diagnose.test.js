import { test } from "node:test";
import assert from "node:assert/strict";
import { LOG_CLUES } from "../src/mc/diagnose.js";

test("diagnose: log clues map real crash text to plain advice", () => {
  const say = (t) => LOG_CLUES.filter((c) => c.re.test(t)).map((c) => c.say).join(" ");
  assert.match(say("[ERROR] You need to agree to the EULA in order to run the server."), /EULA/);
  assert.match(say("java.net.BindException: Address already in use"), /game port/);
  assert.match(say("java.lang.OutOfMemoryError: Java heap space"), /memory/);
  assert.match(say("UnsupportedClassVersionError: class file version 69.0"), /Java/);
  assert.match(say("Error: Invalid or corrupt jarfile server.jar"), /server\.jar/);
  assert.equal(say("[INFO]: Done (27.5s)!"), "");
});
