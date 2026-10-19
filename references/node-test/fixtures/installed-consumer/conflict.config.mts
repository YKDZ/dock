import { binding, defineConfig } from "@ykdz/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@ykdz/dock-reference-node-test";

const firstRun = defineNodeTestRun("冲突身份", {
  files: ["test/conflict-first.test.mts"],
  testRoot: "test-workspace",
});
const secondRun = defineNodeTestRun("冲突身份", {
  files: ["test/conflict-second.test.mts"],
  testRoot: "test-workspace",
});
const first = nodeTestStatus("冲突首项", firstRun, {
  file: "test/conflict-first.test.mts",
  name: "首个冲突命令不应启动",
});
const second = nodeTestStatus("冲突次项", secondRun, {
  file: "test/conflict-second.test.mts",
  name: "第二个冲突命令不应启动",
});

export default defineConfig({
  plugins: [nodeTest],
  bindings: [binding("首项冲突", [first]), binding("次项冲突", [second])],
});
