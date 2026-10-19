import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestObservation,
  defineVitestRun,
  vitest,
  vitestObservation,
} from "@ykdz/dock-reference-vitest";

const value = defineVitestObservation("duplicate-value", "sample");
const run = defineVitestRun("重复观察", {
  files: ["test/duplicate-observation.test.mts"],
  testRoot: "../test-workspace",
  configFile: "../test-workspace/vitest.shared.config.mjs",
  observations: [value],
});
const observation = vitestObservation(
  "重复最终观察",
  run,
  { file: "test/duplicate-observation.test.mts", name: "重复同值观察" },
  value,
);

export default defineConfig({
  root: "maintenance-root",
  baseline: "duplicate-observation.baseline.json",
  plugins: [vitest],
  bindings: [binding("重复观察", [observation])],
});
