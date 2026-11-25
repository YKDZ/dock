import { binding, defineConfig } from "@boringparts/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@boringparts/dock/node-test";

const firstRun = defineNodeTestRun("conflicting-identity", {
  files: ["test/conflict-first.test.mts"],
  testRoot: "test-workspace",
});
const secondRun = defineNodeTestRun("conflicting-identity", {
  files: ["test/conflict-second.test.mts"],
  testRoot: "test-workspace",
});
const first = nodeTestStatus("conflict-first", firstRun, {
  file: "test/conflict-first.test.mts",
  name: "first conflicting command must not start",
});
const second = nodeTestStatus("conflict-second", secondRun, {
  file: "test/conflict-second.test.mts",
  name: "second conflicting command must not start",
});

export default defineConfig({
  plugins: [nodeTest],
  bindings: [
    binding("first-conflict", [first]),
    binding("second-conflict", [second]),
  ],
});
