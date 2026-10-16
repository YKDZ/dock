import { defineVitestRun, vitest, vitestStatus } from "@dock/reference-vitest";
import { binding, defineConfig } from "@dock/sdk";

const run = defineVitestRun("异常退出", {
  files: ["test/abnormal-exit.test.mts"],
  testRoot: "../abnormal-exit-workspace",
});
const status = vitestStatus("退出前状态", run, {
  file: "test/abnormal-exit.test.mts",
  name: "异常退出前",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "happy.baseline.json",
  plugins: [vitest],
  bindings: [binding("异常退出状态", [status])],
});
