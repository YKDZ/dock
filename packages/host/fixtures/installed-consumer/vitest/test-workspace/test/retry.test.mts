import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

let attempts = 0;

describe("retry", () => {
  test("finally passes", () => {
    attempts += 1;
    expect(readFileSync("business.data", "utf8")).toBe("ready\n");
    if (attempts === 1) {
      throw new Error("first attempt failed, passes on retry");
    }
  });
});
