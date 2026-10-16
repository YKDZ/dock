import assert from "node:assert/strict";

import {
  defineVitestRun,
  vitest,
  vitestPluginId,
  vitestStatus,
} from "@dock/reference-vitest";
import { binding, createReference, defineConfig } from "@dock/sdk";

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

const validRun = defineVitestRun("有效运行", {
  files: ["test/retry.test.mts"],
});
assert.throws(
  () =>
    vitestStatus("空标题", validRun, {
      file: "test/retry.test.mts",
      name: "",
    }),
  /有效文件和完整测试标题/,
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
