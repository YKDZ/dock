import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@dock/reference-node-test";
import { binding, defineConfig, type ReferenceValue } from "@dock/sdk";

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
// @ts-expect-error 状态引用只表示成功终态。
const failed: ReferenceValue<typeof status> = { status: "failed" };
void failed;

// @ts-expect-error 状态引用必须由对应的 Node 插件处理。
defineConfig({ plugins: [], bindings: [binding("缺失插件", [status])] });

defineConfig({
  plugins: [nodeTest],
  bindings: [binding("有效声明", [status])],
});
