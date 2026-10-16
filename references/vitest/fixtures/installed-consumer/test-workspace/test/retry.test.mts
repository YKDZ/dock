import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

let attempts = 0;

describe("重试", () => {
  test("最终通过", () => {
    attempts += 1;
    expect(readFileSync("business.data", "utf8")).toBe("ready\n");
    if (attempts === 1) throw new Error("首次尝试失败，重试后通过");
  });
});
