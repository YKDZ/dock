import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

await copyFile(
  join("test-workspace", "test", "happy.test.mts"),
  join("test-workspace", "test", "moved.test.mts"),
);
await writeFile(
  "scope.config.mjs",
  `import { defineNodeTestRun, nodeTest, nodeTestStatus } from "@dock/reference-node-test";\nimport { binding, defineConfig } from "@dock/sdk";\nconst target = process.env.DOCK_NODE_SCOPE_TARGET ?? "test/happy.test.mts";\nconst run = defineNodeTestRun("scope-run", { files: [target, "test/ordinary.test.mts"], testRoot: "test-workspace" });\nconst happy = nodeTestStatus("scope-happy-ref", run, { file: target, name: "主要业务状态符合约定" });\nconst ordinaryRun = defineNodeTestRun("scope-run", { files: [target, "test/ordinary.test.mts"], testRoot: "test-workspace" });\nconst ordinary = nodeTestStatus("scope-ordinary-ref", ordinaryRun, { file: "test/ordinary.test.mts", name: "普通 Node 原生命令保持原有业务语义" });\nexport default defineConfig({ plugins: [nodeTest], baseline: "scope.baseline.json", bindings: [binding("scope-happy", [happy]), binding("scope-ordinary", [ordinary])] });\n`,
  "utf8",
);

const bin = join(
  "node_modules",
  ".bin",
  process.platform === "win32" ? "dock.cmd" : "dock",
);
const updated = invoke(bin, [
  "baseline",
  "update",
  "--config",
  "scope.config.mjs",
  "--json",
]);
assert.equal(updated.status, 0, updated.stderr);
const initialBaseline = await readFile("scope.baseline.json");
const baseline = JSON.parse(initialBaseline.toString("utf8"));

const currentFile = invoke(bin, [
  "check",
  "--config",
  "scope.config.mjs",
  "--file",
  "test-workspace/test/happy.test.mts",
  "--json",
]);
assert.equal(currentFile.status, 0, currentFile.stderr);
assert.deepEqual(parse(currentFile.stdout).data.report.scope, ["scope-happy"]);

const movedFile = invoke(
  bin,
  [
    "check",
    "--config",
    "scope.config.mjs",
    "--file",
    "test-workspace/test/happy.test.mts",
    "--json",
  ],
  { DOCK_NODE_SCOPE_TARGET: "test/moved.test.mts" },
);
assert.equal(movedFile.status, 1, movedFile.stderr);
const movedReport = parse(movedFile.stdout).data.report;
assert.deepEqual(movedReport.scope, ["scope-happy"]);
assert.deepEqual(
  movedReport.bindings[0].changes.map((change) => change.kind),
  ["reference-definition"],
);

const localUpdate = invoke(
  bin,
  [
    "baseline",
    "update",
    "--config",
    "scope.config.mjs",
    "--file",
    "test-workspace/test/happy.test.mts",
    "--json",
  ],
  { DOCK_NODE_SCOPE_TARGET: "test/moved.test.mts" },
);
assert.equal(localUpdate.status, 0, localUpdate.stderr);
assert.deepEqual(parse(localUpdate.stdout).data.report.scope, ["scope-happy"]);
const nextBaselineBytes = await readFile("scope.baseline.json");
const nextBaseline = JSON.parse(nextBaselineBytes.toString("utf8"));
assert.deepEqual(
  nextBaseline.bindings["scope-ordinary"],
  baseline.bindings["scope-ordinary"],
);

const union = invoke(
  bin,
  [
    "check",
    "--config",
    "scope.config.mjs",
    "--file",
    "test-workspace/test/moved.test.mts",
    "--reference",
    "scope-ordinary-ref",
    "--json",
  ],
  { DOCK_NODE_SCOPE_TARGET: "test/moved.test.mts" },
);
assert.equal(union.status, 1, union.stderr);
assert.deepEqual(parse(union.stdout).data.report.scope, [
  "scope-happy",
  "scope-ordinary",
]);

const unmatched = invoke(bin, [
  "check",
  "--config",
  "scope.config.mjs",
  "--file",
  "test-workspace/missing.test.mts",
  "--json",
]);
assert.equal(unmatched.status, 1);
assert.equal(parse(unmatched.stderr).data.code, "scope-selector-unmatched");
assert.deepEqual(await readFile("scope.baseline.json"), nextBaselineBytes);

await writeFile(
  "scope-conflict.config.mjs",
  `import { defineNodeTestRun, nodeTest, nodeTestStatus } from "@dock/reference-node-test";\nimport { binding, defineConfig } from "@dock/sdk";\nconst happyRun = defineNodeTestRun("shared-node-run", { files: ["test/happy.test.mts"], testRoot: "test-workspace" });\nconst ordinaryRun = defineNodeTestRun("shared-node-run", { files: ["test/ordinary.test.mts"], testRoot: "test-workspace" });\nexport default defineConfig({ plugins: [nodeTest], baseline: "scope.baseline.json", bindings: [binding("selected-conflict", [nodeTestStatus("conflict-happy", happyRun, { file: "test/happy.test.mts", name: "主要业务状态符合约定" })]), binding("unselected-conflict", [nodeTestStatus("conflict-ordinary", ordinaryRun, { file: "test/ordinary.test.mts", name: "普通 Node 原生命令保持原有业务语义" })])] });\n`,
  "utf8",
);
const preflight = invoke(bin, [
  "check",
  "--config",
  "scope-conflict.config.mjs",
  "--binding",
  "selected-conflict",
  "--json",
]);
assert.equal(preflight.status, 1);
assert.equal(
  parse(preflight.stderr).data.code,
  "plugin-reference-validation-failed",
);
assert.deepEqual(await readFile("scope.baseline.json"), nextBaselineBytes);

function invoke(executable, arguments_, env = {}) {
  return spawnSync(executable, arguments_, {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function parse(output) {
  return JSON.parse(output);
}
