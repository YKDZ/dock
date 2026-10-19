import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestObservation,
  defineVitestRun,
  vitest,
  vitestObservation,
} from "@ykdz/dock-reference-vitest";

const outcome = defineVitestObservation("read-outcome", "");
const run = defineVitestRun("读取选择歧义", {
  files: ["test/ambiguous-read.test.mts"],
  testRoot: "../test-workspace",
  configFile: "../test-workspace/vitest.shared.config.mjs",
  observations: [outcome],
});
const observation = vitestObservation(
  "读取错误结果",
  run,
  {
    file: "test/ambiguous-read.test.mts",
    name: "读取歧义明确失败",
  },
  outcome,
);

export default defineConfig({
  root: "maintenance-root",
  baseline: "ambiguous-read.baseline.json",
  plugins: [vitest],
  bindings: [binding("读取选择歧义", [observation])],
});
