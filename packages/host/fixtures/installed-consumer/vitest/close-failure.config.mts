import { binding, defineConfig } from "@ykdz/dock";
import { defineVitestRun, vitest, vitestStatus } from "@ykdz/dock/vitest";

const run = defineVitestRun("shared teardown failed", {
  files: ["test/close-failure.test.mts"],
  testRoot: "../close-workspace",
});
const status = vitestStatus("pre-teardown status", run, {
  file: "test/close-failure.test.mts",
  name: "passes before teardown",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "happy.baseline.json",
  plugins: [vitest],
  bindings: [binding("teardown status", [status])],
});
