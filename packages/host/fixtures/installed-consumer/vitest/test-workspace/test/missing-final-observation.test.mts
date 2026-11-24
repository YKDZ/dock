import { defineConfig, file } from "@ykdz/dock";
import {
  defineVitestObservation,
  readReferenceInTest,
} from "@ykdz/dock/vitest";
import { expect, test } from "vitest";

const value = defineVitestObservation("retry-value", "sample");
const config = defineConfig({ plugins: [file], bindings: [] });
const source = file.from("read-target.txt").reference("retry-source");
let attempts = 0;

test("final pass missing observation", async () => {
  attempts += 1;
  const result = await readReferenceInTest(config, source);
  expect(result.value).not.toBe("");
  if (attempts === 1) {
    value.record("earlier-attempt");
    throw new Error("failed after first attempt read and record");
  }
});
