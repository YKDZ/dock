import assert from "node:assert/strict";
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

  const invalidObjectDiagnostics = definePlugin({
    id: "fixture:invalid-object-diagnostics",
    validate() {},
    collect(request) {
      return {
        results: request.selectedReferences.map((reference) => ({
          referenceId: reference.id,
          kind: "value",
          value: "accepted object fact",
        })),
        diagnostics: {
          data: { invalid() {} },
          text: ["有效文本", 42],
        },
      };
    },
  });
  const objectOutcome = await updateBaseline(
    defineConfig({
      root,
      baseline: "object-diagnostics.baseline.json",
      plugins: [invalidObjectDiagnostics],
      bindings: [
        binding("object-diagnostics-policy", [
          createReference(
            "fixture:invalid-object-diagnostics",
            "object-diagnostics-reference",
            "object target",
          ),
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
    [
      {
        pluginId: "fixture:invalid-object-diagnostics",
        code: "invalid-plugin-diagnostics",
      },
    ],
  );
  assert.deepEqual(objectOutcome.report.pluginDiagnostics, []);
  assert.equal(
    objectOutcome.report.bindings[0]?.current?.references[
      "object-diagnostics-reference"
    ]?.value,
    "accepted object fact",
  );
  assert.match(
    await readFile(join(root, "object-diagnostics.baseline.json"), "utf8"),
    /accepted object fact/u,
  );

  await writeFile(
    workerConfigPath,
    `import { binding, createReference, defineConfig, definePlugin } from "@ykdz/dock";

const plugin = definePlugin({
  id: "fixture:invalid-worker-diagnostics",
  validate() {},
  collect(request) {
    return {
      results: request.selectedReferences.map((reference) => ({
        referenceId: reference.id,
        kind: "value",
        value: "accepted worker fact",
      })),
      diagnostics: {
        data: { invalid() { return true; } },
        text: ["有效文本", 42],
      },
    };
  },
});

export default defineConfig({
  root: ${JSON.stringify(workerRoot)},
  baseline: "worker-diagnostics.baseline.json",
  plugins: [plugin],
  bindings: [
    binding("worker-diagnostics-policy", [
      createReference("fixture:invalid-worker-diagnostics", "worker-reference", "worker target"),
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
    [
      {
        pluginId: "fixture:invalid-worker-diagnostics",
        code: "invalid-plugin-diagnostics",
      },
    ],
  );
  assert.deepEqual(workerOutcome.report.pluginDiagnostics, []);
  assert.equal(
    workerOutcome.report.bindings[0]?.current?.references["worker-reference"]
      ?.value,
    "accepted worker fact",
  );
  assert.match(
    await readFile(
      join(workerRoot, "worker-diagnostics.baseline.json"),
      "utf8",
    ),
    /accepted worker fact/u,
  );
} finally {
  await rm(workerConfigPath, { force: true });
  await rm(root, { recursive: true, force: true });
  await rm(workerRoot, { recursive: true, force: true });
}
