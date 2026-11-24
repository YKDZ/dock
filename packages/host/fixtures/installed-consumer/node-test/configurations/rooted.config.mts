import { binding, defineConfig } from "@ykdz/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@ykdz/dock/node-test";

const run = defineNodeTestRun("effective-root-run", {
  files: ["test/rooted.test.mts"],
  testRoot: "test-workspace",
});
const status = nodeTestStatus("effective-root-status", run, {
  file: "test/rooted.test.mts",
  name: "working directory resolves to effective root",
});

export default defineConfig({
  root: "../effective-root",
  baseline: "rooted.baseline.json",
  plugins: [nodeTest],
  bindings: [binding("effective-root-maintenance", [status])],
});
