import { defineVitestObservation } from "@ykdz/dock-reference-vitest";
import { expect, test } from "vitest";

const value = defineVitestObservation("multi-file-value", "");

test("第二文件观察", () => {
  expect(value.record("second")).toBe("second");
});
