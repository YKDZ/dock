import { defineVitestObservation } from "@ykdz/dock-reference-vitest";
import { test } from "vitest";

const value = defineVitestObservation("duplicate-value", "sample");

test("重复同值观察", () => {
  value.record("same");
  value.record("same");
});
