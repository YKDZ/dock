import { test } from "node:test";

import { beginExecution } from "@ykdz/dock-reference-node-test";

test("父级失败", () => {
  test("已进入回调的子测试", async () => {
    beginExecution();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  test("未进入回调的子测试", () => {
    beginExecution();
  });
  throw new Error("父级在子测试结束前失败");
});
