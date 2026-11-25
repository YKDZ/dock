import { defineConfig, file } from "@ykdz/dock";
import {
  defineVitestObservation,
  readReferenceInTest,
} from "@ykdz/dock/vitest";
import { expect, test } from "vitest";

const outcome = defineVitestObservation("read-outcome", "");
const config = defineConfig({ plugins: [file], bindings: [] });
const source = file
  .from("read-target.txt")
  .match("value: ([^\\n]+)", 1)
  .reference("ambiguous-source");

test("ambiguous read fails explicitly", async () => {
  let code = "unexpected-success";
  try {
    await readReferenceInTest(config, source);
  } catch (error) {
    code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "unstructured-error";
  }
  expect(code).toBe("ambiguous-selection");
  expect(outcome.record(code)).toBe("ambiguous-selection");
});
