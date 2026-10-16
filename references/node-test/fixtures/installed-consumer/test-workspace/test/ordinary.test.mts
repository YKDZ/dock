import assert from "node:assert/strict";
import { test } from "node:test";

test("普通 Node 原生命令保持原有业务语义", () => {
  assert.equal("普通测试", "普通测试");
});
