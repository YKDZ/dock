import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestRun,
  vitest,
  vitestSuite,
} from "@ykdz/dock-reference-vitest";

import { settings } from "./test-workspace/groups.observations.mts";

const run = defineVitestRun("不存在的原生组", {
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
  bindings: [binding("不存在的组", [suite])],
});
