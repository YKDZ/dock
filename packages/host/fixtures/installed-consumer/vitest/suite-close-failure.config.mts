import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestRun,
  vitest,
  vitestStatus,
} from "@ykdz/dock/vitest";

const run = defineVitestRun("nested suite teardown failure", {
  files: ["test/suite-after-all.test.mts", "test/unrelated-failure.test.mts"],
  testRoot: "../test-workspace",
});
const selected = vitestStatus("nested teardown status", run, {
  file: "test/suite-after-all.test.mts",
  name: "shared teardown > selected status",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "suite-close-failure.baseline.json",
  plugins: [vitest],
  bindings: [binding("shared teardown status", [selected])],
});
