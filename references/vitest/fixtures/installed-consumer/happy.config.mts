import { defineVitestRun, vitest, vitestStatus } from "@dock/reference-vitest";
import { binding, defineConfig } from "@dock/sdk";

const run = defineVitestRun("成功与额外失败同次运行", {
  files: [
    "test/retry.test.mts",
    "test/stable.test.mts",
    "test/extra-failure.test.mts",
  ],
  testRoot: "../test-workspace",
});
const retried = vitestStatus("最终重试状态", run, {
  file: "test/retry.test.mts",
  name: "重试 > 最终通过",
});
const stable = vitestStatus("普通状态", run, {
  file: "test/stable.test.mts",
  name: "正常通过",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "happy.baseline.json",
  plugins: [vitest],
  bindings: [binding("通过状态", [retried, stable])],
});
