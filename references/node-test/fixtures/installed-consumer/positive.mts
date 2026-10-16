import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@dock/reference-node-test";
import { binding, defineConfig, type ReferenceValue } from "@dock/sdk";

const run = defineNodeTestRun("状态检查", {
  files: ["test/happy.test.mts"],
  testRoot: "test-workspace",
});
const status = nodeTestStatus("状态引用", run, {
  file: "test/happy.test.mts",
  name: "主要业务状态符合约定",
});
const expected: ReferenceValue<typeof status> = { status: "passed" };
void expected;

export default defineConfig({
  plugins: [nodeTest],
  bindings: [binding("业务状态", [status])],
});
