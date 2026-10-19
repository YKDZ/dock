import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestRun,
  vitest,
  vitestStatus,
} from "@ykdz/dock-reference-vitest";

const run = defineVitestRun("声明标题筛选", {
  files: ["test/filter.test.mts"],
  testRoot: "../filter-workspace",
});
const included = vitestStatus("筛选保留", run, {
  file: "test/filter.test.mts",
  name: "筛选 > included status",
});
const excluded = vitestStatus("配置筛除", run, {
  file: "test/filter.test.mts",
  name: "筛选 > excluded status",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "happy.baseline.json",
  plugins: [vitest],
  bindings: [binding("保留状态", [included]), binding("筛除状态", [excluded])],
});
