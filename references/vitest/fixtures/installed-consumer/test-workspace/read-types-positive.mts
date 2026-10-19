import {
  defineConfig,
  type PluginReadResult,
  type ReferenceValue,
} from "@ykdz/dock";
import { file } from "@ykdz/dock-reference-file";
import {
  defineVitestObservation,
  readReferenceInTest,
  vitestObservation,
} from "@ykdz/dock-reference-vitest";

import { sharedRun, sharedShape } from "../positive.mjs";

const document = file
  .from("business.data")
  .match("value: ([^\\n]+)", 1)
  .reference("business-value");
const config = defineConfig({ plugins: [file], bindings: [] });
const read = readReferenceInTest(config, document);
const expected: Promise<PluginReadResult<string>> = read;
void expected;

const secondShape = defineVitestObservation("shared.shape", { count: 0 });
const crossReference = vitestObservation(
  "第二物理安装观察",
  sharedRun,
  { file: "test/stable.test.mts", name: "普通通过" },
  secondShape,
);
const crossValue: ReferenceValue<typeof crossReference> = sharedShape.record({
  count: 1,
});
const crossCount: number = crossValue.count;
// @ts-expect-error 两份安装仍遵循原运行声明的值类型。
const crossLabel: string = crossValue.label;
void crossCount;
void crossLabel;
const widerSecondShape = defineVitestObservation("shared.shape", {
  count: 0,
  label: "",
});
vitestObservation(
  "第二物理安装的错误形状",
  sharedRun,
  { file: "test/stable.test.mts", name: "普通通过" },
  // @ts-expect-error 跨物理安装也拒绝扩大声明值形状的 helper。
  widerSecondShape,
);
