import { binding, defineConfig } from "@boringparts/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@boringparts/dock/node-test";

const run = defineNodeTestRun("process-interruption", {
  files: ["test/interrupted.test.mts"],
  testRoot: "test-workspace",
});
const status = nodeTestStatus("interrupted-status", run, {
  file: "test/interrupted.test.mts",
  name: "exits after signal",
});

export default defineConfig({
  plugins: [nodeTest],
  bindings: [binding("interrupted-binding", [status])],
  baseline: "interrupted.baseline.json",
});
