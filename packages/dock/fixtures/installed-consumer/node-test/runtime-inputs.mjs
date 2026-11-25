import assert from "node:assert/strict";

import { binding, createReference, defineConfig } from "@boringparts/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestPluginId,
  nodeTestStatus,
} from "@boringparts/dock/node-test";

assert.throws(
  () => defineNodeTestRun("empty-files", { files: [] }),
  /at least one test file/,
);
assert.throws(
  () =>
    defineNodeTestRun("invalid-pattern", {
      files: ["test/happy.test.mts"],
      namePattern: "[",
    }),
  /Invalid Node test namePattern/,
);

const validRun = defineNodeTestRun("valid-run", {
  files: ["test/happy.test.mts"],
});
assert.throws(
  () => nodeTestStatus("empty-name", validRun, { file: "test.mts", name: "" }),
  /valid file and test name/,
);

const malformed = createReference(nodeTestPluginId, "dynamic-error", {
  kind: "node-test-status",
  run: { identity: "empty-files-run", files: [] },
  file: "test/happy.test.mts",
  name: "primary business status meets expectation",
});
assert.throws(
  () =>
    defineConfig({
      plugins: [nodeTest],
      bindings: [binding("dynamic-error", [malformed])],
    }),
  /at least one test file/,
);

const validStatus = nodeTestStatus("normal-status", validRun, {
  file: "test/happy.test.mts",
  name: "normal test passes",
});
const unsupportedSelection = createReference(
  nodeTestPluginId,
  "unsupported-selection",
  validStatus.target,
  { selection: { kind: "unsupported" } },
);
assert.throws(
  () =>
    defineConfig({
      plugins: [nodeTest],
      bindings: [binding("unsupported-selection", [unsupportedSelection])],
    }),
  /do not support selection/,
);
