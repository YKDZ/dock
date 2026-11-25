import { defineVitestObservation } from "@boringparts/dock/vitest";
import { expect, test } from "vitest";

const value = defineVitestObservation("multi-file-value", "");

test("second file observation", () => {
  expect(value.record("second")).toBe("second");
});
