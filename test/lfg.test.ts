import assert from "node:assert/strict";
import test from "node:test";
import { groupMemberState, type GroupMember } from "../src/lfg";

const base: GroupMember = {
  userId: "user",
  expiresAt: "2026-08-09T12:00:00.000Z",
};

const beforeExpiry = new Date("2026-08-09T11:00:00.000Z").getTime();

test("active member is in the group", () => {
  assert.equal(groupMemberState(base, beforeExpiry), "active");
});

test("paused member is not active and keeps the same expiry", () => {
  const paused = { ...base, pausedAt: "2026-08-09T10:30:00.000Z" };
  assert.equal(groupMemberState(paused, beforeExpiry), "paused");
  assert.equal(paused.expiresAt, base.expiresAt);
});

test("membership expires even while paused", () => {
  assert.equal(
    groupMemberState({ ...base, pausedAt: "2026-08-09T10:30:00.000Z" }, new Date("2026-08-09T12:00:00.000Z").getTime()),
    "expired",
  );
});

test("missing membership is not in the group", () => {
  assert.equal(groupMemberState(undefined, beforeExpiry), "missing");
});
