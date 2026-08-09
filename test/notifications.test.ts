import assert from "node:assert/strict";
import test from "node:test";
import { effectiveNotificationAction, matchingListeners } from "../src/notifications";

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

type Row = { id: string; guild_id: string; user_id: string; game_id: string; action: "listen" | "unlisten"; created_at: string; expires_at?: string };

function fakeDb(rows: Row[]) {
  return {
    prepare: (_sql: string) => ({
      bind: (guildId: string, ...args: string[]) => ({
        all: async () => {
          const excluded = args.at(-1)!;
          const selectedGames = new Set(args.slice(0, -1));
          const now = Date.now();
          return {
            results: rows
              .filter((row) => row.guild_id === guildId && selectedGames.has(row.game_id) && row.user_id !== excluded)
              .filter((row) => !row.expires_at || new Date(row.expires_at).getTime() > now)
              .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id))
              .map(({ id, user_id, game_id, action, created_at }) => ({ id, user_id, game_id, action, created_at })),
          };
        },
      }),
    }),
  };
}

test("matchingListeners uses newest applicable instruction and deduplicates users", async () => {
  const listeners = await matchingListeners(fakeDb([
    { id: "1", guild_id: "g", user_id: "u1", game_id: "a", action: "listen", created_at: "2026-01-01T00:00:00.000Z" },
    { id: "2", guild_id: "g", user_id: "u1", game_id: "a", action: "unlisten", created_at: "2026-01-01T01:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z" },
    { id: "3", guild_id: "g", user_id: "u2", game_id: "a", action: "listen", created_at: "2026-01-01T02:00:00.000Z" },
    { id: "4", guild_id: "g", user_id: "u2", game_id: "b", action: "listen", created_at: "2026-01-01T03:00:00.000Z" },
    { id: "5", guild_id: "g", user_id: "u3", game_id: "a", action: "listen", created_at: "2026-01-01T03:00:00.000Z" },
  ]) as unknown as D1Database, "g", ["a", "b"], "u3");
  assert.deepEqual(listeners, ["u2"]);
});

test("matchingListeners ignores expired temporary overrides and effective unlisten", async () => {
  const listeners = await matchingListeners(fakeDb([
    { id: "1", guild_id: "g", user_id: "u1", game_id: "a", action: "listen", created_at: "2026-01-01T00:00:00.000Z" },
    { id: "2", guild_id: "g", user_id: "u1", game_id: "a", action: "unlisten", created_at: "2026-01-01T01:00:00.000Z", expires_at: "2020-01-01T00:00:00.000Z" },
    { id: "3", guild_id: "g", user_id: "u2", game_id: "a", action: "listen", created_at: "2026-01-01T00:00:00.000Z" },
    { id: "4", guild_id: "g", user_id: "u2", game_id: "a", action: "unlisten", created_at: "2026-01-01T01:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z" },
  ]) as unknown as D1Database, "g", ["a"], "none");
  assert.deepEqual(listeners, ["u1"]);
});
