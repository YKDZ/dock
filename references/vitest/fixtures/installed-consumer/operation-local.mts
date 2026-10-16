import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineVitestRun, vitest, vitestStatus } from "@dock/reference-vitest";
import { binding, check, defineConfig, updateBaseline } from "@dock/sdk";

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
assert.deepEqual(first.execution, {
  commandAttempts: 1,
  failedCommands: 0,
  testExecutions: 1,
});
const updated = await updateBaseline(config);
assert.equal(updated.status, "updated");
assert.deepEqual(updated.report.execution, {
  commandAttempts: 1,
  failedCommands: 0,
  testExecutions: 1,
});
const third = await check(config);
assert.deepEqual(third.execution, {
  commandAttempts: 1,
  failedCommands: 0,
  testExecutions: 1,
});
assert.equal(
  readFileSync(
    resolve(process.cwd(), "maintenance-root", "operation-count.txt"),
    "utf8",
  ),
  "xxx",
);
