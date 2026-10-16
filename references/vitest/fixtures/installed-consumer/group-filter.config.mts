import { defineVitestRun, vitest, vitestSuite } from "@dock/reference-vitest";
import { binding, defineConfig } from "@dock/sdk";

import { settings } from "./test-workspace/groups.observations.mts";

const run = defineVitestRun("原生筛选的组", {
  files: ["test/groups.test.mts"],
  testRoot: "../test-workspace",
  configFile: "../test-workspace/group-filter.vitest.config.mjs",
  observations: [settings],
});
const suite = vitestSuite(
  "preview-members",
  run,
  {
    file: "test/groups.test.mts",
    suitePath: ["preview config", "inner > label"],
  },
  [settings],
);

export default defineConfig({
  root: "maintenance-root",
  baseline: "groups.baseline.json",
  plugins: [vitest],
  bindings: [binding("受筛选组", [suite])],
});
