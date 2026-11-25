import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestObservation,
  defineVitestRun,
  vitest,
  vitestObservation,
} from "@ykdz/dock/vitest";

const value = defineVitestObservation("multi-file-value", "");
const run = defineVitestRun("multi-file observations", {
  files: ["test/attempt-first.test.mts", "test/attempt-second.test.mts"],
  testRoot: "../test-workspace",
  configFile: "../test-workspace/vitest.shared.config.mjs",
  observations: [value],
});
const first = vitestObservation(
  "first file observation",
  run,
  { file: "test/attempt-first.test.mts", name: "first file observation" },
  value,
);
const second = vitestObservation(
  "second file observation",
  run,
  { file: "test/attempt-second.test.mts", name: "second file observation" },
  value,
);

export default defineConfig({
  root: "maintenance-root",
  plugins: [vitest],
  bindings: [binding("multi-file observation records", [first, second])],
});
