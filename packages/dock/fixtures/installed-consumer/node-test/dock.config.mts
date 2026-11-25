import { binding, defineConfig } from "@ykdz/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@ykdz/dock/node-test";

const run = defineNodeTestRun("business-run", {
  files: ["test/happy.test.mts"],
  testRoot: "test-workspace",
});
const first = nodeTestStatus("primary-business-status", run, {
  file: "test/happy.test.mts",
  name: "primary business status meets expectation",
});
const second = nodeTestStatus("secondary-business-status", run, {
  file: "test/happy.test.mts",
  name: "secondary business status meets expectation",
});

export default defineConfig({
  plugins: [nodeTest],
  bindings: [binding("business-acceptance", [first, second])],
});
