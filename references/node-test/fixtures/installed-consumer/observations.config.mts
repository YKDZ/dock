import { file } from "@dock/reference-file";
import {
  defineNodeTestObservation,
  defineNodeTestRun,
  nodeTest,
  nodeTestObservation,
  nodeTestStatus,
} from "@dock/reference-node-test";
import { binding, defineConfig } from "@dock/sdk";

export const currentText = file
  .at(import.meta.url)
  .from("./read-business.txt")
  .match("Reading: (.*)", 1)
  .reference("current-business-text");

export const unassociatedText = file
  .at(import.meta.url)
  .from("./read-unassociated.txt")
  .match("Unassociated: (.*)", 1)
  .reference("unassociated-business-text");

export const readConfig = defineConfig({ plugins: [file], bindings: [] });

export const numericObservation = defineNodeTestObservation(
  "business.length",
  0,
);
export const objectObservation = defineNodeTestObservation("business.object", {
  amount: 0,
});

const run = defineNodeTestRun("观察和读取运行", {
  files: ["test/observations.test.mts"],
  testRoot: "secondary/test-workspace",
  observations: [numericObservation, objectObservation],
});
const target = {
  file: "test/observations.test.mts",
  name: "读取当前值并记录观察",
};
const status = nodeTestStatus("观察读取测试状态", run, target);
const numeric = nodeTestObservation(
  "当前长度",
  run,
  target,
  numericObservation,
);
const object = nodeTestObservation("业务对象", run, target, objectObservation);

export default defineConfig({
  baseline: "observations.baseline.json",
  plugins: [file, nodeTest],
  bindings: [binding("Node 观察和读取", [status, numeric, object])],
});
