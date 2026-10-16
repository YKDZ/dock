import { test } from "vitest";

test("错误前通过", () => {
  void Promise.reject(new Error("Vitest 未处理的 Promise 拒绝"));
});
