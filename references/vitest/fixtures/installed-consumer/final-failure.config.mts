import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestObservation,
  defineVitestRun,
  vitest,
  vitestObservation,
} from "@ykdz/dock-reference-vitest";

const value = defineVitestObservation("earlier-value", "sample");
const run = defineVitestRun("最终失败不使用早期观察", {
  files: ["test/final-failure.test.mts"],
  testRoot: "../test-workspace",
  configFile: "../test-workspace/vitest.shared.config.mjs",
  observations: [value],
});
const observation = vitestObservation(
  "最终失败观察",
  run,
  {
    file: "test/final-failure.test.mts",
    name: "收尾失败的业务测试",
  },
  value,
);

export default defineConfig({
  root: "maintenance-root",
  baseline: "final-failure.baseline.json",
  plugins: [vitest],
  bindings: [binding("最终失败观察", [observation])],
});
