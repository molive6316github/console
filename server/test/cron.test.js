import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCron, matches, partsIn, nextRun, validTimezone } from "../src/cron.js";

const at = (iso, tz = "UTC") => partsIn(new Date(iso), tz);
const fires = (expr, iso, tz) => matches(parseCron(expr), at(iso, tz));

test("basic fields, lists, ranges and steps", () => {
  assert.ok(fires("0 4 * * *", "2026-01-05T04:00:00Z"));
  assert.ok(!fires("0 4 * * *", "2026-01-05T04:01:00Z"));
  assert.ok(fires("*/15 * * * *", "2026-01-05T10:45:00Z"));
  assert.ok(!fires("*/15 * * * *", "2026-01-05T10:46:00Z"));
  assert.ok(fires("0 9-17/4 * * *", "2026-01-05T13:00:00Z")); // 9, 13, 17
  assert.ok(!fires("0 9-17/4 * * *", "2026-01-05T12:00:00Z"));
  assert.ok(fires("5,10 * * * *", "2026-01-05T00:10:00Z"));
});

test("day of week: 0 and 7 are both Sunday; Monday is 1", () => {
  assert.ok(fires("0 0 * * 0", "2026-01-04T00:00:00Z")); // a Sunday
  assert.ok(fires("0 0 * * 7", "2026-01-04T00:00:00Z"));
  assert.ok(fires("0 0 * * 1", "2026-01-05T00:00:00Z"));
  assert.ok(!fires("0 0 * * 1", "2026-01-06T00:00:00Z"));
});

test("when both day-of-month and day-of-week are set, either is enough (classic cron)", () => {
  assert.ok(fires("0 0 13 * 5", "2026-02-13T00:00:00Z")); // Fri the 13th: both
  assert.ok(fires("0 0 13 * 5", "2026-02-06T00:00:00Z")); // a Friday, not the 13th
  assert.ok(fires("0 0 13 * 5", "2026-03-13T00:00:00Z")); // the 13th (a Friday again), fine either way
  assert.ok(!fires("0 0 13 * 5", "2026-02-07T00:00:00Z")); // Saturday the 7th: neither
});

test("times are read in the chosen time zone, including across daylight saving", () => {
  // 04:00 in New York is 09:00 UTC in January (EST) and 08:00 UTC in July (EDT)
  assert.ok(fires("0 4 * * *", "2026-01-15T09:00:00Z", "America/New_York"));
  assert.ok(!fires("0 4 * * *", "2026-01-15T08:00:00Z", "America/New_York"));
  assert.ok(fires("0 4 * * *", "2026-07-15T08:00:00Z", "America/New_York"));
  assert.ok(fires("0 0 * * *", "2026-07-15T04:00:00Z", "America/New_York")); // midnight must be hour 0, not 24
});

test("bad schedules are rejected with a useful message", () => {
  for (const bad of ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "a * * * *", "*/0 * * * *", "5-2 * * * *", "1 - 3 * * *"]) {
    assert.throws(() => parseCron(bad), Error, `should reject "${bad}"`);
  }
  assert.throws(() => parseCron(null), /required/);
});

test("nextRun finds the next minute that fires", () => {
  const from = Date.parse("2026-01-05T03:59:30Z");
  assert.equal(new Date(nextRun("0 4 * * *", "UTC", from)).toISOString(), "2026-01-05T04:00:00.000Z");
  assert.equal(new Date(nextRun("0 4 * * *", "UTC", Date.parse("2026-01-05T04:00:00Z"))).toISOString(), "2026-01-06T04:00:00.000Z");
  assert.equal(nextRun("0 0 31 2 *", "UTC", from), null); // Feb 31st never happens
});

test("time zone validation", () => {
  assert.ok(validTimezone("America/New_York"));
  assert.ok(validTimezone("UTC"));
  assert.ok(!validTimezone("Mars/Olympus"));
  assert.ok(!validTimezone("; rm -rf /"));
});
