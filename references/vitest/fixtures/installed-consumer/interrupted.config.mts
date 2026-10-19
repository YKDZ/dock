import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestRun,
  vitest,
  vitestStatus,
} from "@ykdz/dock-reference-vitest";

const run = defineVitestRun("中断运行", {
  files: ["test/interrupted.test.mts"],
  testRoot: "../test-workspace",
});
const status = vitestStatus("中断状态", run, {
  file: "test/interrupted.test.mts",
  name: "即将中断",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "happy.baseline.json",
  plugins: [vitest],
  bindings: [binding("中断状态", [status])],
});
