import {
  defineVitestRun,
  vitest,
  vitestStatus,
  vitestSuite,
} from "@dock/reference-vitest";
import { binding, defineConfig } from "@dock/sdk";

import { settings } from "./test-workspace/groups.observations.mts";

const run = defineVitestRun("原生组无效成员", {
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
  bindings: [binding("含错误组与有效单测", [suite, single])],
});
