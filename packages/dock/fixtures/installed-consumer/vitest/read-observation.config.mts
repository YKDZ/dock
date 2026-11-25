import { binding, defineConfig } from "@boringparts/dock";
import {
  defineVitestObservation,
  defineVitestRun,
  vitest,
  vitestObservation,
} from "@boringparts/dock/vitest";

const value = defineVitestObservation("business-value", "");
const run = defineVitestRun("file read business observation", {
  files: ["test/read-observation.test.mts"],
  testRoot: "../test-workspace",
  configFile: "../test-workspace/vitest.shared.config.mjs",
  observations: [value],
});
const observation = vitestObservation(
  "current business text",
  run,
  {
    file: "test/read-observation.test.mts",
    name: "business text observation",
  },
  value,
);

export default defineConfig({
  root: "maintenance-root",
  baseline: "read-observation.baseline.json",
  plugins: [vitest],
  bindings: [binding("business text", [observation])],
});
