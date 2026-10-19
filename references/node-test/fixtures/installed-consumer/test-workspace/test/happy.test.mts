import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import { beginExecution } from "@ykdz/dock-reference-node-test";

test("主要业务状态符合约定", () => {
  beginExecution();
  assert.equal(process.cwd(), resolve(import.meta.dirname, "../.."));
  assert.equal(2 + 2, 4);
});

test("辅助业务状态符合约定", () => {
  beginExecution();
  assert.deepEqual({ 已提交: true }, { 已提交: true });
});
