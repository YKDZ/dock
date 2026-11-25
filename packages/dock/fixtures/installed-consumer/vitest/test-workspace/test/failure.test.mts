import { test } from "vitest";

test("selected failure", () => {
  throw new Error("selected business assertion failed");
});
