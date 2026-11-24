import { appendFileSync } from "node:fs";

const marker = "cross-framework-started.log";

if (process.env.NODE_TEST_CONTEXT !== undefined) {
  const { test } = await import("node:test");
  test("cross-framework test passes", () => {
    appendFileSync(marker, "node\n");
  });
} else {
  const { test } = await import("vitest");
  test("cross-framework test passes", () => {
    appendFileSync(marker, "vitest\n");
  });
}
