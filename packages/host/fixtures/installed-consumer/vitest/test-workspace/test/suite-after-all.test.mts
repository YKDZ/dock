import { appendFileSync } from "node:fs";

import { afterAll, describe, expect, test } from "vitest";

describe("shared teardown", () => {
  afterAll(() => {
    appendFileSync("suite-after-all.marker", "teardown executed\n");
    throw new Error("nested afterAll failed");
  });

  test("selected status", () => {
    expect(true).toBe(true);
  });
});
