import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestRun,
  vitest,
  vitestStatus,
} from "@ykdz/dock/vitest";

const run = defineVitestRun("duplicate identity", {
  files: ["test/duplicate.test.mts"],
  testRoot: "../test-workspace",
});
const status = vitestStatus("ambiguous status", run, {
  file: "test/duplicate.test.mts",
  name: "duplicate title > same identity",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "happy.baseline.json",
  plugins: [vitest],
  bindings: [binding("ambiguous status", [status])],
});
