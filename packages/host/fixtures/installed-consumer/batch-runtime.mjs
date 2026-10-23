import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
} finally {
  await rm(root, { recursive: true, force: true });
}
