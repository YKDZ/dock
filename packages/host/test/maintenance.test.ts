import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  binding,
  check,
  createReference,
  defineConfig,
  definePlugin,
  type PluginBatchResult,
  type PluginRequest,
  type Reference,
} from "@ykdz/dock";

void test("JSON 键顺序和备注不制造引用身份冲突", () => {
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
    { note: "第一份备注" },
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
    { note: "另一份备注" },
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

void test("配置路径维护使用新的模块图读取导入声明", async () => {
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
    await writeFile(join(root, "first.md"), "第一份\n", "utf8");
    await writeFile(join(root, "second.md"), "第二份\n", "utf8");
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
