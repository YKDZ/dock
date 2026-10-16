import { defineVitestRun, vitest, vitestStatus } from "@dock/reference-vitest";
import { binding, defineConfig } from "@dock/sdk";

const run = defineVitestRun("重复身份", {
  files: ["test/duplicate.test.mts"],
  testRoot: "../test-workspace",
});
const status = vitestStatus("歧义状态", run, {
  file: "test/duplicate.test.mts",
  name: "重复标题 > 相同身份",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "happy.baseline.json",
  plugins: [vitest],
  bindings: [binding("歧义状态", [status])],
});
