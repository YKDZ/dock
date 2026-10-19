import { defineVitestObservation } from "@ykdz/dock-reference-vitest";
import { expect, test } from "vitest";

const value = defineVitestObservation("multi-file-value", "");

test("第一文件观察", () => {
  expect(value.record("first")).toBe("first");
});
