import {
  defineVitestRun,
  vitest,
  vitestObservation,
  vitestStatus,
  vitestSuite,
} from "@dock/reference-vitest";
import { binding, defineConfig } from "@dock/sdk";

import { settings, steps } from "./test-workspace/groups.observations.mts";

const run = defineVitestRun("组与单测共用原生运行", {
  files: ["test/groups.test.mts"],
  testRoot: "../test-workspace",
  ...(process.env.DOCK_VITEST_GROUP_ADDITIONAL === "1"
    ? {
        additionalTests: [
          { file: "test/groups.test.mts", name: "extra marker" },
        ],
      }
    : {}),
  observations: [settings, steps],
});
const suite = vitestSuite(
  "preview-members",
  run,
  {
    file: "test/groups.test.mts",
    suitePath: ["preview config", "inner > label"],
  },
  [settings, steps],
);
const single = vitestObservation(
  "primary-settings",
  run,
  {
    file: "test/groups.test.mts",
    name: "preview config > inner > label > primary",
  },
  settings,
);
const status = vitestStatus("primary-status", run, {
  file: "test/groups.test.mts",
  name: "preview config > inner > label > primary",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "groups-shared.baseline.json",
  plugins: [vitest],
  bindings: [binding("组和单测共享", [suite, single, status])],
});
