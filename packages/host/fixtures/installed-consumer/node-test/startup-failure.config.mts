import { binding, defineConfig } from "@ykdz/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@ykdz/dock/node-test";

const run = defineNodeTestRun("missing-file", {
  files: ["test/missing.test.mts"],
  testRoot: "test-workspace",
});
const status = nodeTestStatus("missing-test", run, {
  file: "test/missing.test.mts",
  name: "missing test",
});

export default defineConfig({
  plugins: [nodeTest],
  bindings: [binding("startup-failure", [status])],
});
