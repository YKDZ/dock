import { describe, expect, test } from "vitest";

import { settings } from "../groups.observations.mts";

const scenario = process.env.DOCK_VITEST_GROUP_SCENARIO ?? "members";

describe("failure suite", () => {
  test.skip("skipped", () => {});
  test.todo("todo");
  test("missing observation", () => {
    expect(true).toBe(true);
  });
  test("duplicate observation", () => {
    settings.record({ mode: "auto", revision: 1 });
    settings.record({ mode: "auto", revision: 2 });
    expect(true).toBe(true);
  });
  test("filtered", () => {
    settings.record({ mode: "auto", revision: 1 });
    expect(true).toBe(true);
  });
});

describe("collection failure", () => {
  if (scenario === "collection-error") {
    throw new Error("suite collection failed");
  }
  test("otherwise passes", () => {
    settings.record({ mode: "auto", revision: 1 });
    expect(true).toBe(true);
  });
});
