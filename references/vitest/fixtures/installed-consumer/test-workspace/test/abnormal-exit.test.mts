import { test } from "vitest";

test("异常退出前", () => {
  process.exit(2);
});
