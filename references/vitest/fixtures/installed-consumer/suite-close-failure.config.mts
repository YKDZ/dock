import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestRun,
  vitest,
  vitestStatus,
} from "@ykdz/dock-reference-vitest";

const run = defineVitestRun("嵌套 suite 收尾失败", {
  files: ["test/suite-after-all.test.mts", "test/unrelated-failure.test.mts"],
  testRoot: "../test-workspace",
});
const selected = vitestStatus("嵌套收尾状态", run, {
  file: "test/suite-after-all.test.mts",
  name: "共同收尾 > 选定状态",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "suite-close-failure.baseline.json",
  plugins: [vitest],
  bindings: [binding("共同收尾状态", [selected])],
});
