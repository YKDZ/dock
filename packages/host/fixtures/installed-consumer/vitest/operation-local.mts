import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { binding, check, defineConfig, updateBaseline } from "@ykdz/dock";
import { defineVitestRun, vitest, vitestStatus } from "@ykdz/dock/vitest";

const run = defineVitestRun("same-process consecutive maintenance", {
  files: ["test/operation-local.test.mts"],
  testRoot: "../test-workspace",
});
const status = vitestStatus("consecutive operation status", run, {
  file: "test/operation-local.test.mts",
  name: "re-executed on every maintenance",
});
const config = defineConfig({
  root: "maintenance-root",
  baseline: "operation.baseline.json",
  plugins: [vitest],
  bindings: [binding("consecutive operation binding", [status])],
});

const first = await check(config);
assertFreshRun(first);
const updated = await updateBaseline(config);
assert.equal(updated.status, "updated");
assertFreshRun(updated.report);
const third = await check(config);
assertFreshRun(third);
assert.equal(
  readFileSync(
    resolve(process.cwd(), "maintenance-root", "operation-count.txt"),
    "utf8",
  ),
  "xxx",
);

function assertFreshRun(report: {
  readonly pluginDiagnostics: readonly {
    readonly pluginId: string;
    readonly data: unknown;
  }[];
}): void {
  const plugin = report.pluginDiagnostics.find(
    ({ pluginId }) => pluginId === "@ykdz/dock-reference-vitest",
  );
  assert.ok(plugin);
  assert.deepEqual(
    (
      plugin.data as {
        readonly runs: readonly {
          readonly identity: string;
          readonly testAttempts: number;
        }[];
      }
    ).runs.map(({ identity, testAttempts }) => ({ identity, testAttempts })),
    [{ identity: "same-process consecutive maintenance", testAttempts: 1 }],
  );
}
