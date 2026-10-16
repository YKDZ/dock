import { defineVitestRun, vitest, vitestStatus } from "@dock/reference-vitest";
import { binding, defineConfig } from "@dock/sdk";

const run = defineVitestRun("共同收尾失败", {
  files: ["test/close-failure.test.mts"],
  testRoot: "../close-workspace",
});
const status = vitestStatus("收尾前状态", run, {
  file: "test/close-failure.test.mts",
  name: "收尾前通过",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "happy.baseline.json",
  plugins: [vitest],
  bindings: [binding("收尾状态", [status])],
});
