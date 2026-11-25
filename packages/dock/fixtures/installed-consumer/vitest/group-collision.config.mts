import { binding, defineConfig } from "@boringparts/dock";
import { defineVitestRun, vitest, vitestSuite } from "@boringparts/dock/vitest";

import { settings } from "./test-workspace/groups.observations.mts";

const run = defineVitestRun("native paths with same flattened title", {
  files: ["test/group-collision.test.mts"],
  testRoot: "../test-workspace",
  observations: [settings],
});
const flatPath = vitestSuite(
  "flat-path",
  run,
  {
    file: "test/group-collision.test.mts",
    suitePath: ["outer", "nested > child"],
  },
  [settings],
);
const nestedPath = vitestSuite(
  "nested-path",
  run,
  {
    file: "test/group-collision.test.mts",
    suitePath: ["outer", "nested", "child"],
  },
  [settings],
);

export default defineConfig({
  root: "maintenance-root",
  baseline: "group-collision.baseline.json",
  plugins: [vitest],
  bindings: [binding("same flattened title groups", [flatPath, nestedPath])],
});
