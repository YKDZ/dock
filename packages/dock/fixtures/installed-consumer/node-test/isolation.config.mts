import { binding, defineConfig } from "@boringparts/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@boringparts/dock/node-test";

const run = defineNodeTestRun("scoped-assertion-failure", {
  files: ["test/isolation.test.mts"],
  testRoot: "test-workspace",
});
const failed = nodeTestStatus("failed-test", run, {
  file: "test/isolation.test.mts",
  name: "selected business assertion fails",
});
const passed = nodeTestStatus("independent-test", run, {
  file: "test/isolation.test.mts",
  name: "independent business assertion passes",
});

export default defineConfig({
  baseline: "isolation.baseline.json",
  plugins: [nodeTest],
  bindings: [
    binding("failing-business", [failed]),
    binding("independent-business", [passed]),
  ],
});
