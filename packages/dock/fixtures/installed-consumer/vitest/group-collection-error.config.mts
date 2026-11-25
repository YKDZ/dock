import { binding, defineConfig } from "@boringparts/dock";
import { defineVitestRun, vitest, vitestSuite } from "@boringparts/dock/vitest";

import { settings } from "./test-workspace/groups.observations.mts";

const run = defineVitestRun("collection failed native group", {
  files: ["test/group-failures.test.mts"],
  testRoot: "../test-workspace",
  observations: [settings],
});
const suite = vitestSuite(
  "collection-failure-members",
  run,
  {
    file: "test/group-failures.test.mts",
    suitePath: ["collection failure"],
  },
  [settings],
);

export default defineConfig({
  root: "maintenance-root",
  baseline: "groups.baseline.json",
  plugins: [vitest],
  bindings: [binding("collection failed group", [suite])],
});
