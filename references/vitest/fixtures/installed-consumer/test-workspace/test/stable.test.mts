import { readFileSync } from "node:fs";

import { expect, test } from "vitest";

test("正常通过", () => {
  expect(readFileSync("business.data", "utf8")).toBe("ready\n");
});
