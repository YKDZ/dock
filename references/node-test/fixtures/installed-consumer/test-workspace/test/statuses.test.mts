import assert from "node:assert/strict";
import { test } from "node:test";

test("跳过的业务状态", { skip: "等待上线" }, () => {
  assert.fail("跳过的用例不应进入回调");
});

test("待办的业务状态", { todo: "尚未实现" }, () => {
  assert.ok(false);
});
