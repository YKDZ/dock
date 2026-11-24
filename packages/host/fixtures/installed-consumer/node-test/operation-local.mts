import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  binding,
  check,
  defineConfig,
  inspect,
  updateBaseline,
} from "@ykdz/dock";
import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@ykdz/dock/node-test";

const run = defineNodeTestRun("in-process-sequential-operations", {
  files: ["test/operation-local.test.mts"],
  testRoot: "test-workspace",
});
const status = nodeTestStatus("sequential-operation-status", run, {
  file: "test/operation-local.test.mts",
  name: "re-executes on every maintenance operation",
});
const config = defineConfig({
  plugins: [nodeTest],
  bindings: [binding("sequential-operation-binding", [status])],
});

const resolution = await inspect(config);
const description = resolution.plugins.find(
  (plugin) => plugin.id === nodeTest.id,
)?.description;
assert.ok(description);
const describedRun = (
  description.data as {
    readonly runs: readonly {
      readonly identity: string;
      readonly configuration: {
        readonly root: string;
        readonly testRoot: string;
        readonly files: readonly string[];
      };
      readonly references: readonly string[];
      readonly selectedReferences: readonly string[];
    }[];
  }
).runs[0];
assert.ok(describedRun);
assert.equal(describedRun.identity, "in-process-sequential-operations");
assert.equal(describedRun.configuration.root, process.cwd());
assert.equal(
  describedRun.configuration.testRoot,
  resolve(process.cwd(), "test-workspace"),
);
assert.deepEqual(describedRun.configuration.files, [
  resolve(process.cwd(), "test-workspace/test/operation-local.test.mts"),
]);
assert.deepEqual(describedRun.references, ["sequential-operation-status"]);
assert.deepEqual(describedRun.selectedReferences, [
  "sequential-operation-status",
]);
assert.match(description.text.join("\n"), /in-process-sequential-operations/);
assert.throws(
  () => readFileSync(resolve(process.cwd(), "operation-count.txt")),
  { code: "ENOENT" },
);

const first = await check(config);
assertNodeDiagnostics(first);
const updated = await updateBaseline(config);
assert.equal(updated.status, "updated");
assertNodeDiagnostics(updated.report);
const third = await check(config);
assertNodeDiagnostics(third);
assert.equal(
  readFileSync(resolve(process.cwd(), "operation-count.txt"), "utf8"),
  "xxx",
);

function assertNodeDiagnostics(report: {
  readonly pluginDiagnostics: readonly {
    readonly pluginId: string;
    readonly data: unknown;
  }[];
  readonly pluginErrors: readonly unknown[];
}): void {
  const diagnostic = report.pluginDiagnostics.find(
    (item) => item.pluginId === nodeTest.id,
  );
  assert.ok(diagnostic);
  assert.deepEqual(report.pluginErrors, []);
  const run = (
    diagnostic.data as {
      readonly runs: readonly {
        readonly identity: string;
        readonly commandAttempts: number;
        readonly failedCommands: number;
        readonly testExecutions: number;
        readonly failures: readonly unknown[];
      }[];
    }
  ).runs[0];
  assert.ok(run);
  assert.equal(run.identity, "in-process-sequential-operations");
  assert.equal(run.commandAttempts, 1);
  assert.equal(run.failedCommands, 0);
  assert.equal(run.testExecutions, 1);
  assert.deepEqual(run.failures, []);
}
