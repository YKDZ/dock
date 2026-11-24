import { test } from "vitest";

test("passes before error", () => {
  void Promise.reject(new Error("Vitest unhandled promise rejection"));
});
