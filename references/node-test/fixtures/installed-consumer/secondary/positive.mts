import {
  defineNodeTestObservation,
  defineNodeTestRun,
  nodeTestObservation,
  nodeTest,
} from "@dock/reference-node-test";
import { binding, defineConfig, type ReferenceValue } from "@dock/sdk";

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
const config = defineConfig({
  plugins: [nodeTest],
  bindings: [binding("第二物理安装", [reference])],
});
void actualObjectCount;
void config;
