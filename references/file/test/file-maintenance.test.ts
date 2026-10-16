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
  readReference,
  type Reference,
  updateBaseline,
} from "@dock/sdk";

void test("普通文件全文可经公开 SDK 建立、核对和更新基线", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-file-maintenance-"));
  const target = join(root, "guide.md");
  const firstVersion = "<!-- Markdown 注释保持为普通文本 -->\n第一版正文\n";
  const secondVersion = "<!-- Markdown 注释保持为普通文本 -->\n第二版正文\n";

  try {
    await writeFile(target, firstVersion, "utf8");
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
    assert.equal(
      initial.bindings[0]?.current?.references.guide?.value,
      firstVersion,
    );
    assert.deepEqual(initial.bindings[0]?.current?.references.guide?.range, {
      path: "guide.md",
      start: 0,
      end: firstVersion.length,
    });
    await assert.rejects(readFile(join(root, "dock.baseline.json"), "utf8"), {
      code: "ENOENT",
    });

    const updated = await updateBaseline(config);
    assert.equal(updated.status, "updated");

    const unchanged = await check(config);
    assert.equal(unchanged.bindings[0]?.consistency, "consistent");

    await writeFile(target, secondVersion, "utf8");
    const changed = await check(config);
    assert.equal(changed.bindings[0]?.consistency, "inconsistent");
    assert.deepEqual(changed.bindings[0]?.changes, [
      {
        kind: "fact",
        referenceId: "guide",
        before: firstVersion,
        after: secondVersion,
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("文件存在性可被核对，缺失文件不能作为事实写入基线", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-file-exists-"));
  const target = join(root, "guide.md");
  const baselinePath = join(root, "dock.baseline.json");

  try {
    const source = "<!-- 普通文件仍保留原文 -->\n正文\n";
    await writeFile(target, source, "utf8");
    const reference = file.from("guide.md").exists().reference("guide-exists");
    const config = defineConfig({
      root,
      plugins: [file],
      bindings: [binding("guide-policy", [reference])],
    });

    const initial = await check(config);
    assert.equal(initial.bindings[0]?.consistency, "inconsistent");
    assert.equal((await updateBaseline(config)).status, "updated");
    const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as {
      readonly bindings: Record<
        string,
        {
          readonly references: Record<string, { readonly value: unknown }>;
        }
      >;
    };
    assert.equal(
      baseline.bindings["guide-policy"]?.references["guide-exists"]?.value,
      true,
    );
    const originalBaseline = await readFile(baselinePath);

    await rm(target);
    const missing = await check(config);
    const failedBinding = missing.bindings[0];
    assert.ok(failedBinding && "errors" in failedBinding);
    assert.equal(failedBinding.errors[0]?.code, "missing-file");

    const rejected = await updateBaseline(config);
    assert.equal(rejected.status, "rejected");
    assert.deepEqual(await readFile(baselinePath), originalBaseline);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("唯一文本选择保留原文 UTF-16 位置且前置无关文本不改变事实", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-file-quote-"));
  const target = join(root, "guide.md");
  const source = "😀x\nTARGET\n";

  try {
    await writeFile(target, source, "utf8");
    const reference = file.from("guide.md").quote("TARGET").reference("target");
    const config = defineConfig({
      root,
      plugins: [file],
      bindings: [binding("target-policy", [reference])],
    });

    const initial = await check(config);
    assert.deepEqual(initial.bindings[0]?.current?.references.target?.range, {
      path: "guide.md",
      start: 4,
      end: 10,
    });
    assert.equal((await updateBaseline(config)).status, "updated");

    await writeFile(target, `前置\n${source}`, "utf8");
    const moved = await check(config);
    assert.equal(moved.bindings[0]?.consistency, "consistent");
    assert.deepEqual(moved.bindings[0]?.current?.references.target?.range, {
      path: "guide.md",
      start: 7,
      end: 13,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("readReference 读取未关联引用的当前文本和位置，失效选择不回退基线", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-file-read-reference-"));
  const target = join(root, "guide.md");
  const source = "😀说明\nTARGET\n";

  try {
    await writeFile(target, source, "utf8");
    const bound = file.from("guide.md").quote("TARGET").reference("bound");
    const standalone = file
      .from("guide.md")
      .quote("TARGET")
      .reference("standalone");
    const config = defineConfig({
      root,
      plugins: [file],
      bindings: [binding("guide-policy", [bound])],
    });
    assert.equal((await updateBaseline(config)).status, "updated");

    assert.deepEqual(await readReference(config, standalone), {
      value: "TARGET",
      range: { path: "guide.md", start: 5, end: 11 },
    });
    const movedSource = `前置\n${source}`;
    await writeFile(target, movedSource, "utf8");
    assert.deepEqual(await readReference(config, standalone), {
      value: "TARGET",
      range: { path: "guide.md", start: 8, end: 14 },
    });

    await writeFile(target, "😀说明\nchanged\n", "utf8");
    await assert.rejects(
      readReference(config, standalone),
      (error: unknown) => {
        assert.ok(error instanceof MaintenanceError);
        assert.equal(error.code, "missing-selection");
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("region 后可按唯一正则捕获继续收窄", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-file-region-match-"));
  const source =
    "😀title\n#region outer\nouter body\n#region settings\nport=4173\n#endregion settings\nafter\n#endregion outer\n";

  try {
    await writeFile(join(root, "settings.txt"), source, "utf8");
    const port = file
      .from("settings.txt")
      .region("outer")
      .region("settings")
      .quote("port=4173")
      .match("port=(\\d+)", 1)
      .reference("port");
    const config = defineConfig({
      root,
      plugins: [file],
      bindings: [binding("port-policy", [port])],
    });

    const report = await check(config);
    const current = report.bindings[0]?.current?.references.port;
    assert.equal(current?.value, "4173");
    assert.deepEqual(current?.range, {
      path: "settings.txt",
      start: source.indexOf("4173"),
      end: source.indexOf("4173") + 4,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("文本定位的重复、缺失和非法边界均拒绝基线更新", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-file-selection-errors-"));
  const cases = [
    {
      id: "overlapping-quote",
      path: "overlapping.txt",
      source: "ababa",
      reference: file
        .from("overlapping.txt")
        .quote("aba")
        .reference("overlapping-quote"),
      code: "ambiguous-selection",
    },
    {
      id: "missing-quote",
      path: "missing.txt",
      source: "current value",
      reference: file
        .from("missing.txt")
        .quote("absent")
        .reference("missing-quote"),
      code: "missing-selection",
    },
    {
      id: "repeated-quote",
      path: "repeated-quote.txt",
      source: "guide guide",
      reference: file
        .from("repeated-quote.txt")
        .quote("guide")
        .reference("repeated-quote"),
      code: "ambiguous-selection",
    },
    {
      id: "empty-quote",
      path: "empty-quote.txt",
      source: "text",
      reference: file
        .from("empty-quote.txt")
        .quote("")
        .reference("empty-quote"),
      code: "invalid-selector",
    },
    {
      id: "selection-cannot-widen",
      path: "selection-cannot-widen.txt",
      source: "outside TARGET inside",
      reference: file
        .from("selection-cannot-widen.txt")
        .quote("TARGET")
        .quote("outside")
        .reference("selection-cannot-widen"),
      code: "missing-selection",
    },
    {
      id: "multiple-matches",
      path: "multiple.txt",
      source: "a a",
      reference: file
        .from("multiple.txt")
        .match("(a)", 1)
        .reference("multiple-matches"),
      code: "ambiguous-selection",
    },
    {
      id: "overlapping-matches",
      path: "overlapping-matches.txt",
      source: "ababa",
      reference: file
        .from("overlapping-matches.txt")
        .match("aba")
        .reference("overlapping-matches"),
      code: "ambiguous-selection",
    },
    {
      id: "empty-pattern",
      path: "empty-pattern.txt",
      source: "text",
      reference: file
        .from("empty-pattern.txt")
        .match("")
        .reference("empty-pattern"),
      code: "invalid-selector",
    },
    {
      id: "invalid-regex",
      path: "invalid-regex.txt",
      source: "text",
      reference: file
        .from("invalid-regex.txt")
        .match("(")
        .reference("invalid-regex"),
      code: "invalid-regex",
    },
    {
      id: "empty-match",
      path: "empty-match.txt",
      source: "bbb",
      reference: file
        .from("empty-match.txt")
        .match("a*")
        .reference("empty-match"),
      code: "empty-match",
    },
    {
      id: "missing-capture",
      path: "missing-capture.txt",
      source: "a",
      reference: file
        .from("missing-capture.txt")
        .match("(a)", 2)
        .reference("missing-capture"),
      code: "missing-capture",
    },
    {
      id: "empty-capture",
      path: "empty-capture.txt",
      source: "b",
      reference: file
        .from("empty-capture.txt")
        .match("(a*)b", 1)
        .reference("empty-capture"),
      code: "empty-capture",
    },
    {
      id: "repeated-region",
      path: "repeated-region.txt",
      source:
        "#region repeated\none\n#endregion repeated\n#region repeated\ntwo\n#endregion repeated\n",
      reference: file
        .from("repeated-region.txt")
        .region("repeated")
        .reference("repeated-region"),
      code: "ambiguous-region",
    },
    {
      id: "unclosed-region",
      path: "unclosed-region.txt",
      source: "#region open\nbody\n",
      reference: file
        .from("unclosed-region.txt")
        .region("open")
        .reference("unclosed-region"),
      code: "malformed-region",
    },
    {
      id: "mismatched-region",
      path: "mismatched-region.txt",
      source: "#region open\nbody\n#endregion other\n",
      reference: file
        .from("mismatched-region.txt")
        .region("open")
        .reference("mismatched-region"),
      code: "malformed-region",
    },
    {
      id: "unnamed-region",
      path: "unnamed-region.txt",
      source: "#region\nbody\n",
      reference: file
        .from("unnamed-region.txt")
        .region("named")
        .reference("unnamed-region"),
      code: "malformed-region",
    },
    {
      id: "empty-region",
      path: "empty-region.txt",
      source: "#region empty\n \t\n#endregion empty\n",
      reference: file
        .from("empty-region.txt")
        .region("empty")
        .reference("empty-region"),
      code: "empty-region",
    },
    {
      id: "missing-region",
      path: "missing-region.txt",
      source: "#region another\nbody\n#endregion another\n",
      reference: file
        .from("missing-region.txt")
        .region("missing")
        .reference("missing-region"),
      code: "missing-region",
    },
  ];

  try {
    for (const item of cases) {
      await writeFile(join(root, item.path), item.source, "utf8");
    }
    const config = defineConfig({
      root,
      plugins: [file],
      bindings: cases.map((item) => binding(item.id, [item.reference])),
    });

    const report = await check(config);
    for (const item of cases) {
      const result = report.bindings.find(
        (bindingResult) => bindingResult.bindingId === item.id,
      );
      assert.ok(result && "errors" in result, item.id);
      assert.equal(result.errors[0]?.code, item.code, item.id);
    }

    assert.equal((await updateBaseline(config)).status, "rejected");
    await assert.rejects(readFile(join(root, "dock.baseline.json")), {
      code: "ENOENT",
    });
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

void test("普通文件引用在声明组装时拒绝无效的选择器", () => {
  const invalidConfig = {
    plugins: [file],
    bindings: [
      {
        id: "selected-policy",
        references: [
          {
            id: "selected-guide",
            pluginId: filePluginId,
            target: "guide.md",
            selection: { start: 0 },
          },
        ],
      },
    ],
  };
  assert.throws(
    () => Reflect.apply(defineConfig, undefined, [invalidConfig]),
    /selection 无效/,
  );
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
    collect(_reference: SharedReference) {
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
    const definitionChange = changedTarget.bindings[0]?.changes[0];
    assert.equal(definitionChange?.kind, "reference-definition");
    assert.equal(
      definitionChange?.kind === "reference-definition"
        ? definitionChange.referenceId
        : undefined,
      "guide",
    );
    assert.notDeepEqual(definitionChange?.before, definitionChange?.after);
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
