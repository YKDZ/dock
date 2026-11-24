import { expect, test } from "vitest";

test("config passed", () => {
  expect(process.env.DOCK_USER_SETUP).toBe("ready");
});

test("out of scope test", () => {
  throw new Error(
    "Out-of-scope test should not be started by this Vitest filter.",
  );
});
