import { describe, test } from "vitest";

describe("shared teardown", () => {
  test("selected status", () => {
    throw new Error("unrelated pure assertion failure");
  });
});
