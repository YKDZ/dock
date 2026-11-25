import { defineVitestObservation } from "@ykdz/dock/vitest";
import { expect, test } from "vitest";

const value = defineVitestObservation("multi-file-value", "");

test("first file observation", () => {
  expect(value.record("first")).toBe("first");
});
