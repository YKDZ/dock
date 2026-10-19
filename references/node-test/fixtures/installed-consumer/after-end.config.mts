import { binding, defineConfig } from "@ykdz/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@ykdz/dock-reference-node-test";

const run = defineNodeTestRun("结束后异步失败", {
  files: ["test/after-end.test.mts"],
  testRoot: "test-workspace",
});
const status = nodeTestStatus("结束后异步状态", run, {
  file: "test/after-end.test.mts",
  name: "选择的原生测试通过",
});

export default defineConfig({
  plugins: [nodeTest],
  bindings: [binding("异步失败状态", [status])],
  baseline: "after-end.baseline.json",
});
