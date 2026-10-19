import { defineConfig } from "@ykdz/dock";
import { file } from "@ykdz/dock-reference-file";
import {
  defineVitestObservation,
  readReferenceInTest,
} from "@ykdz/dock-reference-vitest";
import { expect, test } from "vitest";

const outcome = defineVitestObservation("read-outcome", "");
const config = defineConfig({ plugins: [file], bindings: [] });
const source = file
  .from("read-target.txt")
  .match("value: ([^\\n]+)", 1)
  .reference("ambiguous-source");

test("读取歧义明确失败", async () => {
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
