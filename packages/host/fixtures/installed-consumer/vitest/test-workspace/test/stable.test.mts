import { readFileSync } from "node:fs";

import { expect, test } from "vitest";

test("passes normally", () => {
  expect(readFileSync("business.data", "utf8")).toBe("ready\n");
});
