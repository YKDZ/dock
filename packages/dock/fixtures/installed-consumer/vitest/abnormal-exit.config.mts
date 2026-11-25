import { binding, defineConfig } from "@boringparts/dock";
import {
  defineVitestRun,
  vitest,
  vitestStatus,
} from "@boringparts/dock/vitest";

const run = defineVitestRun("abnormal exit", {
  files: ["test/abnormal-exit.test.mts"],
  testRoot: "../abnormal-exit-workspace",
});
const status = vitestStatus("pre-exit status", run, {
  file: "test/abnormal-exit.test.mts",
  name: "before abnormal exit",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "happy.baseline.json",
  plugins: [vitest],
  bindings: [binding("abnormal exit status", [status])],
});
