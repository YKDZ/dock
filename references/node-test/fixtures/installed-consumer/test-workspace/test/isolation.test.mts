import assert from "node:assert/strict";
import { test } from "node:test";

import { beginExecution } from "@dock/reference-node-test";

test("选定业务断言失败", () => {
  beginExecution();
  assert.equal("当前实现", "预期实现");
});

test("独立业务断言通过", () => {
  beginExecution();
  assert.equal(6 * 7, 42);
});
