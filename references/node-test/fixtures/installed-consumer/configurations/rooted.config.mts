import { binding, defineConfig } from "@ykdz/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@ykdz/dock-reference-node-test";

const run = defineNodeTestRun("有效 root 业务运行", {
  files: ["test/rooted.test.mts"],
  testRoot: "test-workspace",
});
const status = nodeTestStatus("有效 root 测试状态", run, {
  file: "test/rooted.test.mts",
  name: "运行目录定位于有效 root",
});

export default defineConfig({
  root: "../effective-root",
  baseline: "rooted.baseline.json",
  plugins: [nodeTest],
  bindings: [binding("有效 root 维护", [status])],
});
