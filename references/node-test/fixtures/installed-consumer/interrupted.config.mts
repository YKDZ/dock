import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@dock/reference-node-test";
import { binding, defineConfig } from "@dock/sdk";

const run = defineNodeTestRun("进程级中断", {
  files: ["test/interrupted.test.mts"],
  testRoot: "test-workspace",
});
const status = nodeTestStatus("中断中的状态", run, {
  file: "test/interrupted.test.mts",
  name: "等待信号后结束",
});

export default defineConfig({
  plugins: [nodeTest],
  bindings: [binding("中断状态", [status])],
  baseline: "interrupted.baseline.json",
});
