import assert from "node:assert/strict";
import test from "node:test";
import { lfgState, type LfgRecord } from "../src/lfg";

const base: LfgRecord = {
  id: "lfg",
  guildId: "guild",
  channelId: "channel",
  authorId: "user",
  expiresAt: "2026-08-09T12:00:00.000Z",
};

const beforeExpiry = new Date("2026-08-09T11:00:00.000Z").getTime();

test("active LFG is available", () => {
  assert.equal(lfgState(base, beforeExpiry), "active");
});

test("pause changes active LFG state without changing expiry", () => {
  const paused = { ...base, pausedAt: "2026-08-09T10:30:00.000Z" };
  assert.equal(lfgState(paused, beforeExpiry), "paused");
  assert.equal(paused.expiresAt, base.expiresAt);
});

test("stopped state wins over paused state", () => {
  assert.equal(lfgState({
    ...base,
    pausedAt: "2026-08-09T10:30:00.000Z",
    stoppedAt: "2026-08-09T10:45:00.000Z",
  }, beforeExpiry), "stopped");
});

test("window expires even while paused", () => {
  assert.equal(lfgState({ ...base, pausedAt: "2026-08-09T10:30:00.000Z" }, new Date("2026-08-09T12:00:00.000Z").getTime()), "expired");
});
