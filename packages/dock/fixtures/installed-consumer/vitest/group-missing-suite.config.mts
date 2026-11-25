import { binding, defineConfig } from "@ykdz/dock";
import { defineVitestRun, vitest, vitestSuite } from "@ykdz/dock/vitest";

import { settings } from "./test-workspace/groups.observations.mts";

const run = defineVitestRun("missing native group", {
  files: ["test/groups.test.mts"],
  testRoot: "../test-workspace",
  observations: [settings],
});
const suite = vitestSuite(
  "preview-members",
  run,
  { file: "test/groups.test.mts", suitePath: ["removed config"] },
  [settings],
);

export default defineConfig({
  root: "maintenance-root",
  baseline: "groups.baseline.json",
  plugins: [vitest],
  bindings: [binding("missing group", [suite])],
});
