import {
  defineVitestObservation,
  defineVitestRun,
  vitest,
  vitestObservation,
  vitestStatus,
} from "@dock/reference-vitest";
import type { VitestTestSelection } from "@dock/reference-vitest";
import { binding, defineConfig, type ReferenceValue } from "@dock/sdk";

const run = defineVitestRun("安装状态检查", {
  files: ["test/retry.test.mts"],
  testRoot: "../test-workspace",
});
const status = vitestStatus("最终通过", run, {
  file: "test/retry.test.mts",
  name: "重试 > 最终通过",
});
const expected: ReferenceValue<typeof status> = { status: "passed" };
void expected;

const additionalTest: VitestTestSelection = {
  file: "test/stable.test.mts",
  name: "普通通过",
};
const runWithAdditionalTest = defineVitestRun("附加同次运行选择", {
  files: ["test/retry.test.mts", "test/stable.test.mts"],
  additionalTests: [additionalTest],
});
void runWithAdditionalTest;

const currentTitle = defineVitestObservation("current-title", "标题");
const observationRun = defineVitestRun("类型化观察", {
  files: ["test/stable.test.mts"],
  observations: [currentTitle],
});
const observedTitle = vitestObservation(
  "观察标题",
  observationRun,
  { file: "test/stable.test.mts", name: "普通通过" },
  currentTitle,
);
const expectedObservation: ReferenceValue<typeof observedTitle> = "当前标题";
const roundTripObservation: string = currentTitle.record(expectedObservation);
void roundTripObservation;

defineConfig({
  plugins: [vitest],
  bindings: [binding("运行状态", [status])],
});
