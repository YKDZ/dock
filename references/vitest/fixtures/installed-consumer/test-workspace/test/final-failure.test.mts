import { defineVitestObservation } from "@ykdz/dock-reference-vitest";
import { afterEach, test } from "vitest";

const value = defineVitestObservation("earlier-value", "sample");
let attempts = 0;

afterEach(() => {
  throw new Error("每次业务回调后的收尾均失败");
});

test("收尾失败的业务测试", () => {
  attempts += 1;
  if (attempts === 1) value.record("早期成功的业务结果");
});
