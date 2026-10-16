import { existsSync, writeFileSync } from "node:fs";

import { afterAll, describe, expect, test } from "vitest";

import { settings, steps } from "../groups.observations.mts";

const variant = process.env.DOCK_VITEST_GROUP_VARIANT ?? "baseline";

afterAll(() => {
  const marker = process.env.DOCK_VITEST_GROUP_MARKER;
  if (
    process.env.DOCK_VITEST_GROUP_POISON === "1" &&
    marker !== undefined &&
    existsSync(marker)
  ) {
    throw new Error(`不应执行的附加测试留下了标记：${marker}`);
  }
});

describe("preview config", () => {
  describe("inner > label", () => {
    test(variant === "renamed" ? "primary renamed" : "primary", () => {
      settings.record({
        mode: "auto",
        revision: variant === "changed" ? 2 : 1,
      });
      steps.record(["parse", "render"]);
      expect(true).toBe(true);
    });

    test("secondary", () => {
      settings.record({ mode: "manual", revision: 3 });
      steps.record(["parse"]);
      expect(true).toBe(true);
    });
  });

  describe("other nested", () => {
    test("primary", () => {
      settings.record({ mode: "manual", revision: 5 });
      steps.record(["parse"]);
      expect(true).toBe(true);
    });
  });

  test("outside group", () => {
    settings.record({ mode: "outside", revision: 4 });
    steps.record(["parse", "render"]);
    expect(true).toBe(true);
  });
});

describe("empty config", () => {});

test("extra marker", () => {
  const marker = process.env.DOCK_VITEST_GROUP_MARKER;
  if (marker !== undefined) writeFileSync(marker, "ran\n");
  expect(true).toBe(true);
});
