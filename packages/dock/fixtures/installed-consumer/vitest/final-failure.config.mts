import { binding, defineConfig } from "@boringparts/dock";
import {
  defineVitestObservation,
  defineVitestRun,
  vitest,
  vitestObservation,
} from "@boringparts/dock/vitest";

const value = defineVitestObservation("earlier-value", "sample");
const run = defineVitestRun("final failure ignores early observation", {
  files: ["test/final-failure.test.mts"],
  testRoot: "../test-workspace",
  configFile: "../test-workspace/vitest.shared.config.mjs",
  observations: [value],
});
const observation = vitestObservation(
  "final failure observation",
  run,
  {
    file: "test/final-failure.test.mts",
    name: "business test failing in teardown",
  },
  value,
);

export default defineConfig({
  root: "maintenance-root",
  baseline: "final-failure.baseline.json",
  plugins: [vitest],
  bindings: [binding("final failure observation", [observation])],
});
