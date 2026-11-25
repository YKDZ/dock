import { binding, defineConfig } from "@boringparts/dock";
import {
  defineVitestRun,
  vitest,
  vitestStatus,
} from "@boringparts/dock/vitest";

const run = defineVitestRun("interrupted run", {
  files: ["test/interrupted.test.mts"],
  testRoot: "../test-workspace",
});
const status = vitestStatus("interrupted status", run, {
  file: "test/interrupted.test.mts",
  name: "about to interrupt",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "happy.baseline.json",
  plugins: [vitest],
  bindings: [binding("interrupted status", [status])],
});
