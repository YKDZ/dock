import { binding, defineConfig } from "@ykdz/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@ykdz/dock-reference-node-test";

const run = defineNodeTestRun("共同收尾失败", {
  files: ["test/close-failure.test.mts"],
  testRoot: "test-workspace",
});
const status = nodeTestStatus("收尾前状态", run, {
  file: "test/close-failure.test.mts",
  name: "收尾前的业务断言通过",
});

export default defineConfig({
  plugins: [nodeTest],
  bindings: [binding("关闭状态", [status])],
});
