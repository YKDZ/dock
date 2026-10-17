import { expect, test } from "vitest";

test("配置通过", () => {
  expect(process.env.DOCK_USER_SETUP).toBe("ready");
});

test("范围外测试", () => {
  throw new Error("范围外测试不应由本次 Vitest 筛选启动。");
});
