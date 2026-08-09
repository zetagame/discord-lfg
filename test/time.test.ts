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
  assert.equal(parseDuration("2h", "America/New_York", now)?.toISOString(), "2026-01-01T02:00:00.000Z");
});

test("calendar durations use the effective timezone across DST", () => {
  const now = new Date("2026-03-08T04:00:00.000Z"); // March 7, 11pm in New York
  assert.equal(parseDuration("today", "America/New_York", now)?.toISOString(), "2026-03-08T04:59:59.999Z");
  assert.equal(parseDuration("tonight", "America/New_York", now)?.toISOString(), "2026-03-08T04:59:59.999Z");
  assert.equal(parseDuration("tomorrow", "America/New_York", now)?.toISOString(), "2026-03-09T03:59:59.999Z");
  assert.equal(parseWhen("until 10pm", "America/New_York", now)?.toISOString(), "2026-03-09T02:00:00.000Z");
});

test("tonight remains near-term in afternoon, late evening, and around midnight", () => {
  assert.equal(
    parseDuration("tonight", "America/New_York", new Date("2026-01-01T20:00:00.000Z"))?.toISOString(), // 3:00pm local
    "2026-01-02T04:59:59.999Z",
  );
  assert.equal(
    parseDuration("tonight", "America/New_York", new Date("2026-01-02T03:30:00.000Z"))?.toISOString(), // 10:30pm local
    "2026-01-02T04:59:59.999Z",
  );
  assert.equal(
    parseDuration("tonight", "America/New_York", new Date("2026-01-02T05:30:00.000Z"))?.toISOString(), // 12:30am local
    "2026-01-02T08:00:00.000Z",
  );
});

test("this weekend ends Sunday night in local timezone", () => {
  assert.equal(
    parseDuration("this weekend", "America/New_York", new Date("2026-01-02T17:00:00.000Z"))?.toISOString(), // Friday noon local
    "2026-01-05T04:59:59.999Z",
  );
  assert.equal(
    parseDuration("this weekend", "America/New_York", new Date("2026-01-03T17:00:00.000Z"))?.toISOString(), // Saturday noon local
    "2026-01-05T04:59:59.999Z",
  );
  assert.equal(
    parseDuration("this weekend", "America/New_York", new Date("2026-01-04T17:00:00.000Z"))?.toISOString(), // Sunday noon local
    "2026-01-05T04:59:59.999Z",
  );
});
