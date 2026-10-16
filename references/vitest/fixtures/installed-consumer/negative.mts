import {
  defineVitestObservation,
  defineVitestRun,
  vitest,
  vitestObservation,
  vitestStatus,
} from "@dock/reference-vitest";
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

const titleObservation = defineVitestObservation("title", "标题");
// @ts-expect-error 观察值必须与单份观察声明推导的类型一致。
titleObservation.record(42);
const observedRun = defineVitestRun("观察类型检查", {
  files: ["test/stable.test.mts"],
  observations: [titleObservation],
});
vitestObservation(
  "未知观察键",
  observedRun,
  { file: "test/stable.test.mts", name: "普通通过" },
  // @ts-expect-error 引用只能绑定本次运行已声明的观察。
  defineVitestObservation("other", "其他"),
);
const observedTitle = vitestObservation(
  "类型化标题",
  observedRun,
  { file: "test/stable.test.mts", name: "普通通过" },
  titleObservation,
);
// @ts-expect-error 观察值由声明传入，不能换成其他类型。
const wrongObservation: ReferenceValue<typeof observedTitle> = 42;
void wrongObservation;

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
