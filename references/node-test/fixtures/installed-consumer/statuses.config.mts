import { binding, defineConfig } from "@ykdz/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@ykdz/dock-reference-node-test";

const run = defineNodeTestRun("非通过终态", {
  files: ["test/statuses.test.mts"],
  testRoot: "test-workspace",
});
const skipped = nodeTestStatus("跳过状态", run, {
  file: "test/statuses.test.mts",
  name: "跳过的业务状态",
});
const todo = nodeTestStatus("待办状态", run, {
  file: "test/statuses.test.mts",
  name: "待办的业务状态",
});

export default defineConfig({
  plugins: [nodeTest],
  bindings: [binding("非通过状态", [skipped, todo])],
});
