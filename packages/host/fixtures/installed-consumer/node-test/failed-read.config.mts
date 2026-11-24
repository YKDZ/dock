import { binding, defineConfig, file } from "@ykdz/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestObservation,
} from "@ykdz/dock/node-test";

import { numericObservation } from "./observations.config.mts";

const run = defineNodeTestRun("failed-read-run", {
  files: ["test/failed-read.test.mts"],
  testRoot: "secondary/test-workspace",
  observations: [numericObservation],
});
const value = nodeTestObservation(
  "value-before-failure",
  run,
  {
    file: "test/failed-read.test.mts",
    name: "business assertion fails after read",
  },
  numericObservation,
);

export default defineConfig({
  plugins: [file, nodeTest],
  baseline: "failed-read.baseline.json",
  bindings: [binding("business-assertion-after-read", [value])],
});
