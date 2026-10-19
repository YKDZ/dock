import assert from "node:assert/strict";

import { binding, createReference, defineConfig } from "@ykdz/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestPluginId,
  nodeTestStatus,
} from "@ykdz/dock-reference-node-test";

assert.throws(
  () => defineNodeTestRun("空文件", { files: [] }),
  /至少一个测试文件/,
);
assert.throws(
  () =>
    defineNodeTestRun("非法筛选", {
      files: ["test/happy.test.mts"],
      namePattern: "[",
    }),
  /namePattern 无效/,
);

const validRun = defineNodeTestRun("有效运行", {
  files: ["test/happy.test.mts"],
});
assert.throws(
  () => nodeTestStatus("空名称", validRun, { file: "test.mts", name: "" }),
  /有效文件和测试名称/,
);

const malformed = createReference(nodeTestPluginId, "动态错误", {
  kind: "node-test-status",
  run: { identity: "空文件运行", files: [] },
  file: "test/happy.test.mts",
  name: "主要业务状态符合约定",
});
assert.throws(
  () =>
    defineConfig({
      plugins: [nodeTest],
      bindings: [binding("动态错误", [malformed])],
    }),
  /至少一个测试文件/,
);

const validStatus = nodeTestStatus("正常状态", validRun, {
  file: "test/happy.test.mts",
  name: "正常测试通过",
});
const unsupportedSelection = createReference(
  nodeTestPluginId,
  "不支持选择",
  validStatus.target,
  { selection: { kind: "unsupported" } },
);
assert.throws(
  () =>
    defineConfig({
      plugins: [nodeTest],
      bindings: [binding("不支持选择", [unsupportedSelection])],
    }),
  /不支持 selection/,
);
