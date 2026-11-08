import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, getSetting, setSetting } from "../src/db.js";
import { seedSettings } from "../src/seed.js";

test("seeding fills empty settings, rejects bad values, and never overwrites", () => {
  const db = openDb(":memory:");
  setSetting(db, "github_org", "KeepMe");
  const applied = seedSettings(db, {
    CONSOLE_GITHUB_TOKEN: "ghp_abc123", CONSOLE_GITHUB_ORG: "Other", CONSOLE_TIMEZONE: "America/New_York",
    CONSOLE_ALERT_WEBHOOK: "http://insecure.example/x", CONSOLE_BACKUP_KEEP: "99", CONSOLE_ENABLE_TERMINAL: "1", CONSOLE_ENABLE_LINUX_USERS: "yes",
  });
  assert.deepEqual(applied.sort(), ["github_token", "terminal_enabled", "timezone"]);
  assert.equal(getSetting(db, "github_token"), "ghp_abc123");
  assert.equal(getSetting(db, "github_org"), "KeepMe");
  assert.equal(getSetting(db, "alert_webhook", ""), "");
  assert.equal(getSetting(db, "backup_keep", ""), "");
  assert.equal(getSetting(db, "terminal_enabled"), "1");
  assert.equal(getSetting(db, "linux_users_enabled", "0"), "0");
  assert.deepEqual(seedSettings(db, { CONSOLE_GITHUB_TOKEN: "ghp_new" }), [], "second run changes nothing");
  assert.equal(getSetting(db, "github_token"), "ghp_abc123");
});
