import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { file } from "@dock/reference-file";
import {
  binding,
  check,
  createReference,
  defineConfig,
  definePlugin,
  updateBaseline,
} from "@dock/sdk";

await writeFile("alpha.txt", "alpha one\n", "utf8");
await writeFile("alpha-extra.txt", "alpha two\n", "utf8");
await writeFile("beta.txt", "beta one\n", "utf8");
await writeFile("alpha-moved.txt", "alpha moved\n", "utf8");

const original = defineConfig({
  plugins: [file],
  bindings: [
    binding("alpha", [
      file.from("alpha.txt").reference("alpha-reference"),
      file.from("alpha-extra.txt").reference("alpha-extra-reference"),
    ]),
    binding("beta", [file.from("beta.txt").reference("beta-reference")]),
  ],
});
assert.equal((await updateBaseline(original)).status, "updated");

const moved = defineConfig({
  plugins: [file],
  bindings: [
    binding("alpha", [
      file.from("alpha-moved.txt").reference("alpha-reference"),
      file.from("alpha-extra.txt").reference("alpha-extra-reference"),
    ]),
    binding("beta", [file.from("beta.txt").reference("beta-reference")]),
  ],
});

assert.deepEqual(
  (await check(moved, { reference: ["alpha-reference"] })).scope,
  ["alpha"],
);
assert.deepEqual((await check(moved, { file: ["alpha-moved.txt"] })).scope, [
  "alpha",
]);
assert.deepEqual((await check(moved, { file: ["alpha.txt"] })).scope, [
  "alpha",
]);
assert.deepEqual(
  (await check(moved, { binding: ["alpha"], reference: ["beta-reference"] }))
    .scope,
  ["alpha", "beta"],
);

await rm("alpha-extra.txt");
const completeAssociation = await check(moved, {
  reference: ["alpha-reference"],
});
assert.deepEqual(completeAssociation.scope, ["alpha"]);
assert.ok("errors" in completeAssociation.bindings[0]);
await writeFile("alpha-extra.txt", "alpha two\n", "utf8");

const before = JSON.parse(await readFile("dock.baseline.json", "utf8"));
await writeFile("alpha-moved.txt", "alpha changed\n", "utf8");
await writeFile("beta.txt", "beta changed\n", "utf8");
const localUpdate = await updateBaseline(moved, { file: ["alpha.txt"] });
assert.equal(localUpdate.status, "updated");
assert.deepEqual(localUpdate.report.scope, ["alpha"]);
const after = JSON.parse(await readFile("dock.baseline.json", "utf8"));
assert.deepEqual(after.bindings.beta, before.bindings.beta);
assert.equal(
  after.bindings.alpha.references["alpha-reference"].value,
  "alpha changed\n",
);

await writeFile(
  "scope-cli-config.mjs",
  `import { file } from "@dock/reference-file";\nimport { binding, defineConfig } from "@dock/sdk";\nexport default defineConfig({ plugins: [file], bindings: [binding("alpha", [file.from("alpha-moved.txt").reference("alpha-reference"), file.from("alpha-extra.txt").reference("alpha-extra-reference")]), binding("beta", [file.from("beta.txt").reference("beta-reference")])] });\n`,
  "utf8",
);
const cli = resolve("../node_modules/.bin/dock");
const selectedCli = spawnSync(
  cli,
  [
    "check",
    "--config",
    "scope-cli-config.mjs",
    "--binding",
    "alpha",
    "--binding",
    "beta",
    "--reference",
    "beta-reference",
    "--file",
    "beta.txt",
    "--json",
  ],
  { encoding: "utf8" },
);
assert.equal(selectedCli.status, 1, selectedCli.stderr);
assert.deepEqual(JSON.parse(selectedCli.stdout).data.report.scope, [
  "alpha",
  "beta",
]);
const unmatchedCli = spawnSync(
  cli,
  [
    "check",
    "--config",
    "scope-cli-config.mjs",
    "--reference",
    "missing",
    "--json",
  ],
  { encoding: "utf8" },
);
assert.equal(unmatchedCli.status, 1);
assert.equal(
  JSON.parse(unmatchedCli.stderr).data.code,
  "scope-selector-unmatched",
);
const baselineBeforeUnmatchedUpdate = await readFile("dock.baseline.json");
const unmatchedUpdate = spawnSync(
  cli,
  [
    "baseline",
    "update",
    "--config",
    "scope-cli-config.mjs",
    "--reference",
    "missing",
    "--json",
  ],
  { encoding: "utf8" },
);
assert.equal(unmatchedUpdate.status, 1);
assert.equal(
  JSON.parse(unmatchedUpdate.stderr).data.code,
  "scope-selector-unmatched",
);
assert.deepEqual(
  await readFile("dock.baseline.json"),
  baselineBeforeUnmatchedUpdate,
);

const missing = defineConfig({
  plugins: [file],
  bindings: [
    binding("alpha", [
      file.from("missing-alpha.txt").reference("alpha-reference"),
      file.from("alpha-extra.txt").reference("alpha-extra-reference"),
    ]),
    binding("beta", [file.from("beta.txt").reference("beta-reference")]),
  ],
});
const missingReport = await check(missing, { file: ["missing-alpha.txt"] });
assert.deepEqual(missingReport.scope, ["alpha"]);
assert.ok("errors" in missingReport.bindings[0]);
const unselectedMissing = await check(missing, { file: ["beta.txt"] });
assert.deepEqual(unselectedMissing.scope, ["beta"]);
assert.ok(!("errors" in unselectedMissing.bindings[0]));

const withoutAlpha = defineConfig({
  plugins: [file],
  bindings: [
    binding("beta", [file.from("beta.txt").reference("beta-reference")]),
  ],
});
const historicalRemoval = await updateBaseline(withoutAlpha, {
  file: ["alpha-moved.txt"],
});
assert.equal(historicalRemoval.status, "updated");
assert.equal(historicalRemoval.report.bindings[0]?.untracked, true);
const afterRemoval = JSON.parse(await readFile("dock.baseline.json", "utf8"));
assert.deepEqual(Object.keys(afterRemoval.bindings), ["beta"]);

await assert.rejects(
  check(moved, { binding: ["alpha"], reference: ["missing-reference"] }),
  (error) => error.code === "scope-selector-unmatched",
);

const countedPlugin = definePlugin({
  id: "fixture:counted",
  validate() {},
  fileInfo(reference, context) {
    return resolve(context.root, reference.target.path);
  },
  collect(reference) {
    counted.set(reference.id, (counted.get(reference.id) ?? 0) + 1);
    return { kind: "value", value: reference.target.path };
  },
});
const counted = new Map();
const countedConfig = defineConfig({
  plugins: [countedPlugin],
  bindings: [
    binding("counted-a", [
      createReference(countedPlugin.id, "counted-ref-a", { path: "one.txt" }),
    ]),
    binding("counted-b", [
      createReference(countedPlugin.id, "counted-ref-b", { path: "two.txt" }),
    ]),
  ],
});
assert.deepEqual((await check(countedConfig, { file: ["one.txt"] })).scope, [
  "counted-a",
]);
assert.equal(counted.get("counted-ref-a"), 1);
assert.equal(counted.has("counted-ref-b"), false);

const identityCalls = { executeA: 0, executeB: 0, collectA: 0, collectB: 0 };
const identityPluginA = definePlugin({
  id: "fixture:identity-a",
  validate() {},
  fileInfo(reference, context) {
    return resolve(context.root, reference.target.path);
  },
  execution: {
    declare(references) {
      return [
        {
          identity: "shared-execution",
          configuration: { framework: "fixture", root: "one" },
          references: references.map((reference) => reference.id),
        },
      ];
    },
    execute() {
      identityCalls.executeA += 1;
      throw new Error("冲突运行不能启动。");
    },
  },
  collect() {
    identityCalls.collectA += 1;
    return { kind: "value", value: "a" };
  },
});
const identityPluginB = definePlugin({
  id: "fixture:identity-b",
  validate() {},
  fileInfo(reference, context) {
    return resolve(context.root, reference.target.path);
  },
  execution: {
    declare(references) {
      return [
        {
          identity: "shared-execution",
          configuration: { framework: "fixture", root: "two" },
          references: references.map((reference) => reference.id),
        },
      ];
    },
    execute() {
      identityCalls.executeB += 1;
      throw new Error("冲突运行不能启动。");
    },
  },
  collect() {
    identityCalls.collectB += 1;
    return { kind: "value", value: "b" };
  },
});
const crossPluginIdentityConfig = defineConfig({
  plugins: [identityPluginA, identityPluginB],
  bindings: [
    binding("identity-a", [
      createReference(identityPluginA.id, "identity-ref-a", {
        path: "one.txt",
      }),
    ]),
    binding("identity-b", [
      createReference(identityPluginB.id, "identity-ref-b", {
        path: "two.txt",
      }),
    ]),
  ],
});
await assert.rejects(
  check(crossPluginIdentityConfig, { binding: ["identity-a"] }),
  (error) => error.code === "execution-identity-conflict",
);
assert.deepEqual(identityCalls, {
  executeA: 0,
  executeB: 0,
  collectA: 0,
  collectB: 0,
});

const batchPlugin = definePlugin({
  id: "fixture:batch-validation",
  validate() {},
  validateReferences(references) {
    const configuration = new Map();
    for (const reference of references) {
      const prior = configuration.get(reference.target.identity);
      if (prior !== undefined && prior !== reference.target.configuration) {
        throw new TypeError("相同运行身份配置冲突。");
      }
      configuration.set(
        reference.target.identity,
        reference.target.configuration,
      );
    }
  },
  fileInfo(reference, context) {
    return resolve(context.root, reference.target.path);
  },
  collect() {
    return { kind: "value", value: "ok" };
  },
});
const batchConfig = defineConfig({
  plugins: [batchPlugin],
  bindings: [
    binding("batch-selected", [
      createReference(batchPlugin.id, "batch-a", {
        identity: "same-run",
        configuration: "one",
        path: "one.txt",
      }),
    ]),
    binding("batch-unselected", [
      createReference(batchPlugin.id, "batch-b", {
        identity: "same-run",
        configuration: "two",
        path: "two.txt",
      }),
    ]),
  ],
});
await assert.rejects(
  check(batchConfig, { binding: ["batch-selected"] }),
  (error) => error.code === "plugin-reference-validation-failed",
);

const rootA = resolve("root-a");
const rootB = resolve("root-b");
const rootSwitchBaseline = resolve("root-switch.baseline.json");
await mkdir(rootA, { recursive: true });
await mkdir(rootB, { recursive: true });
await writeFile(join(rootA, "guide.md"), "同一事实\n", "utf8");
await writeFile(join(rootB, "guide.md"), "同一事实\n", "utf8");
const rootConfig = (root) =>
  defineConfig({
    root,
    baseline: rootSwitchBaseline,
    plugins: [file],
    bindings: [
      binding("root-policy", [file.from("guide.md").reference("root-guide")]),
    ],
  });
const rootAConfig = rootConfig(rootA);
const rootBConfig = rootConfig(rootB);
assert.equal((await updateBaseline(rootAConfig)).status, "updated");
const rootChange = await check(rootBConfig);
assert.equal(rootChange.bindings[0]?.consistency, "inconsistent");
assert.deepEqual(
  rootChange.bindings[0]?.changes.map((change) => change.kind),
  ["reference-definition"],
);
const oldRootSelection = await check(rootBConfig, {
  file: [join(rootA, "guide.md")],
});
assert.deepEqual(oldRootSelection.scope, ["root-policy"]);
assert.equal(
  (await updateBaseline(rootBConfig, { file: [join(rootA, "guide.md")] }))
    .status,
  "updated",
);
assert.equal((await check(rootBConfig)).bindings[0]?.consistency, "consistent");
await rm(rootSwitchBaseline);

const noFilePlugin = definePlugin({
  id: "fixture:no-file-target",
  validate() {},
  collect() {
    return { kind: "value", value: "no direct file target" };
  },
});
const mixedFileConfig = defineConfig({
  baseline: "mixed-file.baseline.json",
  plugins: [file, noFilePlugin],
  bindings: [
    binding("has-file", [file.from("beta.txt").reference("file-reference")]),
    binding("no-file", [
      createReference(noFilePlugin.id, "no-file-reference", {
        kind: "opaque-target",
      }),
    ]),
  ],
});
assert.equal((await updateBaseline(mixedFileConfig)).status, "updated");
assert.deepEqual((await check(mixedFileConfig, { file: ["beta.txt"] })).scope, [
  "has-file",
]);
await rm("mixed-file.baseline.json");

await writeFile(
  "legacy.baseline.json",
  JSON.stringify({
    version: 2,
    bindings: {
      legacy: {
        definition: { id: "legacy", references: ["legacy-ref"] },
        references: {
          "legacy-ref": {
            definition: {
              id: "legacy-ref",
              target: {
                pluginId: "@dock/reference-file",
                target: "legacy.txt",
              },
            },
            value: "legacy value",
          },
        },
      },
    },
  }),
  "utf8",
);
const legacyConfig = defineConfig({
  plugins: [file],
  bindings: [],
  baseline: "legacy.baseline.json",
});
await assert.rejects(
  check(legacyConfig, { file: ["legacy.txt"] }),
  (error) => error.code === "scope-history-unexplainable",
);
await rm("legacy.baseline.json");

process.stdout.write("安装制品当前／历史范围、局部更新与插件预检通过。\n");
