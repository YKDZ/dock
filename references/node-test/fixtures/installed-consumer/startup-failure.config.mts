import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@dock/reference-node-test";
import { binding, defineConfig } from "@dock/sdk";

const run = defineNodeTestRun("文件缺失", {
  files: ["test/missing.test.mts"],
  testRoot: "test-workspace",
});
const status = nodeTestStatus("缺失测试", run, {
  file: "test/missing.test.mts",
  name: "不存在的测试",
});

export default defineConfig({
  plugins: [nodeTest],
  bindings: [binding("启动失败", [status])],
});
