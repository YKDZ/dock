import { defineConfig, file } from "@ykdz/dock";
import {
  defineVitestObservation,
  readReferenceInTest,
} from "@ykdz/dock/vitest";
import { expect, test } from "vitest";

const value = defineVitestObservation("business-value", "");
const config = defineConfig({ plugins: [file], bindings: [] });
const source = file
  .from("read-target.txt")
  .match("value: ([^\\n]+)", 1)
  .reference("business-text-source");
let outsideWasRejected = false;
try {
  value.record("forged-outside-attempt");
} catch {
  outsideWasRejected = true;
}

test("business text observation", async () => {
  expect(outsideWasRejected).toBe(true);
  const result = await readReferenceInTest(config, source);
  expect(result.value).not.toBe("");
  expect(result.range).toMatchObject({ path: "read-target.txt" });
  expect(() => value.record(Number.NaN as never)).toThrow("non-finite number");
  expect(value.record(result.value)).toBe(result.value);
});
