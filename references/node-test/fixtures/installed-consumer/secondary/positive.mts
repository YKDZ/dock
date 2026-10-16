import {
  defineNodeTestObservation,
  defineNodeTestRun,
  nodeTestObservation,
  nodeTest,
} from "@dock/reference-node-test";
import { binding, defineConfig, type ReferenceValue } from "@dock/sdk";

import { sharedRun, sharedShape } from "../positive.mjs";

const count = defineNodeTestObservation("secondary.count", 0);
const object = defineNodeTestObservation("secondary.object", { count: 0 });
const run = defineNodeTestRun("第二安装类型", {
  files: ["test/sample.test.mts"],
  observations: [count, object],
});
const reference = nodeTestObservation(
  "secondary-count",
  run,
  { file: "test/sample.test.mts", name: "sample" },
  count,
);
const value: ReferenceValue<typeof reference> = 19;
const actual: number = count.record(value);
const actualObjectCount: number = object.record({ count: actual }).count;
const secondShape = defineNodeTestObservation("node.shared.shape", {
  count: 0,
});
const crossReference = nodeTestObservation(
  "第二物理安装引用",
  sharedRun,
  { file: "test/happy.test.mts", name: "主要业务状态符合约定" },
  secondShape,
);
const crossValue: ReferenceValue<typeof crossReference> = sharedShape.record({
  count: 1,
});
const crossCount: number = crossValue.count;
// @ts-expect-error 双份安装仍遵循 run 的结构值类型。
const crossLabel: string = crossValue.label;
const config = defineConfig({
  plugins: [nodeTest],
  bindings: [binding("第二物理安装", [reference])],
});
void actualObjectCount;
void crossCount;
void crossLabel;
const widerSecondShape = defineNodeTestObservation("node.shared.shape", {
  count: 0,
  label: "",
});
nodeTestObservation(
  "第二物理安装的错误形状",
  sharedRun,
  { file: "test/happy.test.mts", name: "主要业务状态符合约定" },
  // @ts-expect-error 第二份物理安装也拒绝扩大声明值形状的 helper。
  widerSecondShape,
);
void config;
