import { defineVitestObservation } from "@boringparts/dock/vitest";
import { afterEach, test } from "vitest";

const value = defineVitestObservation("earlier-value", "sample");
let attempts = 0;

afterEach(() => {
  throw new Error("teardown fails after every test callback");
});

test("business test failing in teardown", () => {
  attempts += 1;
  if (attempts === 1) value.record("early passing business result");
});
