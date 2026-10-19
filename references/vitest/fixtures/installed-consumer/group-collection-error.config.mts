import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestRun,
  vitest,
  vitestSuite,
} from "@ykdz/dock-reference-vitest";

import { settings } from "./test-workspace/groups.observations.mts";

const run = defineVitestRun("收集失败的原生组", {
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
  bindings: [binding("收集失败组", [suite])],
});
