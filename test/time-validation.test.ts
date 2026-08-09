import assert from "node:assert/strict";
import test from "node:test";
import { parseWhen } from "../src/time";

const now = new Date("2026-08-09T17:00:00.000Z");

test("clock inputs reject invalid hours and minutes", () => {
  assert.equal(parseWhen("tomorrow at 9:99pm", "America/New_York", now), undefined);
  assert.equal(parseWhen("tomorrow at 13:30pm", "America/New_York", now), undefined);
  assert.equal(parseWhen("2026-08-10 20:99", "America/New_York", now), undefined);
  assert.equal(parseWhen("2026-08-10 24:00", "America/New_York", now), undefined);
  assert.equal(parseWhen("until 10:99pm", "America/New_York", now), undefined);
  assert.equal(parseWhen("until 25:00", "America/New_York", now), undefined);
});

test("scheduled clock inputs reject nonexistent DST-gap times", () => {
  const beforeSpringForward = new Date("2026-03-07T17:00:00.000Z");
  assert.equal(parseWhen("tomorrow at 2:30am", "America/New_York", beforeSpringForward), undefined);
  assert.equal(parseWhen("2026-03-08 02:30", "America/New_York", beforeSpringForward), undefined);
});

test("absolute scheduled timestamps reject invalid calendar dates", () => {
  assert.equal(parseWhen("2026-02-30 20:00", "America/New_York", now), undefined);
});
