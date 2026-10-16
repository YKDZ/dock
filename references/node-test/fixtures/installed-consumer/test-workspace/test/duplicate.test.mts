import assert from "node:assert/strict";
import { test } from "node:test";

import { beginExecution } from "@dock/reference-node-test";

test("重复业务身份", () => {
  beginExecution();
  assert.equal(1, 1);
});

test("重复业务身份", () => {
  beginExecution();
  assert.equal(2, 2);
});
