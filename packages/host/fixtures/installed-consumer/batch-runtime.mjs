import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  binding,
  check,
  createReference,
  defineConfig,
  definePlugin,
  inspect,
  updateBaseline,
} from "@ykdz/dock";

const root = await mkdtemp(join(tmpdir(), "dock-host-batch-installed-"));
const workerRoot = await mkdtemp(
  join(tmpdir(), "dock-host-worker-diagnostics-installed-"),
);
const workerConfigPath = join(
  process.cwd(),
  ".dock-worker-diagnostics.config.mjs",
);
const cliConfigPath = join(process.cwd(), ".dock-cli-diagnostics.config.mjs");
const cliRoot = await mkdtemp(join(tmpdir(), "dock-host-cli-diagnostics-"));
let collectionCalls = 0;
let descriptionCalls = 0;
const plugin = definePlugin({
  id: "fixture:batch",
  validate(reference) {
    if (typeof reference.target.value !== "string") {
      throw new TypeError("value must be text");
    }
  },
  prepare(references) {
    return { ids: references.map(({ id }) => id) };
  },
  describe(request) {
    descriptionCalls += 1;
    return {
      data: { selected: request.selectedReferences.map(({ id }) => id) },
      text: [
        `声明 ${request.references.length} 条；选中 ${request.selectedReferences.length} 条`,
      ],
    };
  },
  collect(request) {
    collectionCalls += 1;
    assert.deepEqual(request.prepared?.ids, ["selected", "unselected"]);
    assert.deepEqual(
      request.references.map(({ id }) => id),
      ["selected", "unselected"],
    );
    assert.deepEqual(
      request.selectedReferences.map(({ id }) => id),
      ["selected"],
    );
    return {
      results: request.selectedReferences.map((reference) => ({
        referenceId: reference.id,
        kind: "value",
        value: reference.target.value,
      })),
      diagnostics: {
        data: { collectionCalls },
        text: ["批量采集完成"],
      },
    };
  },
});

const config = defineConfig({
  root,
  baseline: "batch.baseline.json",
  plugins: [plugin],
  bindings: [
    binding("selected-policy", [
      createReference("fixture:batch", "selected", { value: "fact" }),
    ]),
    binding("unselected-policy", [
      createReference("fixture:batch", "unselected", { value: "other" }),
    ]),
  ],
});

try {
  const selected = { binding: ["selected-policy"] };
  const inspected = await inspect(config, selected);
  assert.equal(collectionCalls, 0);
  assert.equal(descriptionCalls, 1);
  assert.deepEqual(inspected.plugins[0], {
    id: "fixture:batch",
    references: ["selected", "unselected"],
    selectedReferences: ["selected"],
    description: {
      data: { selected: ["selected"] },
      text: ["声明 2 条；选中 1 条"],
    },
  });

  const report = await check(config, selected);
  assert.equal(collectionCalls, 1);
  assert.equal(report.bindings[0].consistency, "inconsistent");
  assert.deepEqual(report.pluginDiagnostics, [
    {
      pluginId: "fixture:batch",
      data: { collectionCalls: 1 },
      text: ["批量采集完成"],
    },
  ]);
  assert.deepEqual(report.pluginErrors, []);

  const updated = await updateBaseline(config, selected);
  assert.equal(updated.status, "updated");
  assert.equal(collectionCalls, 2);
  assert.match(
    await readFile(join(root, "batch.baseline.json"), "utf8"),
    /"fact"/,
  );

  const stable = await check(config, selected);
  assert.equal(collectionCalls, 3);
  assert.equal(stable.bindings[0].consistency, "consistent");

  await writeFile(
    cliConfigPath,
    `import { binding, createReference, defineConfig, definePlugin } from "@ykdz/dock";

const makePlugin = (id, value) => definePlugin({
  id,
  validate() {},
  collect(request) {
    return {
      results: request.selectedReferences.map(({ id: referenceId }) => ({
        referenceId,
        kind: "value",
        value,
      })),
      diagnostics: { data: { owner: id }, text: ["执行完成"] },
    };
  },
});
const firstId = "@fixture/cli-first";
const secondId = "@fixture/cli-second";

export default defineConfig({
  root: ${JSON.stringify(cliRoot)},
  baseline: "cli-diagnostics.baseline.json",
  plugins: [makePlugin(firstId, "first fact"), makePlugin(secondId, "second fact")],
  bindings: [
    binding("cli-first-policy", [
      createReference(firstId, "cli-first", "first target"),
    ]),
    binding("cli-second-policy", [
      createReference(secondId, "cli-second", "second target"),
    ]),
  ],
});
`,
  );
  await updateBaseline(cliConfigPath);
  const installedCli = join(
    process.cwd(),
    "node_modules",
    "@ykdz",
    "dock",
    "dist",
    "cli.js",
  );
  const textResult = spawnSync(
    process.execPath,
    [installedCli, "check", "--config", cliConfigPath],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(textResult.status, 0, textResult.stderr);
  assert.match(textResult.stdout, /插件 @fixture\/cli-first：执行完成/u);
  assert.match(textResult.stdout, /插件 @fixture\/cli-second：执行完成/u);

  const jsonResult = spawnSync(
    process.execPath,
    [installedCli, "check", "--config", cliConfigPath, "--json"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  const jsonOutput = JSON.stringify(JSON.parse(jsonResult.stdout));
  assert.ok(jsonOutput.includes('"pluginId":"@fixture/cli-first"'));
  assert.ok(jsonOutput.includes('"pluginId":"@fixture/cli-second"'));
  assert.ok(jsonOutput.includes('"data":{"owner":"@fixture/cli-first"}'));
  assert.ok(jsonOutput.includes('"data":{"owner":"@fixture/cli-second"}'));
  assert.ok(jsonOutput.includes('"text":["执行完成"]'));

  for (const diagnosticKind of ["data", "text"]) {
    const pluginId = `fixture:invalid-object-${diagnosticKind}-diagnostics`;
    const referenceId = `object-${diagnosticKind}-reference`;
    const fact = `accepted object ${diagnosticKind} fact`;
    const diagnostics =
      diagnosticKind === "data"
        ? {
            data: { invalid() {} },
            text: ["有效对象诊断文字"],
          }
        : {
            data: { valid: true },
            text: ["有效文本", 42],
          };
    const invalidObjectDiagnostics = definePlugin({
      id: pluginId,
      validate() {},
      collect(request) {
        return {
          results: request.selectedReferences.map((reference) => ({
            referenceId: reference.id,
            kind: "value",
            value: fact,
          })),
          diagnostics,
        };
      },
    });
    const objectOutcome = await updateBaseline(
      defineConfig({
        root,
        baseline: `object-${diagnosticKind}-diagnostics.baseline.json`,
        plugins: [invalidObjectDiagnostics],
        bindings: [
          binding(`object-${diagnosticKind}-diagnostics-policy`, [
            createReference(pluginId, referenceId, "object target"),
          ]),
        ],
      }),
    );
    assert.equal(objectOutcome.status, "updated");
    assert.deepEqual(
      objectOutcome.report.pluginErrors.map(({ pluginId, code }) => ({
        pluginId,
        code,
      })),
      [{ pluginId, code: "invalid-plugin-diagnostics" }],
    );
    assert.deepEqual(objectOutcome.report.pluginDiagnostics, []);
    assert.equal(
      objectOutcome.report.bindings[0]?.current?.references[referenceId]?.value,
      fact,
    );
    assert.match(
      await readFile(
        join(root, `object-${diagnosticKind}-diagnostics.baseline.json`),
        "utf8",
      ),
      new RegExp(fact, "u"),
    );
  }

  for (const diagnosticKind of ["data", "text"]) {
    const pluginId = `fixture:invalid-worker-${diagnosticKind}-diagnostics`;
    const referenceId = `worker-${diagnosticKind}-reference`;
    const fact = `accepted worker ${diagnosticKind} fact`;
    const diagnostics =
      diagnosticKind === "data"
        ? `{
        data: { invalid() { return true; } },
        text: ["有效 Worker 诊断文字"],
      }`
        : `{
        data: { valid: true },
        text: ["有效 Worker 文字", 42],
      }`;
    await writeFile(
      workerConfigPath,
      `import { binding, createReference, defineConfig, definePlugin } from "@ykdz/dock";

const plugin = definePlugin({
  id: ${JSON.stringify(pluginId)},
  validate() {},
  collect(request) {
    return {
      results: request.selectedReferences.map((reference) => ({
        referenceId: reference.id,
        kind: "value",
        value: ${JSON.stringify(fact)},
      })),
      diagnostics: ${diagnostics},
    };
  },
});

export default defineConfig({
  root: ${JSON.stringify(workerRoot)},
  baseline: ${JSON.stringify(`worker-${diagnosticKind}-diagnostics.baseline.json`)},
  plugins: [plugin],
  bindings: [
    binding(${JSON.stringify(`worker-${diagnosticKind}-diagnostics-policy`)}, [
      createReference(${JSON.stringify(pluginId)}, ${JSON.stringify(referenceId)}, "worker target"),
    ]),
  ],
});
`,
    );
    const workerOutcome = await updateBaseline(workerConfigPath);
    assert.equal(workerOutcome.status, "updated");
    assert.deepEqual(
      workerOutcome.report.pluginErrors.map(({ pluginId, code }) => ({
        pluginId,
        code,
      })),
      [{ pluginId, code: "invalid-plugin-diagnostics" }],
    );
    assert.deepEqual(workerOutcome.report.pluginDiagnostics, []);
    assert.equal(
      workerOutcome.report.bindings[0]?.current?.references[referenceId]?.value,
      fact,
    );
    assert.match(
      await readFile(
        join(workerRoot, `worker-${diagnosticKind}-diagnostics.baseline.json`),
        "utf8",
      ),
      new RegExp(fact, "u"),
    );
  }
} finally {
  await rm(cliConfigPath, { force: true });
  await rm(cliRoot, { recursive: true, force: true });
  await rm(workerConfigPath, { force: true });
  await rm(root, { recursive: true, force: true });
  await rm(workerRoot, { recursive: true, force: true });
}
