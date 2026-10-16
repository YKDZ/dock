import { test } from "vitest";

test("被选中的失败", () => {
  throw new Error("选中的业务断言失败");
});
