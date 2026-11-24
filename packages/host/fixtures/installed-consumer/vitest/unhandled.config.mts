import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestRun,
  vitest,
  vitestStatus,
} from "@ykdz/dock/vitest";

const run = defineVitestRun("unhandled error", {
  files: ["test/unhandled.test.mts"],
  testRoot: "../test-workspace",
});
const status = vitestStatus("passed before error", run, {
  file: "test/unhandled.test.mts",
  name: "passes before error",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "happy.baseline.json",
  plugins: [vitest],
  bindings: [binding("unhandled error", [status])],
});
