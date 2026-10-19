import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestRun,
  vitest,
  vitestStatus,
} from "@ykdz/dock-reference-vitest";

const run = defineVitestRun("多种非通过状态", {
  files: ["test/statuses.test.mts"],
  testRoot: "../test-workspace",
});
const skipped = vitestStatus("已跳过", run, {
  file: "test/statuses.test.mts",
  name: "状态 > 跳过",
});
const todo = vitestStatus("待实现", run, {
  file: "test/statuses.test.mts",
  name: "状态 > 待实现",
});
const cancelled = vitestStatus("主动取消", run, {
  file: "test/statuses.test.mts",
  name: "状态 > 主动跳过",
});
const missing = vitestStatus("未执行", run, {
  file: "test/statuses.test.mts",
  name: "状态 > 不存在的测试",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "happy.baseline.json",
  plugins: [vitest],
  bindings: [
    binding("跳过状态", [skipped]),
    binding("待实现状态", [todo]),
    binding("主动跳过状态", [cancelled]),
    binding("缺失状态", [missing]),
  ],
});
