import { appendFileSync } from "node:fs";

const marker = "cross-framework-started.log";

if (process.env.NODE_TEST_CONTEXT !== undefined) {
  const { test } = await import("node:test");
  test("跨框架测试通过", () => {
    appendFileSync(marker, "node\n");
  });
} else {
  const { test } = await import("vitest");
  test("跨框架测试通过", () => {
    appendFileSync(marker, "vitest\n");
  });
}
