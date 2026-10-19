import { binding, defineConfig, type ReferenceValue } from "@ykdz/dock";
import {
  defineNodeTestObservation,
  defineNodeTestRun,
  nodeTest,
  nodeTestObservation,
  nodeTestStatus,
} from "@ykdz/dock-reference-node-test";

// @ts-expect-error 至少需要一个原生测试文件。
defineNodeTestRun("空运行", { files: [] });

const run = defineNodeTestRun("有效运行", {
  files: ["test/happy.test.mts"],
});
// @ts-expect-error 测试身份必须是文本。
nodeTestStatus("错误身份", run, { file: "test/happy.test.mts", name: 42 });

const status = nodeTestStatus("状态", run, {
  file: "test/happy.test.mts",
  name: "主要业务状态符合约定",
});

const amount = defineNodeTestObservation("business.amount", 0);
// @ts-expect-error sample=0 只推导 number，不允许记录文本。
amount.record("17");
// @ts-expect-error 状态引用只表示成功终态。
const failed: ReferenceValue<typeof status> = { status: "failed" };
void failed;

const declaredShape = defineNodeTestObservation("declared.shape", { count: 0 });
const shapeRun = defineNodeTestRun("观察值声明", {
  files: ["test/happy.test.mts"],
  observations: [declaredShape],
});
const incompatibleShape = defineNodeTestObservation("declared.shape", {
  count: 0,
  label: "",
});
const shapeReference = nodeTestObservation(
  "观察值引用",
  shapeRun,
  { file: "test/happy.test.mts", name: "主要业务状态符合约定" },
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
const undeclaredShape = defineNodeTestObservation("undeclared.shape", 0);
nodeTestObservation(
  "未声明键",
  shapeRun,
  { file: "test/happy.test.mts", name: "主要业务状态符合约定" },
  // @ts-expect-error helper 键必须属于该运行。
  undeclaredShape,
);

const richerShape = defineNodeTestObservation("reverse.shape", {
  count: 0,
  label: "",
});
const richerRun = defineNodeTestRun("反向观察类型检查", {
  files: ["test/happy.test.mts"],
  observations: [richerShape],
});
const narrowerShape = defineNodeTestObservation("reverse.shape", {
  count: 0,
});
nodeTestObservation(
  "反向不兼容观察值引用",
  richerRun,
  { file: "test/happy.test.mts", name: "主要业务状态符合约定" },
  // @ts-expect-error 运行声明额外保证 label，不能用较窄 helper 隐去它。
  narrowerShape,
);

// @ts-expect-error 状态引用必须由对应的 Node 插件处理。
defineConfig({ plugins: [], bindings: [binding("缺失插件", [status])] });

defineConfig({
  plugins: [nodeTest],
  bindings: [binding("有效声明", [status])],
});
