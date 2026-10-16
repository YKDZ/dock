import { defineVitestRun, vitest, vitestSuite } from "@dock/reference-vitest";
import { binding, defineConfig } from "@dock/sdk";

import { settings } from "./test-workspace/groups.observations.mts";

const run = defineVitestRun("展开标题相同的原生路径", {
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
  bindings: [binding("路径相同标题组", [flatPath, nestedPath])],
});
