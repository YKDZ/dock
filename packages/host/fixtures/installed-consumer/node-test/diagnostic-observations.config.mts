import { binding, defineConfig } from "@ykdz/dock";
import {
  defineNodeTestObservation,
  defineNodeTestRun,
  nodeTest,
  nodeTestObservation,
} from "@ykdz/dock/node-test";

const missing = defineNodeTestObservation("missing.value", 0);
const duplicate = defineNodeTestObservation("duplicate.value", 0);
const run = defineNodeTestRun("observation-diagnostics-run", {
  files: ["test/diagnostic-observations.test.mts"],
  testRoot: "secondary/test-workspace",
  observations: [missing, duplicate],
});
const missingReference = nodeTestObservation(
  "missing-observation",
  run,
  {
    file: "test/diagnostic-observations.test.mts",
    name: "declared but not recorded",
  },
  missing,
);
const duplicateReference = nodeTestObservation(
  "duplicate-observation",
  run,
  {
    file: "test/diagnostic-observations.test.mts",
    name: "duplicate identical observation recorded",
  },
  duplicate,
);

export default defineConfig({
  baseline: "diagnostic-observations.baseline.json",
  plugins: [nodeTest],
  bindings: [
    binding("observation-missing-or-duplicate", [
      missingReference,
      duplicateReference,
    ]),
  ],
});
