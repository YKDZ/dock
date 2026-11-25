import { describe, test } from "vitest";

describe("statuses", () => {
  test.skip("skipped", () => {});
  test.todo("todo");
  test("dynamically skipped", (context) => {
    context.skip("skipped dynamically at runtime");
  });
});
