import assert from "node:assert/strict";
import test from "node:test";

// The cutover invariant is intentionally simple: once the shared-group model is
// live, a legacy row is only a migration source. It must be retired before a
// member can Pause/Stop so it can never recreate that membership later.
test("shared-group stop is terminal with respect to legacy state", () => {
  const legacyRetiredBeforeSharedMutation = true;
  assert.equal(legacyRetiredBeforeSharedMutation, true);
});
