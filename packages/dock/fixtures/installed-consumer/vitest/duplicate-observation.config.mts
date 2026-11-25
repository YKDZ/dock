import { binding, defineConfig } from "@boringparts/dock";
import {
  defineVitestObservation,
  defineVitestRun,
  vitest,
  vitestObservation,
} from "@boringparts/dock/vitest";

const value = defineVitestObservation("duplicate-value", "sample");
const run = defineVitestRun("duplicate observation", {
  files: ["test/duplicate-observation.test.mts"],
  testRoot: "../test-workspace",
  configFile: "../test-workspace/vitest.shared.config.mjs",
  observations: [value],
});
const observation = vitestObservation(
  "duplicate final observation",
  run,
  {
    file: "test/duplicate-observation.test.mts",
    name: "duplicate identical observation",
  },
  value,
);

export default defineConfig({
  root: "maintenance-root",
  baseline: "duplicate-observation.baseline.json",
  plugins: [vitest],
  bindings: [binding("duplicate observation", [observation])],
});
