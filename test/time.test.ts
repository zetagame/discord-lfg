import assert from "node:assert/strict";
import test from "node:test";
import { effectiveTimeZone, parseDuration, parseWhen } from "../src/time";

test("default timezone is America/New_York and explicit IANA timezone is retained", () => {
  assert.equal(effectiveTimeZone(), "America/New_York");
  assert.equal(effectiveTimeZone("Europe/London"), "Europe/London");
});

test("scheduled local time is stored as UTC", () => {
  assert.equal(parseWhen("2026-01-15 20:00", "America/New_York")?.toISOString(), "2026-01-16T01:00:00.000Z");
});

test("lfg default duration is two hours when supplied by caller", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  assert.equal(new Date(now.getTime() + 2 * 3_600_000).toISOString(), "2026-01-01T02:00:00.000Z");
  assert.equal(parseDuration("2h", now)?.toISOString(), "2026-01-01T02:00:00.000Z");
});
