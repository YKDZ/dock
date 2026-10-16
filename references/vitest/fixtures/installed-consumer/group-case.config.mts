import { defineVitestRun, vitest, vitestStatus } from "@dock/reference-vitest";
import { binding, defineConfig } from "@dock/sdk";

const run = defineVitestRun("configured pattern 精确筛选", {
  files: ["test/group-pattern-case.test.mts"],
  testRoot: "../test-workspace",
  configFile: "../test-workspace/group-case.vitest.config.mjs",
});
const chosen = vitestStatus("chosen-only", run, {
  file: "test/group-pattern-case.test.mts",
  name: "chosen > one",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "group-case.baseline.json",
  plugins: [vitest],
  bindings: [binding("configured pattern", [chosen])],
});
