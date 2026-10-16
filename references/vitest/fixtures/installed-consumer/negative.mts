import { defineVitestRun, vitest, vitestStatus } from "@dock/reference-vitest";
import { binding, defineConfig, type ReferenceValue } from "@dock/sdk";

// @ts-expect-error 测试运行至少需要一个原生测试文件。
defineVitestRun("空运行", { files: [] });

const run = defineVitestRun("有效运行", {
  files: ["test/retry.test.mts"],
});
defineVitestRun("缺少额外测试标题", {
  files: ["test/retry.test.mts"],
  // @ts-expect-error 额外同次运行选择必须提供完整标题。
  additionalTests: [{ file: "test/retry.test.mts" }],
});
// @ts-expect-error 测试标题必须是文本。
vitestStatus("错误标题", run, { file: "test/retry.test.mts", name: 42 });

const status = vitestStatus("状态", run, {
  file: "test/retry.test.mts",
  name: "重试 > 最终通过",
});
// @ts-expect-error 状态引用只表示成功终态。
const failed: ReferenceValue<typeof status> = { status: "failed" };
void failed;

// @ts-expect-error 状态引用必须由对应的 Vitest 插件处理。
defineConfig({ plugins: [], bindings: [binding("缺失插件", [status])] });

vitestStatus(
  "非法选择",
  run,
  { file: "test/retry.test.mts", name: "重试 > 最终通过" },
  // @ts-expect-error Vitest 状态声明不支持 selection。
  { selection: { kind: "unsupported" } },
);

defineConfig({
  plugins: [vitest],
  bindings: [binding("有效声明", [status])],
});
