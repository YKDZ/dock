import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestRun,
  vitest,
  vitestSuite,
} from "@ykdz/dock/vitest";

import { settings, steps } from "./test-workspace/groups.observations.mts";

const run = defineVitestRun("native group members", {
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
    binding("preview group", [preview]),
    binding("empty group", [empty]),
    binding("all preview members", [allPreview]),
  ],
});
