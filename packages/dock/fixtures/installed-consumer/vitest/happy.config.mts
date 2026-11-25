import { binding, defineConfig } from "@ykdz/dock";
import { defineVitestRun, vitest, vitestStatus } from "@ykdz/dock/vitest";

const run = defineVitestRun("passing and extra failure in same run", {
  files: [
    "test/retry.test.mts",
    "test/stable.test.mts",
    "test/extra-failure.test.mts",
  ],
  testRoot: "../test-workspace",
});
const retried = vitestStatus("final retry status", run, {
  file: "test/retry.test.mts",
  name: "retry > finally passes",
});
const stable = vitestStatus("normal status", run, {
  file: "test/stable.test.mts",
  name: "passes normally",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "happy.baseline.json",
  plugins: [vitest],
  bindings: [binding("passing status", [retried, stable])],
});
