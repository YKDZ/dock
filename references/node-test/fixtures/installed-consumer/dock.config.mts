import { binding, defineConfig } from "@ykdz/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@ykdz/dock-reference-node-test";

const run = defineNodeTestRun("业务运行", {
  files: ["test/happy.test.mts"],
  testRoot: "test-workspace",
});
const first = nodeTestStatus("主要业务状态", run, {
  file: "test/happy.test.mts",
  name: "主要业务状态符合约定",
});
const second = nodeTestStatus("辅助业务状态", run, {
  file: "test/happy.test.mts",
  name: "辅助业务状态符合约定",
});

export default defineConfig({
  plugins: [nodeTest],
  bindings: [binding("业务验收", [first, second])],
});
