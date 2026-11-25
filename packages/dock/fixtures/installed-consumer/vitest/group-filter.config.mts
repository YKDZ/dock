import { binding, defineConfig } from "@boringparts/dock";
import { defineVitestRun, vitest, vitestSuite } from "@boringparts/dock/vitest";

import { settings } from "./test-workspace/groups.observations.mts";

const run = defineVitestRun("natively filtered group", {
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
  bindings: [binding("filtered group", [suite])],
});
