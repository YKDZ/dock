import assert from "node:assert/strict";
import { test } from "node:test";

import { beginExecution } from "@ykdz/dock/node-test";

test("selected business assertion fails", () => {
  beginExecution();
  assert.equal("actual implementation", "expected implementation");
});

test("independent business assertion passes", () => {
  beginExecution();
  assert.equal(6 * 7, 42);
});
