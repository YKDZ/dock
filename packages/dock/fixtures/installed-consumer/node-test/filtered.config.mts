import { binding, defineConfig } from "@boringparts/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@boringparts/dock/node-test";

const run = defineNodeTestRun("name-filter", {
  files: ["test/filtered.test.mts"],
  testRoot: "test-workspace",
  namePattern: "filter-kept",
});
const filtered = nodeTestStatus("filtered-out", run, {
  file: "test/filtered.test.mts",
  name: "should be excluded by name filter",
});
const passed = nodeTestStatus("kept-passed", run, {
  file: "test/filtered.test.mts",
  name: "filter-kept business test",
});

export default defineConfig({
  plugins: [nodeTest],
  bindings: [
    binding("filtered-binding", [filtered]),
    binding("kept-binding", [passed]),
  ],
});
