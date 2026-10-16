import assert from "node:assert/strict";
import { test } from "node:test";

test("普通 Node 测试失败仍返回失败退出码", () => {
  assert.equal(1 + 1, 3);
});
