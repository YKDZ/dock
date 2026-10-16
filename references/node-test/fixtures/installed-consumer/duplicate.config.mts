import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@dock/reference-node-test";
import { binding, defineConfig } from "@dock/sdk";

const run = defineNodeTestRun("重复身份", {
  files: ["test/duplicate.test.mts"],
  testRoot: "test-workspace",
});
const status = nodeTestStatus("重复状态", run, {
  file: "test/duplicate.test.mts",
  name: "重复业务身份",
});

export default defineConfig({
  plugins: [nodeTest],
  bindings: [binding("重复业务", [status])],
});
