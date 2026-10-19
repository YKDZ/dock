import { binding, defineConfig } from "@ykdz/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@ykdz/dock-reference-node-test";

const run = defineNodeTestRun("取消中的子测试", {
  files: ["test/cancelled.test.mts"],
  testRoot: "test-workspace",
});
const entered = nodeTestStatus("已进入子测试", run, {
  file: "test/cancelled.test.mts",
  name: "父级失败 > 已进入回调的子测试",
});
const unentered = nodeTestStatus("未进入子测试", run, {
  file: "test/cancelled.test.mts",
  name: "父级失败 > 未进入回调的子测试",
});

export default defineConfig({
  plugins: [nodeTest],
  bindings: [binding("已进入", [entered]), binding("未进入", [unentered])],
});
