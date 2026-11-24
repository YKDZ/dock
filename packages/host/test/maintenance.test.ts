import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  binding,
  check,
  createReference,
  defineConfig,
  definePlugin,
  file,
  type FileReference,
  inspect,
  MaintenanceError,
  type PluginBatchResult,
  type PluginContext,
  type PluginRequest,
  type ReadableReferencePlugin,
  readReference,
  type Reference,
  updateBaseline,
} from "@ykdz/dock";

void test("JSON key order and notes do not cause reference ID conflicts", () => {
  type SharedReference = Reference<
    "fixture-plugin",
    "shared-reference",
    { readonly left: number; readonly right: number },
    string
  >;

  const plugin = definePlugin({
    id: "fixture-plugin",
    validate(_reference: SharedReference): void {},
    collect(
      request: PluginRequest<SharedReference>,
    ): PluginBatchResult<string> {
      return {
        results: request.selectedReferences.map((reference) => ({
          referenceId: reference.id,
          kind: "value",
          value: "same",
        })),
      };
    },
  });
  const first = createReference<
    "fixture-plugin",
    "shared-reference",
    { readonly left: number; readonly right: number },
    string
  >(
    "fixture-plugin",
    "shared-reference",
    { left: 1, right: 2 },
    { note: "First note" },
  );
  const second = createReference<
    "fixture-plugin",
    "shared-reference",
    { readonly left: number; readonly right: number },
    string
  >(
    "fixture-plugin",
    "shared-reference",
    { right: 2, left: 1 },
    { note: "Another note" },
  );

  const config = defineConfig({
    plugins: [plugin],
    bindings: [
      binding("first-policy", [first]),
      binding("second-policy", [second]),
    ],
  });
  assert.equal(config.bindings.length, 2);
});

void test("config path maintenance uses a fresh module graph to read imported declarations", async () => {
  const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
  const cacheDirectory = join(packageDirectory, "node_modules", ".cache");
  await mkdir(cacheDirectory, { recursive: true });
  const root = await mkdtemp(join(cacheDirectory, "dock-config-refresh-"));
  const configPath = join(root, "dock.settings.mjs");
  const declarationsPath = join(root, "declarations.mjs");

  try {
    const packageAlias = join(root, "node_modules", "@ykdz", "dock");
    await mkdir(dirname(packageAlias), { recursive: true });
    await symlink(
      packageDirectory,
      packageAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(join(root, "first.md"), "First edition\n", "utf8");
    await writeFile(join(root, "second.md"), "Second edition\n", "utf8");
    await writeFile(declarationsPath, 'export const target = "first.md";\n');
    await writeFile(
      configPath,
      [
        'import { binding, createReference, defineConfig, definePlugin } from "@ykdz/dock";',
        'import { target } from "./declarations.mjs";',
        'const fixture = definePlugin({ id: "fixture", validate() {}, collect({ selectedReferences }) { return { results: selectedReferences.map((reference) => ({ referenceId: reference.id, kind: "value", value: reference.target })) }; } });',
        'export default defineConfig({ plugins: [fixture], bindings: [binding("guide-policy", [createReference("fixture", "guide", target)])] });',
      ].join("\n"),
    );

    const first = await check(configPath);
    const firstBinding = first.bindings[0];
    assert.ok(firstBinding && "current" in firstBinding);
    assert.equal(firstBinding.current.references.guide?.value, "first.md");

    await writeFile(declarationsPath, 'export const target = "second.md";\n');
    const second = await check(configPath);
    const secondBinding = second.bindings[0];
    assert.ok(secondBinding && "current" in secondBinding);
    assert.equal(secondBinding.current.references.guide?.value, "second.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("legacy version 2 baseline fails check and updateBaseline with rebuild guidance without altering bytes, then passes after explicit rebuild", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-legacy-baseline-"));
  const baselinePath = join(root, "dock.baseline.json");

  try {
    await writeFile(join(root, "guide.md"), "Body\n", "utf8");
    const legacyContent = `${JSON.stringify(
      {
        version: 2,
        bindings: {
          "guide-policy": {
            definition: { id: "guide-policy", references: ["guide"] },
            references: {
              guide: {
                definition: {
                  id: "guide",
                  target: {
                    pluginId: "@ykdz/dock-reference-file",
                    target: "guide.md",
                    fileInfo: "guide.md",
                  },
                },
                value: "Body\n",
              },
            },
          },
        },
      },
      null,
      2,
    )}\n`;
    await writeFile(baselinePath, legacyContent, "utf8");

    const config = defineConfig({
      root,
      plugins: [file],
      bindings: [
        binding("guide-policy", [file.from("guide.md").reference("guide")]),
      ],
    });

    for (const run of [() => check(config), () => updateBaseline(config)]) {
      await assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof MaintenanceError);
        assert.equal(error.code, "baseline-invalid");
        assert.match(
          error.message,
          /Unsupported baseline version 2; expected version 3\./,
        );
        assert.match(error.message, /dock baseline update --config/);
        assert.match(error.message, /dock check --config/);
        return true;
      });
      assert.equal(await readFile(baselinePath, "utf8"), legacyContent);
    }

    await rm(baselinePath);
    const rebuilt = await updateBaseline(config);
    assert.equal(rebuilt.status, "updated");
    if (rebuilt.status !== "updated") return;
    assert.equal(rebuilt.baseline.version, 3);

    const verified = await check(config);
    assert.equal(verified.bindings[0]?.consistency, "consistent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("comparableTarget projects baseline definition while prepare, describe, and collect keep the full runtime target", async () => {
  type RuntimeTarget = {
    readonly key: string;
    readonly executionNote: string;
  };
  type ProjectedReference = Reference<
    "projected-plugin",
    "projected-ref",
    RuntimeTarget,
    string
  >;

  const root = await mkdtemp(join(tmpdir(), "dock-comparable-target-"));
  try {
    let seenInPrepare: string | undefined;
    let seenInDescribe: string | undefined;
    let seenInCollect: string | undefined;
    const plugin = definePlugin({
      id: "projected-plugin",
      validate(_reference: ProjectedReference): void {},
      comparableTarget(reference: ProjectedReference, _context: PluginContext) {
        return { key: reference.target.key };
      },
      prepare(references: readonly ProjectedReference[]) {
        seenInPrepare = references[0]?.target.executionNote;
        return { note: seenInPrepare ?? "" };
      },
      describe(request: PluginRequest<ProjectedReference, { note: string }>) {
        seenInDescribe = request.references[0]?.target.executionNote;
        return { data: { note: seenInDescribe ?? "" }, text: [] };
      },
      collect(request: PluginRequest<ProjectedReference, { note: string }>) {
        seenInCollect = request.selectedReferences[0]?.target.executionNote;
        return {
          results: request.selectedReferences.map((reference) => ({
            referenceId: reference.id,
            kind: "value" as const,
            value: `fact:${reference.target.key}`,
          })),
        };
      },
    });

    const initialRef = createReference<
      "projected-plugin",
      "projected-ref",
      RuntimeTarget,
      string
    >("projected-plugin", "projected-ref", {
      key: "stable",
      executionNote: "run-v1",
    });
    const initialConfig = defineConfig({
      root,
      plugins: [plugin],
      bindings: [binding("projected-binding", [initialRef])],
    });

    const inspected = await inspect(initialConfig);
    assert.deepEqual(inspected.context.references[0]?.target, {
      pluginId: "projected-plugin",
      target: { key: "stable" },
      fileInfo: null,
    });
    assert.equal(seenInPrepare, "run-v1");
    assert.equal(seenInDescribe, "run-v1");

    const updated = await updateBaseline(initialConfig);
    assert.equal(updated.status, "updated");
    if (updated.status !== "updated") return;
    assert.equal(seenInCollect, "run-v1");
    assert.deepEqual(
      updated.baseline.bindings["projected-binding"]?.references[
        "projected-ref"
      ]?.definition.target,
      {
        pluginId: "projected-plugin",
        target: { key: "stable" },
        fileInfo: null,
      },
    );

    const renamedExecutionConfig = defineConfig({
      root,
      plugins: [plugin],
      bindings: [
        binding("projected-binding", [
          createReference<
            "projected-plugin",
            "projected-ref",
            RuntimeTarget,
            string
          >("projected-plugin", "projected-ref", {
            key: "stable",
            executionNote: "run-v2",
          }),
        ]),
      ],
    });
    const afterExecutionChange = await check(renamedExecutionConfig);
    assert.equal(afterExecutionChange.bindings[0]?.consistency, "consistent");
    assert.equal(seenInCollect, "run-v2");

    const changedTargetConfig = defineConfig({
      root,
      plugins: [plugin],
      bindings: [
        binding("projected-binding", [
          createReference<
            "projected-plugin",
            "projected-ref",
            RuntimeTarget,
            string
          >("projected-plugin", "projected-ref", {
            key: "renamed",
            executionNote: "run-v2",
          }),
        ]),
      ],
    });
    const afterTargetChange = await check(changedTargetConfig);
    assert.equal(afterTargetChange.bindings[0]?.consistency, "inconsistent");
    assert.equal(
      afterTargetChange.bindings[0]?.changes[0]?.kind,
      "reference-definition",
    );

    assert.throws(
      () =>
        definePlugin({
          id: "bad-comparable",
          validate() {},
          collect: () => ({ results: [] }),
          comparableTarget: "not-a-function" as never,
        }),
      TypeError,
    );

    const invalidReturnPlugin = definePlugin({
      id: "invalid-comparable-return",
      validate() {},
      comparableTarget: () => Number.NaN,
      collect: () => ({ results: [] }),
    });
    await assert.rejects(
      check(
        defineConfig({
          root,
          plugins: [invalidReturnPlugin],
          bindings: [
            binding("bad-binding", [
              createReference("invalid-comparable-return", "bad-ref", "x"),
            ]),
          ],
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof MaintenanceError);
        assert.equal(error.code, "plugin-comparable-target-failed");
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("inspect, check, and updateBaseline share consistent scope and required references while preserving out-of-scope baseline entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-consistent-scope-"));
  const baselinePath = join(root, "dock.baseline.json");

  try {
    await writeFile(join(root, "shared.md"), "shared v1\n", "utf8");
    await writeFile(join(root, "alpha.md"), "alpha v1\n", "utf8");
    await writeFile(join(root, "beta.md"), "beta v1\n", "utf8");

    const describeSelections: string[][] = [];
    const collectSelections: string[][] = [];
    const trackedFilePlugin = definePlugin({
      id: file.id,
      validate: file.validate,
      ...(file.fileInfo === undefined ? {} : { fileInfo: file.fileInfo }),
      describe(request: PluginRequest<FileReference>) {
        describeSelections.push(
          request.selectedReferences.map((reference) => reference.id),
        );
        return {
          data: {
            selected: request.selectedReferences.map(
              (reference) => reference.id,
            ),
          },
          text: [],
        };
      },
      collect(request: PluginRequest<FileReference>, context: PluginContext) {
        collectSelections.push(
          request.selectedReferences.map((reference) => reference.id),
        );
        return file.collect(request, context);
      },
    });

    const config = defineConfig({
      root,
      plugins: [trackedFilePlugin],
      bindings: [
        binding("alpha-policy", [
          file.from("shared.md").reference("shared-doc"),
          file.from("alpha.md").reference("alpha-doc"),
        ]),
        binding("beta-policy", [
          file.from("shared.md").reference("shared-doc"),
          file.from("beta.md").reference("beta-doc"),
        ]),
      ],
    });

    const fullInspected = await inspect(config);
    const fullChecked = await check(config);
    const fullUpdated = await updateBaseline(config);

    assert.deepEqual(fullInspected.context.scope, [
      "alpha-policy",
      "beta-policy",
    ]);
    assert.deepEqual(fullChecked.scope, ["alpha-policy", "beta-policy"]);
    assert.deepEqual(fullUpdated.report.scope, ["alpha-policy", "beta-policy"]);
    assert.deepEqual(fullInspected.plugins[0]?.references, [
      "shared-doc",
      "alpha-doc",
      "beta-doc",
    ]);
    assert.deepEqual(fullInspected.plugins[0]?.selectedReferences, [
      "shared-doc",
      "alpha-doc",
      "beta-doc",
    ]);
    assert.deepEqual(describeSelections, [
      ["shared-doc", "alpha-doc", "beta-doc"],
      ["shared-doc", "alpha-doc", "beta-doc"],
      ["shared-doc", "alpha-doc", "beta-doc"],
    ]);
    assert.deepEqual(collectSelections, [
      ["shared-doc", "alpha-doc", "beta-doc"],
      ["shared-doc", "alpha-doc", "beta-doc"],
    ]);
    assert.equal(fullUpdated.status, "updated");

    describeSelections.length = 0;
    collectSelections.length = 0;
    await writeFile(join(root, "alpha.md"), "alpha v2\n", "utf8");
    await writeFile(join(root, "beta.md"), "beta v2\n", "utf8");

    const singleScope = { binding: ["alpha-policy"] } as const;
    const scopedInspected = await inspect(config, singleScope);
    const scopedChecked = await check(config, singleScope);
    const scopedUpdated = await updateBaseline(config, singleScope);

    assert.deepEqual(scopedInspected.context.scope, ["alpha-policy"]);
    assert.deepEqual(scopedChecked.scope, ["alpha-policy"]);
    assert.deepEqual(scopedUpdated.report.scope, ["alpha-policy"]);
    assert.deepEqual(scopedChecked.declaration, {
      completeness: "complete",
      bindingIds: ["alpha-policy", "beta-policy"],
    });
    assert.deepEqual(scopedUpdated.report.declaration, {
      completeness: "complete",
      bindingIds: ["alpha-policy", "beta-policy"],
    });
    assert.deepEqual(scopedInspected.plugins[0]?.references, [
      "shared-doc",
      "alpha-doc",
      "beta-doc",
    ]);
    assert.deepEqual(scopedInspected.plugins[0]?.selectedReferences, [
      "shared-doc",
      "alpha-doc",
    ]);
    assert.deepEqual(describeSelections, [
      ["shared-doc", "alpha-doc"],
      ["shared-doc", "alpha-doc"],
      ["shared-doc", "alpha-doc"],
    ]);
    assert.deepEqual(collectSelections, [
      ["shared-doc", "alpha-doc"],
      ["shared-doc", "alpha-doc"],
    ]);
    assert.deepEqual(
      scopedChecked.bindings.map((entry) => entry.bindingId),
      ["alpha-policy"],
    );
    assert.equal(scopedUpdated.status, "updated");
    if (scopedUpdated.status !== "updated") return;

    assert.equal(
      scopedUpdated.baseline.bindings["alpha-policy"]?.references["alpha-doc"]
        ?.value,
      "alpha v2\n",
    );
    assert.equal(
      scopedUpdated.baseline.bindings["beta-policy"]?.references["beta-doc"]
        ?.value,
      "beta v1\n",
    );
    const savedBaseline = JSON.parse(
      await readFile(baselinePath, "utf8"),
    ) as typeof scopedUpdated.baseline;
    assert.equal(
      savedBaseline.bindings["beta-policy"]?.references["beta-doc"]?.value,
      "beta v1\n",
    );

    const outOfScopeCheck = await check(config, { binding: ["beta-policy"] });
    assert.equal(outOfScopeCheck.bindings[0]?.consistency, "inconsistent");
    assert.deepEqual(outOfScopeCheck.bindings[0]?.changes, [
      {
        kind: "fact",
        referenceId: "beta-doc",
        before: "beta v1\n",
        after: "beta v2\n",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("authoring and readReference reject accessors with zero getter calls and isolate nested read values", async () => {
  let getterCalls = 0;
  const nestedGetter = Object.defineProperty({}, "secret", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "leaked";
    },
  });
  const topLevelSelectionGetter = Object.defineProperty({}, "selection", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return { step: 1 };
    },
  });
  const topLevelTargetRef = Object.defineProperty(
    { id: "bad-ref", pluginId: "nested-plugin" },
    "target",
    {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { path: "doc.md" };
      },
    },
  ) as unknown as Reference<"nested-plugin", string, { path: string }, string>;

  assert.throws(
    () =>
      createReference("nested-plugin", "bad", {
        nested: nestedGetter,
      } as never),
    TypeError,
  );
  assert.throws(
    () =>
      createReference(
        "nested-plugin",
        "bad-options",
        { path: "doc.md" },
        topLevelSelectionGetter as never,
      ),
    TypeError,
  );

  const retainedValue = { items: ["alpha", { count: 1 }] };
  let nextReadResult: unknown = {
    value: retainedValue,
    range: { path: "doc.md", start: 0, end: 5 },
  };
  const plugin: ReadableReferencePlugin<
    "nested-plugin",
    Reference<"nested-plugin", string, { path: string }, typeof retainedValue>,
    typeof retainedValue
  > = definePlugin({
    id: "nested-plugin",
    validate() {},
    collect: () => ({ results: [] }),
    read() {
      return nextReadResult as { value: typeof retainedValue };
    },
  });

  assert.throws(
    () =>
      defineConfig({
        plugins: [plugin],
        bindings: [binding("bad-binding", [topLevelTargetRef as never])],
      }),
    TypeError,
  );

  const validRef = createReference<
    "nested-plugin",
    "item",
    { path: string },
    typeof retainedValue
  >("nested-plugin", "item", { path: "doc.md" });
  const config = defineConfig({
    plugins: [plugin],
    bindings: [binding("item-binding", [validRef])],
  });

  const read = await readReference(config, validRef);
  retainedValue.items[0] = "mutated-by-plugin";
  (retainedValue.items[1] as { count: number }).count = 999;
  assert.deepEqual(read.value, { items: ["alpha", { count: 1 }] });

  await assert.rejects(
    () => readReference(config, topLevelTargetRef as never),
    (error: unknown) =>
      error instanceof MaintenanceError && error.code === "invalid-reference",
  );

  nextReadResult = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return { ok: true };
    },
  });
  await assert.rejects(
    () => readReference(config, validRef),
    (error: unknown) =>
      error instanceof MaintenanceError &&
      error.code === "invalid-plugin-read-result",
  );

  nextReadResult = { value: { nested: [nestedGetter] } };
  await assert.rejects(
    () => readReference(config, validRef),
    (error: unknown) =>
      error instanceof MaintenanceError &&
      error.code === "invalid-plugin-read-result",
  );

  assert.equal(getterCalls, 0);
});

void test("host check and updateBaseline keep accepted inputs, reports, and baselines three-way independent", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-three-way-independence-"));
  try {
    type NestedTarget = { path: string; meta: { tags: string[] } };
    type NestedFact = { summary: { count: number; items: string[] } };
    const callerTarget: NestedTarget = {
      path: "doc.md",
      meta: { tags: ["initial"] },
    };
    const callerSelection = { steps: [{ kind: "quote", text: "v1" }] };
    const ref = createReference<
      "nested-plugin",
      "nested-ref",
      NestedTarget,
      NestedFact,
      typeof callerSelection
    >("nested-plugin", "nested-ref", callerTarget, {
      selection: callerSelection,
    });

    const pluginPayload: NestedFact = {
      summary: { count: 1, items: ["fact-v1"] },
    };
    const plugin = definePlugin({
      id: "nested-plugin",
      validate() {},
      collect(
        request: PluginRequest<
          Reference<"nested-plugin", string, NestedTarget, NestedFact>
        >,
      ): PluginBatchResult<NestedFact> {
        return {
          results: request.selectedReferences.map((selected) => ({
            referenceId: selected.id,
            kind: "value",
            value: pluginPayload,
          })),
        };
      },
    });
    const config = defineConfig({
      root,
      plugins: [plugin],
      bindings: [binding("nested-binding", [ref])],
    });

    const initial = await updateBaseline(config);
    assert.equal(initial.status, "updated");

    callerTarget.meta.tags[0] = "caller-mutated-before-second";
    callerSelection.steps[0]!.text = "caller-mutated-before-second";
    pluginPayload.summary.count = 2;
    pluginPayload.summary.items[0] = "fact-v2";

    const secondRef = createReference<
      "nested-plugin",
      "nested-ref",
      NestedTarget,
      NestedFact,
      typeof callerSelection
    >("nested-plugin", "nested-ref", callerTarget, {
      selection: callerSelection,
    });
    const secondConfig = defineConfig({
      root,
      plugins: [plugin],
      bindings: [binding("nested-binding", [secondRef])],
    });

    const outcome = await updateBaseline(secondConfig);
    assert.equal(outcome.status, "updated");
    if (outcome.status !== "updated") return;

    callerTarget.meta.tags[0] = "caller-mutated-after";
    callerSelection.steps[0]!.text = "caller-mutated-after";
    pluginPayload.summary.count = 99;
    pluginPayload.summary.items[0] = "plugin-mutated-after";

    const reportBinding = outcome.report.bindings[0]!;
    assert.ok("current" in reportBinding);
    const reportFact = reportBinding.current.references["nested-ref"]!;
    const baselineFact =
      outcome.baseline.bindings["nested-binding"]!.references["nested-ref"]!;

    assert.deepEqual(reportFact.value, {
      summary: { count: 2, items: ["fact-v2"] },
    });
    assert.deepEqual(baselineFact.value, {
      summary: { count: 2, items: ["fact-v2"] },
    });
    assert.deepEqual(
      (
        reportFact.definition.target as {
          target: NestedTarget;
        }
      ).target.meta.tags,
      ["caller-mutated-before-second"],
    );
    assert.deepEqual(
      (
        baselineFact.definition.target as {
          target: NestedTarget;
        }
      ).target.meta.tags,
      ["caller-mutated-before-second"],
    );

    reportFact.value.summary.items[0] = "mutated-in-report";
    const factChange = reportBinding.changes.find((c) => c.kind === "fact");
    assert.ok(factChange && "before" in factChange);
    if (factChange && "before" in factChange) {
      (factChange.before as NestedFact).summary.items[0] =
        "mutated-change-before";
    }
    assert.deepEqual(baselineFact.value, {
      summary: { count: 2, items: ["fact-v2"] },
    });
    assert.equal(pluginPayload.summary.items[0], "plugin-mutated-after");

    baselineFact.value.summary.items[0] = "mutated-in-baseline";
    (
      baselineFact.definition.target as { target: NestedTarget }
    ).target.meta.tags[0] = "mutated-in-baseline";
    assert.equal(reportFact.value.summary.items[0], "mutated-in-report");
    assert.deepEqual(
      (
        reportFact.definition.target as {
          target: NestedTarget;
        }
      ).target.meta.tags,
      ["caller-mutated-before-second"],
    );
    assert.equal(pluginPayload.summary.items[0], "plugin-mutated-after");
    assert.equal(callerTarget.meta.tags[0], "caller-mutated-after");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
