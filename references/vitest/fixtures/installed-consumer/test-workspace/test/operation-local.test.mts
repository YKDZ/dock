import { readFileSync, writeFileSync } from "node:fs";

import { expect, test } from "vitest";

test("每次维护都重新执行", () => {
  let contents = "";
  try {
    contents = readFileSync("operation-count.txt", "utf8");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  writeFileSync("operation-count.txt", `${contents}x`);
  expect(true).toBe(true);
});
