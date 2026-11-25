import { appendFileSync } from "node:fs";

import { describe, test } from "vitest";

describe("chosen", () => {
  test("one", () => {});
});

describe("CHOSEN", () => {
  test("one", () => {
    const marker = process.env.DOCK_VITEST_CASE_EXTRA_MARKER;
    if (marker !== undefined) appendFileSync(marker, "ran\n");
  });
});
