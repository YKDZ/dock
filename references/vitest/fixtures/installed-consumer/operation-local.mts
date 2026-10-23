import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { binding, check, defineConfig, updateBaseline } from "@ykdz/dock";
import {
  defineVitestRun,
  vitest,
  vitestStatus,
} from "@ykdz/dock-reference-vitest";

const run = defineVitestRun("同进程连续维护", {
  files: ["test/operation-local.test.mts"],
  testRoot: "../test-workspace",
});
const status = vitestStatus("连续操作状态", run, {
  file: "test/operation-local.test.mts",
  name: "每次维护都重新执行",
});
const config = defineConfig({
  root: "maintenance-root",
  baseline: "operation.baseline.json",
  plugins: [vitest],
  bindings: [binding("连续操作关联", [status])],
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
    [{ identity: "同进程连续维护", testAttempts: 1 }],
  );
}
