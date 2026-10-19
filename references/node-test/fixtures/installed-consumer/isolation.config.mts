import { binding, defineConfig } from "@ykdz/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@ykdz/dock-reference-node-test";

const run = defineNodeTestRun("有范围的断言失败", {
  files: ["test/isolation.test.mts"],
  testRoot: "test-workspace",
});
const failed = nodeTestStatus("失败测试", run, {
  file: "test/isolation.test.mts",
  name: "选定业务断言失败",
});
const passed = nodeTestStatus("独立测试", run, {
  file: "test/isolation.test.mts",
  name: "独立业务断言通过",
});

export default defineConfig({
  baseline: "isolation.baseline.json",
  plugins: [nodeTest],
  bindings: [binding("失败业务", [failed]), binding("独立业务", [passed])],
});
