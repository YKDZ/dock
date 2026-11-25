import { binding, defineConfig } from "@boringparts/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@boringparts/dock/node-test";

const run = defineNodeTestRun("cancelling-subtests", {
  files: ["test/cancelled.test.mts"],
  testRoot: "test-workspace",
});
const entered = nodeTestStatus("entered-subtest", run, {
  file: "test/cancelled.test.mts",
  name: "parent fails > subtest entered callback",
});
const unentered = nodeTestStatus("unentered-subtest", run, {
  file: "test/cancelled.test.mts",
  name: "parent fails > subtest did not enter callback",
});

export default defineConfig({
  plugins: [nodeTest],
  bindings: [binding("entered", [entered]), binding("unentered", [unentered])],
});
