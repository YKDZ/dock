import {
  defineNodeTestObservation,
  defineNodeTestRun,
  nodeTest,
  nodeTestObservation,
} from "@dock/reference-node-test";
import { binding, defineConfig } from "@dock/sdk";

const missing = defineNodeTestObservation("missing.value", 0);
const duplicate = defineNodeTestObservation("duplicate.value", 0);
const run = defineNodeTestRun("观察诊断运行", {
  files: ["test/diagnostic-observations.test.mts"],
  testRoot: "secondary/test-workspace",
  observations: [missing, duplicate],
});
const missingReference = nodeTestObservation(
  "缺失观察值",
  run,
  {
    file: "test/diagnostic-observations.test.mts",
    name: "声明但未记录",
  },
  missing,
);
const duplicateReference = nodeTestObservation(
  "重复观察值",
  run,
  {
    file: "test/diagnostic-observations.test.mts",
    name: "同值重复记录",
  },
  duplicate,
);

export default defineConfig({
  baseline: "diagnostic-observations.baseline.json",
  plugins: [nodeTest],
  bindings: [binding("观察缺失或重复", [missingReference, duplicateReference])],
});
