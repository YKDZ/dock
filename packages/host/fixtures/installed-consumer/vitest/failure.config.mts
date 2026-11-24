import { binding, defineConfig } from "@ykdz/dock";
import { defineVitestRun, vitest, vitestStatus } from "@ykdz/dock/vitest";

const run = defineVitestRun("failure status", {
  files: ["test/failure.test.mts"],
  testRoot: "../test-workspace",
});
const status = vitestStatus("failure declaration", run, {
  file: "test/failure.test.mts",
  name: "selected failure",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "happy.baseline.json",
  plugins: [vitest],
  bindings: [binding("failure status", [status])],
});
