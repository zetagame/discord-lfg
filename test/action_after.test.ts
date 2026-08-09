import assert from "node:assert/strict";
import test from "node:test";
import { actionAfter } from "../src/action_after";

test("action-after retries twice after failures", async () => {
  let attempts = 0;
  const result = await actionAfter(
    "sync",
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("retry");
      return "ok";
    },
    { timeoutMs: 50, retries: 2 },
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

test("action-after aborts timed-out attempts and throws after retries", async () => {
  let attempts = 0;
  await assert.rejects(
    actionAfter(
      "sync",
      (signal) => new Promise<void>((_resolve, reject) => {
        attempts += 1;
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
      { timeoutMs: 5, retries: 2 },
    ),
    /sync failed after 3 attempts: sync timed out after 5ms/,
  );
  assert.equal(attempts, 3);
});
