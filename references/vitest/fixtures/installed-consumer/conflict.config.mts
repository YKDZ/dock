import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestRun,
  vitest,
  vitestStatus,
} from "@ykdz/dock-reference-vitest";

const firstRun = defineVitestRun("冲突身份", {
  files: ["test/conflict-first.test.mts"],
  testRoot: "../test-workspace",
});
const secondRun = defineVitestRun("冲突身份", {
  files: ["test/conflict-second.test.mts"],
  testRoot: "../test-workspace",
});
const first = vitestStatus("首项冲突", firstRun, {
  file: "test/conflict-first.test.mts",
  name: "不能开始的首项",
});
const second = vitestStatus("次项冲突", secondRun, {
  file: "test/conflict-second.test.mts",
  name: "不能开始的次项",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "happy.baseline.json",
  plugins: [vitest],
  bindings: [binding("冲突首项", [first]), binding("冲突次项", [second])],
});
