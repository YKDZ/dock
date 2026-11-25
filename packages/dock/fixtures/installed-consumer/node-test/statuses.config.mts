import { binding, defineConfig } from "@ykdz/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@ykdz/dock/node-test";

const run = defineNodeTestRun("non-passing-statuses", {
  files: ["test/statuses.test.mts"],
  testRoot: "test-workspace",
});
const skipped = nodeTestStatus("skipped-status", run, {
  file: "test/statuses.test.mts",
  name: "skipped business status",
});
const todo = nodeTestStatus("todo-status", run, {
  file: "test/statuses.test.mts",
  name: "todo business status",
});

export default defineConfig({
  plugins: [nodeTest],
  bindings: [binding("non-passing-binding", [skipped, todo])],
});
