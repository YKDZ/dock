import assert from "node:assert/strict";
import { test } from "node:test";

import { beginExecution } from "@ykdz/dock-reference-node-test";

test("应被名称筛选排除", () => {
  beginExecution();
  assert.ok(false, "已排除的业务测试不应执行");
});

test("筛选保留的业务测试", () => {
  beginExecution();
  assert.ok(true);
});
