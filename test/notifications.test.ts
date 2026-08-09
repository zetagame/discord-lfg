import assert from "node:assert/strict";
import test from "node:test";
import { effectiveNotificationAction } from "../src/notifications";

const at = (value: string) => new Date(`2026-01-01T${value}Z`);

test("newest applicable instruction wins and expiry reveals prior state", () => {
  const actions = [
    { action: "listen" as const, createdAt: at("00:00") },
    { action: "unlisten" as const, createdAt: at("01:00"), expiresAt: at("05:00") },
    { action: "listen" as const, createdAt: at("02:00"), expiresAt: at("03:00") },
  ];
  assert.equal(effectiveNotificationAction(actions, at("02:30")), "listen");
  assert.equal(effectiveNotificationAction(actions, at("04:00")), "unlisten");
  assert.equal(effectiveNotificationAction(actions, at("06:00")), "listen");
});

test("temporary listen overrides an older unlisten", () => {
  assert.equal(effectiveNotificationAction([
    { action: "unlisten", createdAt: at("00:00") },
    { action: "listen", createdAt: at("01:00"), expiresAt: at("02:00") },
  ], at("01:30")), "listen");
});

test("mute and unlisten use the same instruction action", () => {
  const unlisten = { action: "unlisten" as const, createdAt: at("00:00") };
  const mute = { action: "unlisten" as const, createdAt: at("00:00") };
  assert.deepEqual(mute, unlisten);
});

test("different games retain independent instruction histories", () => {
  const histories = new Map([
    ["peak", [{ action: "listen" as const, createdAt: at("00:00") }]],
    ["other", [{ action: "unlisten" as const, createdAt: at("00:00") }]],
  ]);
  assert.equal(effectiveNotificationAction(histories.get("peak")!, at("01:00")), "listen");
  assert.equal(effectiveNotificationAction(histories.get("other")!, at("01:00")), "unlisten");
});
