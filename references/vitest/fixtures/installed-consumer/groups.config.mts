import { defineVitestRun, vitest, vitestSuite } from "@dock/reference-vitest";
import { binding, defineConfig } from "@dock/sdk";

import { settings, steps } from "./test-workspace/groups.observations.mts";

const run = defineVitestRun("原生组成员", {
  files: ["test/groups.test.mts"],
  testRoot: "../test-workspace",
  observations: [settings, steps],
});
const preview = vitestSuite(
  "preview-members",
  run,
  {
    file: "test/groups.test.mts",
    suitePath: ["preview config", "inner > label"],
  },
  [settings, steps],
);
const empty = vitestSuite(
  "empty-members",
  run,
  { file: "test/groups.test.mts", suitePath: ["empty config"] },
  [settings],
);
const allPreview = vitestSuite(
  "all-preview-members",
  run,
  { file: "test/groups.test.mts", suitePath: ["preview config"] },
  [settings],
);

export default defineConfig({
  root: "maintenance-root",
  baseline: "groups.baseline.json",
  plugins: [vitest],
  bindings: [
    binding("预览组", [preview]),
    binding("空组", [empty]),
    binding("全部预览成员", [allPreview]),
  ],
});
