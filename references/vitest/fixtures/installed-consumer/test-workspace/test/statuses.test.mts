import { describe, test } from "vitest";

describe("状态", () => {
  test.skip("跳过", () => {});
  test.todo("待实现");
  test("主动跳过", (context) => {
    context.skip("运行时主动跳过");
  });
});
