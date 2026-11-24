import {
  defineConfig,
  file,
  type PluginReadResult,
  type ReferenceValue,
} from "@ykdz/dock";
import {
  defineVitestObservation,
  readReferenceInTest,
  vitestObservation,
} from "@ykdz/dock/vitest";

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
  "second physical installation observation",
  sharedRun,
  { file: "test/stable.test.mts", name: "passes normally" },
  secondShape,
);
const crossValue: ReferenceValue<typeof crossReference> = sharedShape.record({
  count: 1,
});
const crossCount: number = crossValue.count;
// @ts-expect-error Two installations still follow the value type declared on the original run.
const crossLabel: string = crossValue.label;
void crossCount;
void crossLabel;
const widerSecondShape = defineVitestObservation("shared.shape", {
  count: 0,
  label: "",
});
vitestObservation(
  "second physical installation wrong shape",
  sharedRun,
  { file: "test/stable.test.mts", name: "passes normally" },
  // @ts-expect-error Cross-physical installation also rejects helpers that widen the declared value shape.
  widerSecondShape,
);
