import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestRun,
  vitest,
  vitestStatus,
} from "@ykdz/dock-reference-vitest";

const run = defineVitestRun("范围测试运行", {
  files: ["test/scope-old.test.mts", "test/scope-new.test.mts"],
  testRoot: "../test-workspace",
});
const targetFile =
  process.env.DOCK_VITEST_SCOPE_TARGET ?? "test/scope-old.test.mts";
const reference = vitestStatus("scope-vitest-reference", run, {
  file: targetFile,
  name: "范围文件状态正常",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "scope.baseline.json",
  plugins: [vitest],
  bindings: [binding("scope-vitest-policy", [reference])],
});
