import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestObservation,
  defineVitestRun,
  vitest,
  vitestObservation,
} from "@ykdz/dock-reference-vitest";

const value = defineVitestObservation("business-value", "");
const run = defineVitestRun("文件读取业务观察", {
  files: ["test/read-observation.test.mts"],
  testRoot: "../test-workspace",
  configFile: "../test-workspace/vitest.shared.config.mjs",
  observations: [value],
});
const observation = vitestObservation(
  "当前业务文本",
  run,
  { file: "test/read-observation.test.mts", name: "业务文本观察" },
  value,
);

export default defineConfig({
  root: "maintenance-root",
  baseline: "read-observation.baseline.json",
  plugins: [vitest],
  bindings: [binding("业务文本", [observation])],
});
