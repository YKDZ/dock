import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestRun,
  vitest,
  vitestStatus,
  vitestSuite,
} from "@ykdz/dock/vitest";

import { settings } from "./test-workspace/groups.observations.mts";

const run = defineVitestRun("native group invalid members", {
  files: ["test/group-failures.test.mts"],
  testRoot: "../test-workspace",
  observations: [settings],
});
const suite = vitestSuite(
  "failure-members",
  run,
  { file: "test/group-failures.test.mts", suitePath: ["failure suite"] },
  [settings],
);
const single = vitestStatus("passing-single-member", run, {
  file: "test/group-failures.test.mts",
  name: "failure suite > missing observation",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "groups.baseline.json",
  plugins: [vitest],
  bindings: [
    binding("group with errors and valid single test", [suite, single]),
  ],
});
