import { binding, defineConfig, type ReferenceValue } from "@ykdz/dock";
import {
  defineVitestObservation,
  defineVitestRun,
  vitestSuite,
} from "@ykdz/dock-reference-vitest";

const declared = defineVitestObservation("declared", { count: 0 });
const run = defineVitestRun("组成员错误类型", {
  files: ["test/groups.test.mts"],
  observations: [declared],
});
const other = defineVitestObservation("other", { label: "" });
const unregistered = vitestSuite(
  "unregistered",
  run,
  {
    file: "test/groups.test.mts",
    suitePath: ["preview config"],
  },
  // @ts-expect-error 组只能选择本次 run 声明的观察。
  [other],
);
const suite = vitestSuite(
  "invalid-member-value",
  run,
  { file: "test/groups.test.mts", suitePath: ["preview config"] },
  [declared],
);
const incompatible = defineVitestObservation("declared", {
  count: 0,
  label: "",
});
vitestSuite(
  "incompatible-helper",
  run,
  { file: "test/groups.test.mts", suitePath: ["preview config"] },
  // @ts-expect-error 同键观察 helper 也必须符合本次运行声明的值契约。
  [incompatible],
);
const invalidValue: ReferenceValue<typeof suite> = [
  // @ts-expect-error 成员观察值必须保留声明的 count 结构。
  { key: "declared", value: { label: "wrong" } },
];
vitestSuite(
  "empty-path",
  run,
  // @ts-expect-error 原生测试组路径不能为空。
  { file: "test/groups.test.mts", suitePath: [] },
  [declared],
);
void unregistered;
void invalidValue;

const valid = vitestSuite(
  "valid",
  run,
  { file: "test/groups.test.mts", suitePath: ["preview config"] },
  [declared],
);
// @ts-expect-error 测试组引用必须由 Vitest 插件处理。
defineConfig({ plugins: [], bindings: [binding("缺少插件", [valid])] });
