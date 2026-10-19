import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestRun,
  vitest,
  vitestStatus,
} from "@ykdz/dock-reference-vitest";

const run = defineVitestRun("未处理错误", {
  files: ["test/unhandled.test.mts"],
  testRoot: "../test-workspace",
});
const status = vitestStatus("错误前通过", run, {
  file: "test/unhandled.test.mts",
  name: "错误前通过",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "happy.baseline.json",
  plugins: [vitest],
  bindings: [binding("未处理错误", [status])],
});
