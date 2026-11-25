import { test } from "vitest";

test("before abnormal exit", () => {
  process.exit(2);
});
