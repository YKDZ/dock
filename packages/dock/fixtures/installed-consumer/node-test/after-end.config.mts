import { binding, defineConfig } from "@boringparts/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@boringparts/dock/node-test";

const run = defineNodeTestRun("async-failure-after-end", {
  files: ["test/after-end.test.mts"],
  testRoot: "test-workspace",
});
const status = nodeTestStatus("async-failure-after-end-status", run, {
  file: "test/after-end.test.mts",
  name: "selected native test passes",
});

export default defineConfig({
  plugins: [nodeTest],
  bindings: [binding("async-failure-binding", [status])],
  baseline: "after-end.baseline.json",
});
