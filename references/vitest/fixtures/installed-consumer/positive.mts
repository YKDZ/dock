import { binding, defineConfig, type ReferenceValue } from "@ykdz/dock";
import {
  defineVitestObservation,
  defineVitestRun,
  vitest,
  vitestObservation,
  vitestStatus,
} from "@ykdz/dock-reference-vitest";
import type { VitestTestSelection } from "@ykdz/dock-reference-vitest";

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

const sharedShape = defineVitestObservation("shared.shape", { count: 0 });
const sharedRun = defineVitestRun("共享观察类型", {
  files: ["test/stable.test.mts"],
  observations: [sharedShape],
});
const sharedReference = vitestObservation(
  "共享结构引用",
  sharedRun,
  { file: "test/stable.test.mts", name: "普通通过" },
  sharedShape,
);
const sharedValue: ReferenceValue<typeof sharedReference> = sharedShape.record({
  count: 1,
});
const sharedCount: number = sharedValue.count;
// @ts-expect-error 运行声明只保证 count。
const sharedLabel: string = sharedValue.label;
void sharedCount;
void sharedLabel;

export { sharedRun, sharedShape };

defineConfig({
  plugins: [vitest],
  bindings: [binding("运行状态", [status])],
});
