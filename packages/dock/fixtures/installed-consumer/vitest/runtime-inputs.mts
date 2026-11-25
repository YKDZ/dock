import assert from "node:assert/strict";

import { binding, createReference, defineConfig } from "@ykdz/dock";
import {
  defineVitestObservation,
  defineVitestRun,
  vitest,
  vitestPluginId,
  vitestStatus,
  vitestSuite,
} from "@ykdz/dock/vitest";

assert.throws(
  () => defineVitestRun("empty files", { files: [] }),
  /at least one test file/,
);
assert.throws(
  () =>
    defineVitestRun("missing additional test name", {
      files: ["test/retry.test.mts"],
      additionalTests: [{ file: "test/retry.test.mts" }] as never,
    }),
  /additionalTests/,
);

const declared = defineVitestObservation("declared", { count: 0 });
const secondary = defineVitestObservation("secondary", { active: true });
const unregistered = defineVitestObservation("unregistered", { title: "" });
const validRun = defineVitestRun("valid run", {
  files: ["test/retry.test.mts"],
  observations: [declared, secondary],
});
assert.throws(
  () =>
    vitestStatus("empty title", validRun, {
      file: "test/retry.test.mts",
      name: "",
    }),
  /valid file and full test name/,
);
assert.throws(
  () =>
    vitestSuite(
      "empty path",
      validRun,
      { file: "test/retry.test.mts", suitePath: [] as never },
      [declared],
    ),
  /file and a non-empty native suitePath/,
);
assert.throws(
  () =>
    vitestSuite(
      "unregistered observation key",
      validRun,
      { file: "test/retry.test.mts", suitePath: ["suite"] },
      [unregistered] as never,
    ),
  /does not declare observation key unregistered/,
);
assert.throws(
  () =>
    vitestSuite(
      "duplicate observation key",
      validRun,
      { file: "test/retry.test.mts", suitePath: ["suite"] },
      [declared, declared] as never,
    ),
  /observation keys must be unique/,
);

const malformed = createReference(vitestPluginId, "dynamic error", {
  kind: "vitest-test-status",
  run: { identity: "empty file run", files: [] },
  file: "test/retry.test.mts",
  name: "retry > finally passes",
});
assert.throws(
  () =>
    defineConfig({
      plugins: [vitest],
      bindings: [binding("dynamic error", [malformed])],
    }),
  /at least one test file/,
);

const validStatus = vitestStatus("normal status", validRun, {
  file: "test/retry.test.mts",
  name: "retry > finally passes",
});
const unsupportedSelection = createReference(
  vitestPluginId,
  "unsupported selection",
  validStatus.target,
  { selection: { kind: "unsupported" } },
);
assert.throws(
  () =>
    defineConfig({
      plugins: [vitest],
      bindings: [binding("unsupported selection", [unsupportedSelection])],
    }),
  /does not support selection/,
);
