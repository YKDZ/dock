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
  inspect,
  MaintenanceError,
  type PluginBatchResult,
  type PluginContext,
  type PluginRequest,
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
