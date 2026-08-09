import assert from "node:assert/strict";
import test from "node:test";
import { dueDeliveries, fireRsvpTrigger, minimumPlayersCheckDue, parseRsvpTrigger } from "../src/events";

test("scheduled delivery targets RSVP statuses correctly around start time", () => {
  const start = new Date("2026-01-01T12:00:00.000Z");
  assert.deepEqual(dueDeliveries(start, "yes", new Date("2026-01-01T10:59:59.000Z")), []);
  assert.deepEqual(dueDeliveries(start, "yes", new Date("2026-01-01T11:00:00.000Z")), ["reminder"]);
  assert.deepEqual(dueDeliveries(start, "maybe", new Date("2026-01-01T11:30:00.000Z")), ["reminder"]);
  assert.deepEqual(dueDeliveries(start, "maybe", new Date("2026-01-01T12:00:00.000Z")), []);
  assert.deepEqual(dueDeliveries(start, "yes", new Date("2026-01-01T12:00:00.000Z")), ["start"]);
  assert.deepEqual(dueDeliveries(start, "yes", new Date("2026-01-01T13:00:00.000Z")), ["start"]);
  assert.deepEqual(dueDeliveries(start, "maybe", new Date("2026-01-01T13:00:00.000Z")), []);
  assert.deepEqual(dueDeliveries(start, "no", new Date("2026-01-01T12:00:00.000Z")), []);
});

test("minimum-player check opens only in the last 30 minutes", () => {
  const start = new Date("2026-01-01T12:00:00.000Z");
  assert.equal(minimumPlayersCheckDue(start, new Date("2026-01-01T11:29:59.000Z")), false);
  assert.equal(minimumPlayersCheckDue(start, new Date("2026-01-01T11:30:00.000Z")), true);
  assert.equal(minimumPlayersCheckDue(start, new Date("2026-01-01T11:59:59.000Z")), true);
  assert.equal(minimumPlayersCheckDue(start, start), false);
});

test("RSVP trigger parser accepts common wording without accepting unsupported presence triggers", () => {
  assert.deepEqual(parseRsvpTrigger("3 yes RSVPs"), { type: "yes_rsvps", threshold: 3 });
  assert.deepEqual(parseRsvpTrigger("3 players"), { type: "yes_rsvps", threshold: 3 });
  assert.deepEqual(parseRsvpTrigger("4 yes or maybe"), { type: "yes-or-maybe_rsvps", threshold: 4 });
  assert.deepEqual(parseRsvpTrigger("4 yes-or-maybe RSVPs"), { type: "yes-or-maybe_rsvps", threshold: 4 });
  assert.equal(parseRsvpTrigger("3 people online"), undefined);
});

function triggerDb(type: "yes_rsvps" | "yes-or-maybe_rsvps", count: number) {
  let fired = false;
  let activations = 0;
  return {
    state: () => ({ fired, activations }),
    prepare(sql: string) {
      const statement = sql.trimStart();
      return {
        bind: () => ({
          first: async () => {
            if (statement.startsWith("SELECT type")) return { type, threshold: 2, fired_at: fired ? "2026-01-01T00:00:00.000Z" : undefined };
            return { count };
          },
          run: async () => {
            if (statement.startsWith("UPDATE")) {
              if (fired) return { meta: { changes: 0 } };
              fired = true;
              return { meta: { changes: 1 } };
            }
            activations++;
            return { meta: { changes: 1 } };
          },
        }),
      };
    },
  };
}

test("RSVP triggers activate once for Yes and Yes-or-Maybe thresholds", async () => {
  for (const type of ["yes_rsvps", "yes-or-maybe_rsvps"] as const) {
    const db = triggerDb(type, 2);
    assert.equal(await fireRsvpTrigger(db as unknown as D1Database, "event"), true);
    assert.equal(await fireRsvpTrigger(db as unknown as D1Database, "event"), false);
    assert.deepEqual(db.state(), { fired: true, activations: 1 });
  }
});
