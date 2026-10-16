import { describe, test } from "vitest";

describe("重试", () => {
  test("最终通过", () => {
    throw new Error("同名但未声明的附加测试失败");
  });
});
