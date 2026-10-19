import { binding, defineConfig } from "@ykdz/dock";
import {
  defineVitestRun,
  vitest,
  vitestStatus,
} from "@ykdz/dock-reference-vitest";

const run = defineVitestRun("重复身份", {
  files: ["test/duplicate.test.mts"],
  testRoot: "../test-workspace",
});
const status = vitestStatus("歧义状态", run, {
  file: "test/duplicate.test.mts",
  name: "重复标题 > 相同身份",
});

export default defineConfig({
  root: "maintenance-root",
  baseline: "happy.baseline.json",
  plugins: [vitest],
  bindings: [binding("歧义状态", [status])],
});
