import { appendFileSync } from "node:fs";

import { afterAll, describe, expect, test } from "vitest";

describe("共同收尾", () => {
  afterAll(() => {
    appendFileSync("suite-after-all.marker", "收尾已执行\n");
    throw new Error("嵌套 afterAll 失败");
  });

  test("选定状态", () => {
    expect(true).toBe(true);
  });
});
