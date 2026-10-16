import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@dock/reference-node-test";
import { binding, defineConfig } from "@dock/sdk";

const run = defineNodeTestRun("名称筛选", {
  files: ["test/filtered.test.mts"],
  testRoot: "test-workspace",
  namePattern: "筛选保留",
});
const filtered = nodeTestStatus("已筛除", run, {
  file: "test/filtered.test.mts",
  name: "应被名称筛选排除",
});
const passed = nodeTestStatus("保留通过", run, {
  file: "test/filtered.test.mts",
  name: "筛选保留的业务测试",
});

export default defineConfig({
  plugins: [nodeTest],
  bindings: [binding("被筛除", [filtered]), binding("筛选保留", [passed])],
});
