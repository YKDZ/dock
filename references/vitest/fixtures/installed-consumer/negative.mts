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

const declaredShape = defineVitestObservation("declared.shape", { count: 0 });
const shapeRun = defineVitestRun("观察值声明", {
  files: ["test/stable.test.mts"],
  observations: [declaredShape],
});
const incompatibleShape = defineVitestObservation("declared.shape", {
  count: 0,
  label: "",
});
const shapeReference = vitestObservation(
  "观察值引用",
  shapeRun,
  { file: "test/stable.test.mts", name: "普通通过" },
  // @ts-expect-error 同键 helper 也必须与运行声明的完整值类型相符。
  incompatibleShape,
);
const shapeValue: ReferenceValue<typeof shapeReference> = declaredShape.record({
  count: 1,
});
// @ts-expect-error 运行声明没有保证 label，引用类型不能承诺该字段。
const unpromisedLabel: string = shapeValue.label;
void unpromisedLabel;
const wrongShapeValue: ReferenceValue<typeof shapeReference> = {
  // @ts-expect-error count 必须是 number。
  count: "1",
};
void wrongShapeValue;
const undeclaredShape = defineVitestObservation("undeclared.shape", 0);
vitestObservation(
  "未声明键",
  shapeRun,
  { file: "test/stable.test.mts", name: "普通通过" },
  // @ts-expect-error helper 键必须属于该运行。
  undeclaredShape,
);

const richerShape = defineVitestObservation("reverse.shape", {
  count: 0,
  label: "",
});
const richerRun = defineVitestRun("反向观察类型检查", {
  files: ["test/stable.test.mts"],
  observations: [richerShape],
});
const narrowerShape = defineVitestObservation("reverse.shape", { count: 0 });
vitestObservation(
  "反向不兼容观察值引用",
  richerRun,
  { file: "test/stable.test.mts", name: "普通通过" },
  // @ts-expect-error 运行声明额外保证 label，不能用较窄 helper 隐去它。
  narrowerShape,
);

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
