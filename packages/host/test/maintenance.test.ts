import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
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
  inspect,
  MaintenanceError,
  type PluginBatchResult,
  type PluginContext,
  type PluginRequest,
  type ReadableReferencePlugin,
  readReference,
  type Reference,
  updateBaseline,
} from "@dock/host";

type LocalTextFileReference = Reference<
  "fixture:text-file",
  string,
  string,
  string
>;

const localTextFilePlugin = definePlugin({
  id: "fixture:text-file",
  validate(reference: LocalTextFileReference): void {
    if (typeof reference.target !== "string" || reference.target.length === 0) {
      throw new TypeError("Text file target must be a non-empty path.");
    }
  },
  fileInfo(reference: LocalTextFileReference): string {
    return reference.target;
  },
  async collect(
    request: PluginRequest<LocalTextFileReference>,
    context: PluginContext,
  ): Promise<PluginBatchResult<string>> {
    const results = await Promise.all(
      request.selectedReferences.map(async (reference) => ({
        referenceId: reference.id,
        kind: "value" as const,
        value: await readFile(join(context.root, reference.target), "utf8"),
      })),
    );
    return { results };
  },
});

function localTextFileReference(
  id: string,
  path: string,
): LocalTextFileReference {
  return createReference<"fixture:text-file", string, string, string>(
    "fixture:text-file",
    id,
    path,
  );
}

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
    const packageAlias = join(root, "node_modules", "@dock", "host");
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
        'import { binding, createReference, defineConfig, definePlugin } from "@dock/host";',
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
      plugins: [localTextFilePlugin],
      bindings: [
        binding("guide-policy", [localTextFileReference("guide", "guide.md")]),
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
      id: localTextFilePlugin.id,
      validate: (reference: LocalTextFileReference) =>
        localTextFilePlugin.validate(reference),
      fileInfo: (reference: LocalTextFileReference) =>
        localTextFilePlugin.fileInfo(reference),
      describe(request: PluginRequest<LocalTextFileReference>) {
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
      collect(
        request: PluginRequest<LocalTextFileReference>,
        context: PluginContext,
      ) {
        collectSelections.push(
          request.selectedReferences.map((reference) => reference.id),
        );
        return localTextFilePlugin.collect(request, context);
      },
    });

    const config = defineConfig({
      root,
      plugins: [trackedFilePlugin],
      bindings: [
        binding("alpha-policy", [
          localTextFileReference("shared-doc", "shared.md"),
          localTextFileReference("alpha-doc", "alpha.md"),
        ]),
        binding("beta-policy", [
          localTextFileReference("shared-doc", "shared.md"),
          localTextFileReference("beta-doc", "beta.md"),
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

void test("real filesystem baseline write and read failures preserve existing content and clean temporary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-baseline-fs-failure-"));

  try {
    await writeFile(join(root, "guide.txt"), "Original fact\n", "utf8");

    // 1) Existing directory at baseline path triggers baseline-read-failed without altering contents.
    const dirConflictPath = join(root, "baseline-dir");
    const sentinelPath = join(dirConflictPath, "sentinel.txt");
    await mkdir(dirConflictPath);
    await writeFile(sentinelPath, "preserve-sentinel\n", "utf8");
    const dirConflictConfig = defineConfig({
      root,
      baseline: "baseline-dir",
      plugins: [localTextFilePlugin],
      bindings: [
        binding("dir-policy", [localTextFileReference("guide", "guide.txt")]),
      ],
    });
    await assert.rejects(check(dirConflictConfig), (error: unknown) => {
      assert.ok(error instanceof MaintenanceError);
      assert.equal(error.code, "baseline-read-failed");
      return true;
    });
    assert.equal(await readFile(sentinelPath, "utf8"), "preserve-sentinel\n");

    // 2) Rename conflict during atomic write triggers baseline-write-failed (even as uid 0) and cleans temp files.
    const lateDirPath = join(root, "late-baseline-dir");
    const lateSentinelPath = join(lateDirPath, "sentinel.txt");
    const lateConflictPlugin = definePlugin({
      id: "fixture:late-dir-conflict",
      validate() {},
      async collect(request) {
        await mkdir(lateDirPath, { recursive: true });
        await writeFile(lateSentinelPath, "preserve-late-sentinel\n", "utf8");
        return {
          results: request.selectedReferences.map((reference) => ({
            referenceId: reference.id,
            kind: "value" as const,
            value: "collected-fact",
          })),
        };
      },
    });
    const lateConflictConfig = defineConfig({
      root,
      baseline: "late-baseline-dir",
      plugins: [lateConflictPlugin],
      bindings: [
        binding("late-dir-policy", [
          createReference("fixture:late-dir-conflict", "late-ref", "target"),
        ]),
      ],
    });
    await assert.rejects(
      updateBaseline(lateConflictConfig),
      (error: unknown) => {
        assert.ok(error instanceof MaintenanceError);
        assert.equal(error.code, "baseline-write-failed");
        return true;
      },
    );
    assert.equal(
      await readFile(lateSentinelPath, "utf8"),
      "preserve-late-sentinel\n",
    );
    assert.equal(
      (await readdir(root)).some((name) => name.endsWith(".dock-baseline.tmp")),
      false,
    );

    // 3) Parent-is-file conflict during atomic write triggers baseline-write-failed (even as uid 0).
    const fileParentPath = join(root, "occupied-parent");
    const parentConflictPlugin = definePlugin({
      id: "fixture:parent-file-conflict",
      validate() {},
      async collect(request) {
        await writeFile(fileParentPath, "preserve-parent-file\n", "utf8");
        return {
          results: request.selectedReferences.map((reference) => ({
            referenceId: reference.id,
            kind: "value" as const,
            value: "collected-fact",
          })),
        };
      },
    });
    const fileParentConfig = defineConfig({
      root,
      baseline: "occupied-parent/dock.baseline.json",
      plugins: [parentConflictPlugin],
      bindings: [
        binding("parent-policy", [
          createReference(
            "fixture:parent-file-conflict",
            "parent-ref",
            "target",
          ),
        ]),
      ],
    });
    await assert.rejects(updateBaseline(fileParentConfig), (error: unknown) => {
      assert.ok(error instanceof MaintenanceError);
      assert.equal(error.code, "baseline-write-failed");
      return true;
    });
    assert.equal(
      await readFile(fileParentPath, "utf8"),
      "preserve-parent-file\n",
    );
    assert.equal(
      (await readdir(root)).some((name) => name.endsWith(".dock-baseline.tmp")),
      false,
    );

    // 4) Read-only directory and unreadable baseline permission checks when running non-root.
    if (process.getuid?.() !== 0) {
      const restrictedDir = join(root, "restricted");
      const targetPath = join(restrictedDir, "guide.txt");
      const baselinePath = join(restrictedDir, "dock.baseline.json");
      await mkdir(restrictedDir);
      await writeFile(targetPath, "Initial fact\n", "utf8");
      const restrictedConfig = defineConfig({
        root: restrictedDir,
        plugins: [localTextFilePlugin],
        bindings: [
          binding("restricted-policy", [
            localTextFileReference("guide", "guide.txt"),
          ]),
        ],
      });
      const initial = await updateBaseline(restrictedConfig);
      assert.equal(initial.status, "updated");
      const originalBytes = await readFile(baselinePath);

      await writeFile(targetPath, "Updated fact\n", "utf8");
      await chmod(baselinePath, 0o444);
      await chmod(restrictedDir, 0o555);
      try {
        await assert.rejects(
          updateBaseline(restrictedConfig),
          (error: unknown) => {
            assert.ok(error instanceof MaintenanceError);
            assert.equal(error.code, "baseline-write-failed");
            return true;
          },
        );
        assert.deepEqual(await readFile(baselinePath), originalBytes);
        assert.equal(
          (await readdir(restrictedDir)).some((name) =>
            name.endsWith(".dock-baseline.tmp"),
          ),
          false,
        );

        await chmod(baselinePath, 0);
        await assert.rejects(check(restrictedConfig), (error: unknown) => {
          assert.ok(error instanceof MaintenanceError);
          assert.equal(error.code, "baseline-read-failed");
          return true;
        });
      } finally {
        await chmod(restrictedDir, 0o755).catch(() => undefined);
        await chmod(baselinePath, 0o644).catch(() => undefined);
      }
      assert.deepEqual(await readFile(baselinePath), originalBytes);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("worker config path maintenance supports reference/file scope selection, inspect without collect, and preserves baseline on rejected update", async () => {
  const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
  const cacheDirectory = join(packageDirectory, "node_modules", ".cache");
  await mkdir(cacheDirectory, { recursive: true });
  const root = await mkdtemp(join(cacheDirectory, "dock-worker-scope-"));
  const configPath = join(root, "dock.config.mjs");
  const baselinePath = join(root, "dock.baseline.json");
  const callsPath = join(root, "collect-calls.txt");

  try {
    const packageAlias = join(root, "node_modules", "@dock", "host");
    await mkdir(dirname(packageAlias), { recursive: true });
    await symlink(
      packageDirectory,
      packageAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(join(root, "alpha.txt"), "alpha v1\n", "utf8");
    await writeFile(join(root, "beta.txt"), "beta v1\n", "utf8");
    await writeFile(
      configPath,
      [
        'import { appendFile, readFile } from "node:fs/promises";',
        'import { join } from "node:path";',
        'import { binding, createReference, defineConfig, definePlugin } from "@dock/host";',
        "",
        "const plugin = definePlugin({",
        '  id: "fixture:worker-scope",',
        "  validate() {},",
        "  fileInfo(reference) {",
        "    return reference.target;",
        "  },",
        "  async collect(request, context) {",
        `    await appendFile(${JSON.stringify(callsPath)}, request.selectedReferences.map((r) => r.id).join(",") + "\\n");`,
        "    const results = [];",
        "    for (const reference of request.selectedReferences) {",
        "      try {",
        "        const value = await readFile(join(context.root, reference.target), 'utf8');",
        "        results.push({ referenceId: reference.id, kind: 'value', value });",
        "      } catch {",
        "        results.push({",
        "          referenceId: reference.id,",
        "          kind: 'error',",
        "          error: { code: 'missing-file', message: 'Missing target file' },",
        "        });",
        "      }",
        "    }",
        "    return { results };",
        "  },",
        "});",
        "",
        "export default defineConfig({",
        "  plugins: [plugin],",
        "  bindings: [",
        '    binding("alpha-policy", [createReference("fixture:worker-scope", "alpha-ref", "alpha.txt")]),',
        '    binding("beta-policy", [createReference("fixture:worker-scope", "beta-ref", "beta.txt")]),',
        "  ],",
        "});",
      ].join("\n"),
      "utf8",
    );

    const inspectedByRef = await inspect(configPath, {
      reference: ["alpha-ref"],
    });
    assert.deepEqual(inspectedByRef.context.scope, ["alpha-policy"]);
    assert.deepEqual(inspectedByRef.plugins[0]?.selectedReferences, [
      "alpha-ref",
    ]);
    await assert.rejects(readFile(callsPath, "utf8"), { code: "ENOENT" });

    const initialUpdate = await updateBaseline(configPath);
    assert.equal(initialUpdate.status, "updated");
    const savedBaseline = await readFile(baselinePath);

    await writeFile(join(root, "alpha.txt"), "alpha v2\n", "utf8");
    const checkedByFile = await check(configPath, { file: ["alpha.txt"] });
    assert.deepEqual(checkedByFile.scope, ["alpha-policy"]);
    assert.equal(checkedByFile.bindings[0]?.consistency, "inconsistent");

    await rm(join(root, "alpha.txt"));
    const rejected = await updateBaseline(configPath, {
      reference: ["alpha-ref"],
    });
    assert.equal(rejected.status, "rejected");
    assert.deepEqual(await readFile(baselinePath), savedBaseline);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("host inspect, check, and updateBaseline reject corrupted V3 baselines with field paths, duplicate keys, missing vs extra refs, and preserve file bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-v3-baseline-diag-"));
  const baselinePath = join(root, "dock.baseline.json");

  try {
    await writeFile(join(root, "alpha.txt"), "alpha\n", "utf8");
    await writeFile(join(root, "beta.txt"), "beta\n", "utf8");

    type CustomFileRef = Reference<
      "fixture:custom-facts",
      string,
      string,
      { rawText: string; customMeta: { owner: string; priority: number } }
    >;
    const customFilePlugin = definePlugin({
      id: "fixture:custom-facts",
      validate(reference: CustomFileRef) {
        if (
          typeof reference.target !== "string" ||
          reference.target.length === 0
        ) {
          throw new TypeError("Target must be a non-empty string.");
        }
      },
      fileInfo(reference: CustomFileRef) {
        return reference.target;
      },
      async collect(request: PluginRequest<CustomFileRef>) {
        return {
          results: request.selectedReferences.map((reference) => ({
            referenceId: reference.id,
            kind: "value" as const,
            value: {
              rawText: reference.target,
              customMeta: { owner: "docs", priority: 1 },
            },
          })),
        };
      },
    });
    const customCollectionPlugin = definePlugin({
      id: "fixture:custom-collection",
      validate() {},
      async collect(request) {
        return {
          results: request.selectedReferences.map((reference) => ({
            referenceId: reference.id,
            kind: "collection" as const,
            collection: {
              completeness: "complete" as const,
              members: [
                {
                  id: "member one",
                  value: {
                    status: "passed",
                    businessTag: "smoke",
                    metrics: { retries: 0 },
                  },
                },
              ],
            },
          })),
        };
      },
    });

    const config = defineConfig({
      root,
      plugins: [customFilePlugin, customCollectionPlugin],
      bindings: [
        binding("main policy", [
          createReference("fixture:custom-facts", "alpha ref", "alpha.txt"),
          createReference("fixture:custom-facts", "beta ref", "beta.txt"),
          createReference("fixture:custom-collection", "collection-ref", {
            suite: "unit",
            customTargetProp: true,
          }),
        ]),
      ],
    });

    const created = await updateBaseline(config);
    assert.equal(created.status, "updated");
    const validRaw = await readFile(baselinePath, "utf8");

    // Valid baseline with custom business fields in plain value, member.value, and target.target passes check cleanly.
    const validCheck = await check(config);
    assert.equal(validCheck.bindings[0]?.consistency, "consistent");

    // 1) Missing required reference fact vs unexpected extra reference fact.
    const missingObj = JSON.parse(validRaw) as {
      bindings: Record<string, { references: Record<string, unknown> }>;
    };
    delete missingObj.bindings["main policy"]!.references["beta ref"];
    const missingRaw = `${JSON.stringify(missingObj, null, 2)}\n`;
    await writeFile(baselinePath, missingRaw, "utf8");

    for (const op of [
      () => inspect(config),
      () => check(config),
      () => updateBaseline(config),
    ]) {
      await assert.rejects(op, (error: unknown) => {
        assert.ok(error instanceof MaintenanceError);
        assert.equal(error.code, "baseline-invalid");
        assert.ok(error.message.includes(baselinePath));
        assert.match(error.message, /main policy/);
        assert.match(error.message, /beta ref/);
        assert.match(error.message, /missing required reference fact/i);
        return true;
      });
      assert.equal(await readFile(baselinePath, "utf8"), missingRaw);
    }

    const extraObj = JSON.parse(validRaw) as {
      bindings: Record<string, { references: Record<string, unknown> }>;
    };
    extraObj.bindings["main policy"]!.references["stray ref"] = {
      definition: {
        id: "stray ref",
        target: {
          pluginId: "fixture:custom-facts",
          target: "x",
          fileInfo: null,
        },
      },
      value: "stray",
    };
    const extraRaw = `${JSON.stringify(extraObj, null, 2)}\n`;
    await writeFile(baselinePath, extraRaw, "utf8");

    for (const op of [
      () => inspect(config),
      () => check(config),
      () => updateBaseline(config),
    ]) {
      await assert.rejects(op, (error: unknown) => {
        assert.ok(error instanceof MaintenanceError);
        assert.equal(error.code, "baseline-invalid");
        assert.ok(error.message.includes(baselinePath));
        assert.match(error.message, /main policy/);
        assert.match(error.message, /stray ref/);
        assert.match(error.message, /unexpected reference fact/i);
        assert.doesNotMatch(error.message, /missing required/i);
        return true;
      });
      assert.equal(await readFile(baselinePath, "utf8"), extraRaw);
    }

    // 2) Raw duplicate keys + unknown fields across Dock-owned records, host target wrapper, and member-collection items.
    const prettyValidRaw = `${JSON.stringify(JSON.parse(validRaw), null, 2)}\n`;
    const corruptedMultiRaw = prettyValidRaw
      .replace('"version": 3', '"extraRoot": true,\n  "version": 3')
      .replace(
        '"fileInfo": "alpha.txt"',
        '"fileInfo": "alpha.txt",\n              "wrapperExtra": 1',
      )
      .replace(
        '"id": "beta ref",',
        '"id": "beta ref",\n              "id": "beta ref",',
      )
      .replace(
        '"id": "member one",',
        '"id": "member one",\n                "memberExtra": true,',
      );
    assert.notEqual(corruptedMultiRaw, prettyValidRaw);
    await writeFile(baselinePath, corruptedMultiRaw, "utf8");

    for (const op of [
      () => inspect(config),
      () => check(config),
      () => updateBaseline(config),
    ]) {
      await assert.rejects(op, (error: unknown) => {
        assert.ok(error instanceof MaintenanceError);
        assert.equal(error.code, "baseline-invalid");
        assert.ok(error.message.includes(baselinePath));
        assert.match(error.message, /\$\.extraRoot/);
        assert.match(error.message, /definition\.target\.wrapperExtra/);
        assert.match(error.message, /references\["beta ref"\]\.definition\.id/);
        assert.match(error.message, /value\[0\]\.memberExtra/);
        return true;
      });
      assert.equal(await readFile(baselinePath, "utf8"), corruptedMultiRaw);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("declaration discovery source read failures preserve baseline bytes and reject untracked inference", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-source-discovery-"));
  const baselinePath = join(root, "dock.baseline.json");
  const missingSourcePath = join(root, "missing-guide.md");

  try {
    const unusedRef = localTextFileReference("unused-ref", "unused.txt");
    let executedUnused = false;
    const trackingFilePlugin = definePlugin({
      ...localTextFilePlugin,
      async collect(
        request: PluginRequest<LocalTextFileReference>,
        context: PluginContext,
      ) {
        for (const reference of request.selectedReferences) {
          if (reference.id === "unused-ref") executedUnused = true;
        }
        return await localTextFilePlugin.collect(request, context);
      },
    });

    const discoveryPlugin = definePlugin({
      id: "fixture:discovery",
      validate() {},
      validateSource(source: { readonly target: unknown }) {
        if (typeof source.target !== "string" || source.target.length === 0) {
          throw new TypeError("Source target must be a non-empty string.");
        }
      },
      async discover(input, context) {
        const issues = [];
        for (const source of input.sources) {
          const target =
            typeof source.target === "string"
              ? source.target
              : JSON.stringify(source.target);
          const targetPath = join(context.root, target);
          try {
            await readFile(targetPath, "utf8");
          } catch (error) {
            issues.push({
              code: "declaration-source-read-failed",
              message: `Cannot read declaration source ${target}: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
        for (const missingPath of input.missingBaselineFiles) {
          try {
            await readFile(missingPath, "utf8");
          } catch (error) {
            issues.push({
              code: "declaration-source-read-failed",
              message: `Cannot read historical declaration source ${missingPath}: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
        return { bindings: [], issues };
      },
      collect(request) {
        return {
          results: request.selectedReferences.map((reference) => ({
            referenceId: reference.id,
            kind: "value" as const,
            value: "ok",
          })),
        };
      },
    });

    assert.throws(
      () => Reflect.apply(defineConfig, undefined, [{ plugins: [] }]),
      /bindings or sources/i,
    );

    const standaloneConfig = defineConfig({
      root,
      plugins: [trackingFilePlugin, discoveryPlugin],
      references: [unusedRef],
      sources: [],
    });
    const emptyCheck = await check(standaloneConfig);
    assert.deepEqual(emptyCheck.scope, []);
    assert.equal(executedUnused, false);

    const baselineRaw = `${JSON.stringify(
      {
        version: 3,
        bindings: {
          "inline-policy": {
            definition: {
              id: "inline-policy",
              references: ["inline-body"],
            },
            references: {
              "inline-body": {
                definition: {
                  id: "inline-body",
                  target: {
                    pluginId: "fixture:discovery",
                    target: "missing-guide.md",
                    fileInfo: "missing-guide.md",
                  },
                },
                value: "Original statement",
              },
            },
          },
        },
      },
      null,
      2,
    )}\n`;
    await writeFile(baselinePath, baselineRaw, "utf8");

    const explicitSourceConfig = defineConfig({
      root,
      baseline: baselinePath,
      plugins: [discoveryPlugin],
      sources: [{ pluginId: "fixture:discovery", target: "missing-guide.md" }],
    });

    for (const op of [
      () => inspect(explicitSourceConfig),
      () => check(explicitSourceConfig),
      () => updateBaseline(explicitSourceConfig),
    ]) {
      await assert.rejects(op, (error: unknown) => {
        assert.ok(error instanceof MaintenanceError);
        assert.equal(error.code, "declaration-source-read-failed");
        assert.match(error.message, /missing-guide\.md/);
        return true;
      });
      assert.equal(await readFile(baselinePath, "utf8"), baselineRaw);
    }

    // Even without explicit sources, an unreadable missing historical source must fail instead of inferring untracked.
    const refOnlyConfig = defineConfig({
      root,
      baseline: baselinePath,
      plugins: [discoveryPlugin],
      bindings: [
        binding("other-policy", [
          createReference("fixture:discovery", "other-ref", "other.md"),
        ]),
      ],
    });
    assert.ok(!missingSourcePath.endsWith("other.md"));
    await assert.rejects(
      () => updateBaseline(refOnlyConfig),
      (error: unknown) =>
        error instanceof MaintenanceError &&
        error.code === "declaration-source-read-failed" &&
        error.message.includes("missing-guide.md"),
    );
    assert.equal(await readFile(baselinePath, "utf8"), baselineRaw);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("host declaration assembly reports duplicate members, unknown refs, ref conflicts, binding ID conflicts with declaredAt, and deduplicates identical issues in one pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-assembly-conflicts-"));
  const baselinePath = join(root, "dock.baseline.json");
  try {
    await writeFile(join(root, "alpha.txt"), "alpha\n", "utf8");
    const tsRef = localTextFileReference("known-ref", "alpha.txt");
    const conflictingRef = createReference<
      "fixture:text-file",
      string,
      string,
      string
    >("fixture:text-file", "own-body", "alpha.txt", {
      declaredAt: "dock.config.ts:10",
    });

    const discoveryPlugin = definePlugin({
      id: "fixture:inline-assembly",
      validate() {},
      validateSource() {},
      async discover(input) {
        if (input.sources.some((s) => s.target === "corrupt.md")) {
          return {
            bindings: [],
            issues: [
              {
                code: "declaration-invalid",
                message: "corrupt.md:4: Invalid dock:bind payload.",
              },
            ],
          };
        }
        return {
          bindings: [
            {
              id: "ts-collision",
              ownReferences: [
                createReference(
                  "fixture:inline-assembly",
                  "inline-ts-col",
                  "a.md",
                ),
              ],
              referenceIds: ["inline-ts-col", "known-ref"],
              declaredAt: "guide-a.md:3",
            },
            {
              id: "dup-inline",
              ownReferences: [
                createReference(
                  "fixture:inline-assembly",
                  "inline-dup-1",
                  "a.md",
                ),
              ],
              referenceIds: ["inline-dup-1", "missing-ref-1"],
              declaredAt: "guide-a.md:10",
            },
            {
              id: "dup-inline",
              ownReferences: [
                createReference(
                  "fixture:inline-assembly",
                  "inline-dup-2",
                  "b.md",
                ),
              ],
              referenceIds: ["inline-dup-2", "known-ref"],
              declaredAt: "guide-b.md:5",
            },
            {
              id: "multi-member-bad",
              ownReferences: [
                createReference("fixture:inline-assembly", "own-body", "a.md"),
              ],
              referenceIds: [
                "own-body",
                "known-ref",
                "known-ref",
                "missing-ref-2",
              ],
              declaredAt: "guide-a.md:20",
            },
          ],
          issues: [
            {
              code: "declaration-invalid",
              message: "guide-a.md:1: Repeated root cause.",
            },
            {
              code: "declaration-invalid",
              message: "guide-a.md:1: Repeated root cause.",
            },
          ],
        };
      },
      collect(request) {
        return {
          results: request.selectedReferences.map((reference) => ({
            referenceId: reference.id,
            kind: "value" as const,
            value: "ok",
          })),
        };
      },
    });

    const config = defineConfig({
      root,
      baseline: baselinePath,
      plugins: [localTextFilePlugin, discoveryPlugin],
      bindings: [
        binding("ts-collision", [tsRef], { declaredAt: "dock.config.ts:20" }),
      ],
      references: [conflictingRef],
      sources: [{ pluginId: "fixture:inline-assembly", target: "guide-a.md" }],
    });

    for (const op of [
      () => inspect(config),
      () => check(config),
      () => updateBaseline(config),
    ]) {
      await assert.rejects(op, (error: unknown) => {
        assert.ok(error instanceof MaintenanceError);
        assert.equal(error.code, "declaration-invalid");
        assert.match(
          error.message,
          /Duplicate binding ID "ts-collision".*guide-a\.md:3.*dock\.config\.ts:20/,
        );
        assert.match(
          error.message,
          /Unknown reference ID "missing-ref-1".*guide-a\.md:10/,
        );
        assert.match(
          error.message,
          /Duplicate binding ID "dup-inline".*guide-b\.md:5.*guide-a\.md:10/,
        );
        assert.match(
          error.message,
          /Discovered reference ID "own-body".*guide-a\.md:20.*dock\.config\.ts:10/,
        );
        assert.match(
          error.message,
          /Duplicate reference ID "known-ref".*multi-member-bad.*guide-a\.md:20/,
        );
        assert.match(
          error.message,
          /Unknown reference ID "missing-ref-2".*multi-member-bad.*guide-a\.md:20/,
        );
        assert.equal(
          error.message.split("guide-a.md:1: Repeated root cause.").length - 1,
          1,
          error.message,
        );
        return true;
      });
    }

    // Corrupted declaration with an existing baseline preserves bytes and never infers untracked.
    const baselineRaw = `${JSON.stringify(
      {
        version: 3,
        bindings: {
          "existing-inline": {
            definition: {
              id: "existing-inline",
              references: ["dock:bind:existing-inline"],
            },
            references: {
              "dock:bind:existing-inline": {
                definition: {
                  id: "dock:bind:existing-inline",
                  target: {
                    pluginId: "fixture:inline-assembly",
                    target: "corrupt.md",
                    fileInfo: "corrupt.md",
                  },
                },
                value: "Original",
              },
            },
          },
        },
      },
      null,
      2,
    )}\n`;
    await writeFile(baselinePath, baselineRaw, "utf8");
    const corruptConfig = defineConfig({
      root,
      baseline: baselinePath,
      plugins: [discoveryPlugin],
      sources: [{ pluginId: "fixture:inline-assembly", target: "corrupt.md" }],
    });
    for (const op of [
      () => inspect(corruptConfig),
      () => check(corruptConfig),
      () => updateBaseline(corruptConfig),
    ]) {
      await assert.rejects(op, (error: unknown) => {
        assert.ok(error instanceof MaintenanceError);
        assert.equal(error.code, "declaration-invalid");
        assert.match(error.message, /corrupt\.md:4/);
        return true;
      });
      assert.equal(await readFile(baselinePath, "utf8"), baselineRaw);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("binding ID conflicts without declaredAt report language-neutral provenance instead of TypeScript config bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-conflict-provenance-"));
  try {
    await writeFile(join(root, "a.txt"), "a\n", "utf8");
    const refA = localTextFileReference("ref-a", "a.txt");

    // 1) Config binding without declaredAt conflicts with discovered binding.
    const conflictWithConfigPlugin = definePlugin({
      id: "fixture:conflict-config",
      validate() {},
      validateSource() {},
      discover() {
        return {
          bindings: [
            {
              id: "cli-failure",
              ownReferences: [
                createReference(
                  "fixture:conflict-config",
                  "own-1",
                  "README.md",
                ),
              ],
              referenceIds: ["own-1", "ref-a"],
              declaredAt: "README.md:3",
            },
          ],
          issues: [],
        };
      },
      collect(request) {
        return {
          results: request.selectedReferences.map((r) => ({
            referenceId: r.id,
            kind: "value" as const,
            value: "ok",
          })),
        };
      },
    });
    const configConflict = defineConfig({
      root,
      plugins: [localTextFilePlugin, conflictWithConfigPlugin],
      bindings: [binding("cli-failure", [refA])],
      sources: [{ pluginId: "fixture:conflict-config", target: "README.md" }],
    });
    await assert.rejects(
      () => check(configConflict),
      (error: unknown) => {
        assert.ok(error instanceof MaintenanceError);
        assert.equal(error.code, "declaration-invalid");
        assert.doesNotMatch(error.message, /TypeScript config bindings/);
        assert.match(
          error.message,
          /Duplicate binding ID "cli-failure" declared at README\.md:3 conflicts with existing declaration in config\./,
        );
        return true;
      },
    );

    // 2) Two discovered bindings without declaredAt share the same ID.
    const dupDiscoveredPlugin = definePlugin({
      id: "fixture:conflict-discovered",
      validate() {},
      validateSource() {},
      discover() {
        return {
          bindings: [
            {
              id: "dup-id",
              ownReferences: [
                createReference("fixture:conflict-discovered", "own-a", "a.md"),
              ],
              referenceIds: ["own-a", "ref-a"],
            },
            {
              id: "dup-id",
              ownReferences: [
                createReference("fixture:conflict-discovered", "own-b", "b.md"),
              ],
              referenceIds: ["own-b", "ref-a"],
            },
          ],
          issues: [],
        };
      },
      collect(request) {
        return {
          results: request.selectedReferences.map((r) => ({
            referenceId: r.id,
            kind: "value" as const,
            value: "ok",
          })),
        };
      },
    });
    const discoveredConflict = defineConfig({
      root,
      plugins: [localTextFilePlugin, dupDiscoveredPlugin],
      references: [refA],
      sources: [{ pluginId: "fixture:conflict-discovered", target: "a.md" }],
    });
    await assert.rejects(
      () => check(discoveredConflict),
      (error: unknown) => {
        assert.ok(error instanceof MaintenanceError);
        assert.equal(error.code, "declaration-invalid");
        assert.doesNotMatch(error.message, /TypeScript config bindings/);
        assert.match(
          error.message,
          /Duplicate binding ID "dup-id" declared at fixture:conflict-discovered conflicts with earlier discovered declaration\./,
        );
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
