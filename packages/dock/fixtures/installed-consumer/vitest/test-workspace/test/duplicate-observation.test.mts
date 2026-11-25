import { defineVitestObservation } from "@ykdz/dock/vitest";
import { test } from "vitest";

const value = defineVitestObservation("duplicate-value", "sample");

test("duplicate identical observation", () => {
  value.record("same");
  value.record("same");
});
