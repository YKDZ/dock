import { describe, expect, test } from "vitest";

import { settings } from "../groups.observations.mts";

describe("outer", () => {
  describe("nested > child", () => {
    test("same", () => {
      settings.record({ mode: "flat path", revision: 1 });
      expect(true).toBe(true);
    });
  });

  describe("nested", () => {
    describe("child", () => {
      test("same", () => {
        settings.record({ mode: "nested path", revision: 2 });
        expect(true).toBe(true);
      });
    });
  });
});
