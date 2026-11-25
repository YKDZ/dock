import assert from "node:assert/strict";
import { test } from "node:test";

import { beginExecution } from "@ykdz/dock/node-test";

test("duplicate business identity", () => {
  beginExecution();
  assert.equal(1, 1);
});

test("duplicate business identity", () => {
  beginExecution();
  assert.equal(2, 2);
});
