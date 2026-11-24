import { readFileSync, writeFileSync } from "node:fs";

import { expect, test } from "vitest";

test("re-executed on every maintenance", () => {
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
