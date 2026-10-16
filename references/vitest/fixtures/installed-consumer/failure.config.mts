import { defineVitestRun, vitest, vitestStatus } from "@dock/reference-vitest";
import { binding, defineConfig } from "@dock/sdk";

const run = defineVitestRun("失败状态", {
  files: ["test/failure.test.mts"],
  testRoot: "../test-workspace",
});
const status = vitestStatus("失败声明", run, {
  file: "test/failure.test.mts",
  name: "被选中的失败",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "happy.baseline.json",
  plugins: [vitest],
  bindings: [binding("失败状态", [status])],
});
