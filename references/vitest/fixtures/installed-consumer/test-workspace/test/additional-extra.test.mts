import { appendFileSync } from "node:fs";

import { test } from "vitest";

test("不同标题的附加测试", () => {
  appendFileSync("additional-test.marker", "额外测试已执行\n");
  throw new Error("附加测试的无关纯断言失败");
});
