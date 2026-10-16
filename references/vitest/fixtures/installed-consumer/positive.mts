import { defineVitestRun, vitest, vitestStatus } from "@dock/reference-vitest";
import { binding, defineConfig, type ReferenceValue } from "@dock/sdk";

const run = defineVitestRun("安装状态检查", {
  files: ["test/retry.test.mts"],
  testRoot: "../test-workspace",
});
const status = vitestStatus("最终通过", run, {
  file: "test/retry.test.mts",
  name: "重试 > 最终通过",
});
const expected: ReferenceValue<typeof status> = { status: "passed" };
void expected;

defineConfig({
  plugins: [vitest],
  bindings: [binding("运行状态", [status])],
});
