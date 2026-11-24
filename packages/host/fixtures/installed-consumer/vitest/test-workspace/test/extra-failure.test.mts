import { describe, test } from "vitest";

describe("retry", () => {
  test("finally passes", () => {
    throw new Error("same-named undeclared additional test failed");
  });
});
