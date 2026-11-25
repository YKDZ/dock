import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestObservation,
  defineVitestRun,
  vitest,
  vitestObservation,
} from "@ykdz/dock/vitest";

const outcome = defineVitestObservation("read-outcome", "");
const run = defineVitestRun("read selection ambiguity", {
  files: ["test/ambiguous-read.test.mts"],
  testRoot: "../test-workspace",
  configFile: "../test-workspace/vitest.shared.config.mjs",
  observations: [outcome],
});
const observation = vitestObservation(
  "read error outcome",
  run,
  {
    file: "test/ambiguous-read.test.mts",
    name: "ambiguous read fails explicitly",
  },
  outcome,
);

export default defineConfig({
  root: "maintenance-root",
  baseline: "ambiguous-read.baseline.json",
  plugins: [vitest],
  bindings: [binding("read selection ambiguity", [observation])],
});
