import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestRun,
  vitest,
  vitestStatus,
} from "@ykdz/dock-reference-vitest";

const run = defineVitestRun("额外同次运行选择", {
  files: [
    "test/additional-required.test.mts",
    "test/additional-extra.test.mts",
  ],
  testRoot: "../test-workspace",
  additionalTests: [
    {
      file: "test/additional-extra.test.mts",
      name: "不同标题的附加测试",
    },
  ],
});
const required = vitestStatus("明确必需的状态", run, {
  file: "test/additional-required.test.mts",
  name: "明确必需的测试",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "additional-tests.baseline.json",
  plugins: [vitest],
  bindings: [binding("明确必需的状态", [required])],
});
