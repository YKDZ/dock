import assert from "node:assert/strict";

import { binding, createReference, defineConfig } from "@ykdz/dock";
import {
  defineVitestObservation,
  defineVitestRun,
  vitest,
  vitestPluginId,
  vitestStatus,
  vitestSuite,
} from "@ykdz/dock-reference-vitest";

assert.throws(
  () => defineVitestRun("空文件", { files: [] }),
  /至少一个测试文件/,
);
assert.throws(
  () =>
    defineVitestRun("缺少附加测试标题", {
      files: ["test/retry.test.mts"],
      additionalTests: [{ file: "test/retry.test.mts" }] as never,
    }),
  /additionalTests/,
);

const declared = defineVitestObservation("declared", { count: 0 });
const secondary = defineVitestObservation("secondary", { active: true });
const unregistered = defineVitestObservation("unregistered", { title: "" });
const validRun = defineVitestRun("有效运行", {
  files: ["test/retry.test.mts"],
  observations: [declared, secondary],
});
assert.throws(
  () =>
    vitestStatus("空标题", validRun, {
      file: "test/retry.test.mts",
      name: "",
    }),
  /有效文件和完整测试标题/,
);
assert.throws(
  () =>
    vitestSuite(
      "空路径",
      validRun,
      { file: "test/retry.test.mts", suitePath: [] as never },
      [declared],
    ),
  /文件和非空原生路径/,
);
assert.throws(
  () =>
    vitestSuite(
      "未声明观察键",
      validRun,
      { file: "test/retry.test.mts", suitePath: ["suite"] },
      [unregistered] as never,
    ),
  /未声明观察键 unregistered/,
);
assert.throws(
  () =>
    vitestSuite(
      "重复观察键",
      validRun,
      { file: "test/retry.test.mts", suitePath: ["suite"] },
      [declared, declared] as never,
    ),
  /观察键必须唯一/,
);

const malformed = createReference(vitestPluginId, "动态错误", {
  kind: "vitest-test-status",
  run: { identity: "空文件运行", files: [] },
  file: "test/retry.test.mts",
  name: "重试 > 最终通过",
});
assert.throws(
  () =>
    defineConfig({
      plugins: [vitest],
      bindings: [binding("动态错误", [malformed])],
    }),
  /至少一个测试文件/,
);

const validStatus = vitestStatus("正常状态", validRun, {
  file: "test/retry.test.mts",
  name: "重试 > 最终通过",
});
const unsupportedSelection = createReference(
  vitestPluginId,
  "不支持选择",
  validStatus.target,
  { selection: { kind: "unsupported" } },
);
assert.throws(
  () =>
    defineConfig({
      plugins: [vitest],
      bindings: [binding("不支持选择", [unsupportedSelection])],
    }),
  /不支持 selection/,
);
