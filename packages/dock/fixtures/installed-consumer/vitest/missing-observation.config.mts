import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestObservation,
  defineVitestRun,
  vitest,
  vitestObservation,
} from "@ykdz/dock/vitest";

const value = defineVitestObservation("retry-value", "sample");
const run = defineVitestRun("final attempt observation", {
  files: ["test/missing-final-observation.test.mts"],
  testRoot: "../test-workspace",
  configFile: "../test-workspace/vitest.shared.config.mjs",
  observations: [value],
});
const observation = vitestObservation(
  "final attempt missing observation",
  run,
  {
    file: "test/missing-final-observation.test.mts",
    name: "final pass missing observation",
  },
  value,
);

export default defineConfig({
  root: "maintenance-root",
  baseline: "missing-observation.baseline.json",
  plugins: [vitest],
  bindings: [binding("final attempt observation", [observation])],
});
