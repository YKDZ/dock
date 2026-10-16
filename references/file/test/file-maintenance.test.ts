import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { file, filePluginId } from "@dock/reference-file";
import {
  binding,
  check,
  createReference,
  defineConfig,
  definePlugin,
  MaintenanceError,
  type Reference,
  updateBaseline,
} from "@dock/sdk";

void test("普通文件全文可经公开 SDK 建立、核对和更新基线", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-file-maintenance-"));
  const target = join(root, "guide.md");

  try {
    await writeFile(target, "第一版正文\n", "utf8");
    const guide = file.from("guide.md").reference("guide");
    const config = defineConfig({
      root,
      plugins: [file],
      bindings: [binding("guide-policy", [guide])],
    });

    const initial = await check(config);
    assert.deepEqual(initial.scope, ["guide-policy"]);
    assert.equal(initial.bindings[0]?.consistency, "inconsistent");
    assert.equal(initial.bindings[0]?.changes[0]?.kind, "binding-added");
    await assert.rejects(readFile(join(root, "dock.baseline.json"), "utf8"), {
      code: "ENOENT",
    });

    const updated = await updateBaseline(config);
    assert.equal(updated.status, "updated");

    const unchanged = await check(config);
    assert.equal(unchanged.bindings[0]?.consistency, "consistent");

    await writeFile(target, "第二版正文\n", "utf8");
    const changed = await check(config);
    assert.equal(changed.bindings[0]?.consistency, "inconsistent");
    assert.deepEqual(changed.bindings[0]?.changes, [
      {
        kind: "fact",
        referenceId: "guide",
        before: "第一版正文\n",
        after: "第二版正文\n",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("显式空完整声明可取消最后一条关联跟踪", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-file-untracking-"));
  const baselinePath = join(root, "dock.baseline.json");

  try {
    await writeFile(join(root, "guide.txt"), "正文\n", "utf8");
    const initial = defineConfig({
      root,
      plugins: [file],
      bindings: [
        binding("guide-policy", [file.from("guide.txt").reference("guide")]),
      ],
    });
    assert.equal((await updateBaseline(initial)).status, "updated");

    const untrack = defineConfig({ root, plugins: [], bindings: [] });
    const result = await updateBaseline(untrack);
    assert.equal(result.status, "updated");
    assert.deepEqual(result.report.scope, ["guide-policy"]);
    const removedBinding = result.report.bindings[0];
    assert.ok(removedBinding && "untracked" in removedBinding);
    assert.equal(removedBinding.untracked, true);

    const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as {
      readonly bindings: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(baseline.bindings), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
    collect() {
      return { kind: "value", value: "same" };
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

void test("采集错误阻止基线更新并保留原有字节", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-file-error-"));
  const target = join(root, "guide.txt");
  const baselinePath = join(root, "dock.baseline.json");

  try {
    await writeFile(target, "仍是纯文本\n", "utf8");
    const reference = file.from("guide.txt").reference("guide");
    const config = defineConfig({
      root,
      plugins: [file],
      bindings: [binding("guide-policy", [reference])],
    });
    assert.equal((await updateBaseline(config)).status, "updated");
    const originalBytes = await readFile(baselinePath);

    await rm(target);
    const report = await check(config);
    const failedBinding = report.bindings[0];
    assert.ok(failedBinding && "errors" in failedBinding);
    assert.equal(failedBinding.errors[0]?.code, "missing-file");

    const rejected = await updateBaseline(config);
    assert.equal(rejected.status, "rejected");
    assert.deepEqual(await readFile(baselinePath), originalBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("有效文本不变时，文件目标变化仍报告定义差异", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-file-target-"));

  try {
    await writeFile(join(root, "first.md"), "相同内容\n", "utf8");
    await writeFile(join(root, "second.md"), "相同内容\n", "utf8");
    const configFor = (target: string) =>
      defineConfig({
        root,
        plugins: [file],
        bindings: [
          binding("guide-policy", [file.from(target).reference("guide")]),
        ],
      });

    assert.equal(
      (await updateBaseline(configFor("first.md"))).status,
      "updated",
    );
    const changedTarget = await check(configFor("second.md"));
    assert.deepEqual(changedTarget.bindings[0]?.changes, [
      {
        kind: "reference-definition",
        referenceId: "guide",
        before: {
          id: "guide",
          target: {
            pluginId: filePluginId,
            target: "first.md",
          },
        },
        after: {
          id: "guide",
          target: {
            pluginId: filePluginId,
            target: "second.md",
          },
        },
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("损坏基线明确失败，不按首次维护处理", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-file-baseline-"));
  const baselinePath = join(root, "dock.baseline.json");

  try {
    await writeFile(join(root, "guide.md"), "正文\n", "utf8");
    await writeFile(baselinePath, "{not json", "utf8");
    const config = defineConfig({
      root,
      plugins: [file],
      bindings: [
        binding("guide-policy", [file.from("guide.md").reference("guide")]),
      ],
    });

    await assert.rejects(check(config), (error: unknown) => {
      assert.ok(error instanceof MaintenanceError);
      assert.equal(error.code, "baseline-invalid");
      return true;
    });
    assert.equal(await readFile(baselinePath, "utf8"), "{not json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("配置路径维护使用新的模块图读取导入声明", async () => {
  const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
  const cacheDirectory = join(packageDirectory, "node_modules", ".cache");
  await mkdir(cacheDirectory, { recursive: true });
  const root = await mkdtemp(join(cacheDirectory, "dock-config-refresh-"));
  const configPath = join(root, "dock.settings.mjs");
  const declarationsPath = join(root, "declarations.mjs");

  try {
    await writeFile(join(root, "first.md"), "第一份\n", "utf8");
    await writeFile(join(root, "second.md"), "第二份\n", "utf8");
    await writeFile(declarationsPath, 'export const target = "first.md";\n');
    await writeFile(
      configPath,
      [
        'import { binding, createReference, defineConfig, definePlugin } from "@dock/sdk";',
        'import { target } from "./declarations.mjs";',
        'const fixture = definePlugin({ id: "fixture", validate() {}, collect(reference) { return { kind: "value", value: reference.target }; } });',
        'export default defineConfig({ plugins: [fixture], bindings: [binding("guide-policy", [createReference("fixture", "guide", target)])] });',
      ].join("\n"),
    );

    const first = await check(configPath);
    const firstBinding = first.bindings[0];
    assert.ok(firstBinding && "current" in firstBinding);
    assert.deepEqual(firstBinding.current.references.guide?.definition.target, {
      pluginId: "fixture",
      target: "first.md",
    });

    await writeFile(declarationsPath, 'export const target = "second.md";\n');
    const second = await check(configPath);
    const secondBinding = second.bindings[0];
    assert.ok(secondBinding && "current" in secondBinding);
    assert.deepEqual(
      secondBinding.current.references.guide?.definition.target,
      {
        pluginId: "fixture",
        target: "second.md",
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
