import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestRun,
  vitest,
  vitestStatus,
} from "@ykdz/dock/vitest";

const run = defineVitestRun("scope test run", {
  files: ["test/scope-old.test.mts", "test/scope-new.test.mts"],
  testRoot: "../test-workspace",
});
const targetFile =
  process.env.DOCK_VITEST_SCOPE_TARGET ?? "test/scope-old.test.mts";
const reference = vitestStatus("scope-vitest-reference", run, {
  file: targetFile,
  name: "scope file status ok",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "scope.baseline.json",
  plugins: [vitest],
  bindings: [binding("scope-vitest-policy", [reference])],
});
