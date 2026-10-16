import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  defineNodeTestRun,
  nodeTest,
  nodeTestStatus,
} from "@dock/reference-node-test";
import { binding, check, defineConfig, updateBaseline } from "@dock/sdk";

const run = defineNodeTestRun("同进程连续操作", {
  files: ["test/operation-local.test.mts"],
  testRoot: "test-workspace",
});
const status = nodeTestStatus("连续操作状态", run, {
  file: "test/operation-local.test.mts",
  name: "每次维护都重新执行",
});
const config = defineConfig({
  plugins: [nodeTest],
  bindings: [binding("连续操作关联", [status])],
});

const first = await check(config);
assert.deepEqual(first.execution, { commandAttempts: 1, testExecutions: 1 });
const updated = await updateBaseline(config);
assert.equal(updated.status, "updated");
assert.deepEqual(updated.report.execution, {
  commandAttempts: 1,
  testExecutions: 1,
});
const third = await check(config);
assert.deepEqual(third.execution, { commandAttempts: 1, testExecutions: 1 });
assert.equal(
  readFileSync(resolve(process.cwd(), "operation-count.txt"), "utf8"),
  "xxx",
);
