import { binding, defineConfig } from "@ykdz/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@ykdz/dock/node-test";

const run = defineNodeTestRun("duplicate-identity", {
  files: ["test/duplicate.test.mts"],
  testRoot: "test-workspace",
});
const status = nodeTestStatus("duplicate-status", run, {
  file: "test/duplicate.test.mts",
  name: "duplicate business identity",
});

export default defineConfig({
  plugins: [nodeTest],
  bindings: [binding("duplicate-binding", [status])],
});
