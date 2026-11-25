import { binding, defineConfig } from "@boringparts/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@boringparts/dock/node-test";

const run = defineNodeTestRun("shared-teardown-failure", {
  files: ["test/close-failure.test.mts"],
  testRoot: "test-workspace",
});
const status = nodeTestStatus("pre-teardown-status", run, {
  file: "test/close-failure.test.mts",
  name: "business assertion passes before teardown",
});

export default defineConfig({
  plugins: [nodeTest],
  bindings: [binding("close-status", [status])],
});
