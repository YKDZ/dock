import {
  defineVitestObservation,
  defineVitestRun,
  vitest,
  vitestObservation,
} from "@dock/reference-vitest";
import { binding, defineConfig } from "@dock/sdk";

const value = defineVitestObservation("retry-value", "sample");
const run = defineVitestRun("最终尝试观察", {
  files: ["test/missing-final-observation.test.mts"],
  testRoot: "../test-workspace",
  configFile: "../test-workspace/vitest.shared.config.mjs",
  observations: [value],
});
const observation = vitestObservation(
  "最终尝试缺失观察",
  run,
  {
    file: "test/missing-final-observation.test.mts",
    name: "最终成功缺少观察",
  },
  value,
);

export default defineConfig({
  root: "maintenance-root",
  baseline: "missing-observation.baseline.json",
  plugins: [vitest],
  bindings: [binding("最终尝试观察", [observation])],
});
