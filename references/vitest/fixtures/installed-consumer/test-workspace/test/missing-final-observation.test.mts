import { defineConfig } from "@ykdz/dock";
import { file } from "@ykdz/dock-reference-file";
import {
  defineVitestObservation,
  readReferenceInTest,
} from "@ykdz/dock-reference-vitest";
import { expect, test } from "vitest";

const value = defineVitestObservation("retry-value", "sample");
const config = defineConfig({ plugins: [file], bindings: [] });
const source = file.from("read-target.txt").reference("retry-source");
let attempts = 0;

test("最终成功缺少观察", async () => {
  attempts += 1;
  const result = await readReferenceInTest(config, source);
  expect(result.value).not.toBe("");
  if (attempts === 1) {
    value.record("earlier-attempt");
    throw new Error("首次尝试读取并记录后失败");
  }
});
