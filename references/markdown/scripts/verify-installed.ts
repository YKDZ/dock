import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  copyFile,
  mkdtemp,
  mkdir,
  symlink,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

type ProcessResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

type RecordValue = Record<string, unknown>;
type InstalledSelection = {
  readonly value: string;
  readonly range: {
    readonly path: string;
    readonly start: number;
    readonly end: number;
  };
};

type InstalledReads = {
  readonly chapter: InstalledSelection;
  readonly code: InstalledSelection;
  readonly list: InstalledSelection;
  readonly "inline-code": InstalledSelection;
  readonly link: InstalledSelection;
  readonly table: InstalledSelection;
  readonly "table-cell": InstalledSelection;
  readonly "empty-cell": InstalledSelection;
  readonly "runtime-port": InstalledSelection;
  readonly "stable-port": InstalledSelection;
  readonly standalone: InstalledSelection;
  readonly "standalone-marker": InstalledSelection;
  readonly "marker-document": InstalledSelection;
  readonly "ordinary-file": InstalledSelection;
};

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDirectory = join(
  packageDirectory,
  "fixtures",
  "installed-consumer",
);

/** 在干净消费者中验证同批制品的 CLI、公开类型、读取和定位范围。 */
async function main(): Promise<void> {
  const artifacts = process.argv.slice(2);
  assert.equal(
    artifacts.length,
    4,
    "根验收必须传入同批 core、host、file 与 Markdown 包制品路径。",
  );
  const tarballs = artifacts.map((artifact) =>
    resolve(process.cwd(), artifact),
  );
  await Promise.all(tarballs.map((artifact) => access(artifact)));

  const consumer = await mkdtemp(join(tmpdir(), "dock-markdown-consumer-"));
  try {
    await installConsumer(consumer, tarballs);
    const scenarios: readonly [string, (consumer: string) => Promise<void>][] =
      [
        ["公开类型", verifyInstalledTypes],
        ["引用读取", verifyInstalledReads],
        ["段内脚本定位", verifyInstalledInlineScript],
        ["空表格单元格", verifyInstalledEmptyCells],
        ["基线往返与错误", verifyInstalledCli],
        ["范围筛选", verifyInstalledScope],
      ];
    for (const [index, [name, verify]] of scenarios.entries()) {
      await test(`Markdown：${name}`, async () => {
        const scenario = join(consumer, `scenario-${index}`);
        await mkdir(scenario);
        await symlink(
          join(consumer, "node_modules"),
          join(scenario, "node_modules"),
          "dir",
        );
        try {
          await copyFixtures(scenario);
          await verify(scenario);
        } finally {
          await rm(scenario, { recursive: true, force: true });
        }
      });
    }
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}

async function installConsumer(
  consumer: string,
  tarballs: readonly string[],
): Promise<void> {
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "dock-markdown-installed-consumer",
      private: true,
      type: "module",
    }),
  );
  const result = await run(
    "npm",
    [
      "install",
      "--prefix",
      consumer,
      "--no-save",
      "--no-package-lock",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...tarballs,
    ],
    consumer,
  );
  assert.equal(
    result.code,
    0,
    `同批正式制品干净安装失败：\n${result.stdout}\n${result.stderr}`,
  );
}

async function copyFixtures(consumer: string): Promise<void> {
  for (const name of [
    "dock.config.mjs",
    "empty-cells.mjs",
    "guide.md",
    "inline-script-config.mjs",
    "inline-script-guide.md",
    "inline-script-runtime.mjs",
    "invalid-marker-config.mjs",
    "invalid-config.mjs",
    "markers-guide.md",
    "negative.mts",
    "positive.mts",
    "runtime.mjs",
    "scope.config.mjs",
    "tsconfig.json",
  ]) {
    await copyFile(join(fixtureDirectory, name), join(consumer, name));
  }
}

async function verifyInstalledScope(consumer: string): Promise<void> {
  const bin = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "dock.cmd" : "dock",
  );
  const oldTarget = "scope-old.md";
  const newTarget = "scope-new.md";
  const source = await readFile(join(consumer, "guide.md"));
  await writeFile(join(consumer, oldTarget), source);
  await writeFile(join(consumer, newTarget), source);

  const initial = await runDock(
    bin,
    ["baseline", "update", "--config", "scope.config.mjs", "--json"],
    consumer,
    { DOCK_MARKDOWN_SCOPE_TARGET: oldTarget },
  );
  assert.equal(initial.code, 0, initial.stderr);
  assert.equal(parseEnvelope(initial.stdout).variant, "updated");

  const historical = await runDock(
    bin,
    ["check", "--config", "scope.config.mjs", "--file", oldTarget, "--json"],
    consumer,
    { DOCK_MARKDOWN_SCOPE_TARGET: newTarget },
  );
  assert.equal(historical.code, 1, historical.stderr);
  assert.equal(parseEnvelope(historical.stdout).variant, "changed");
  assert.deepEqual(readReport(historical.stdout).scope, [
    "scope-markdown-policy",
  ]);

  const current = await runDock(
    bin,
    ["check", "--config", "scope.config.mjs", "--file", newTarget, "--json"],
    consumer,
    { DOCK_MARKDOWN_SCOPE_TARGET: newTarget },
  );
  assert.equal(current.code, 1, current.stderr);
  assert.equal(parseEnvelope(current.stdout).variant, "changed");
  assert.deepEqual(readReport(current.stdout).scope, ["scope-markdown-policy"]);

  const localUpdate = await runDock(
    bin,
    [
      "baseline",
      "update",
      "--config",
      "scope.config.mjs",
      "--file",
      oldTarget,
      "--json",
    ],
    consumer,
    { DOCK_MARKDOWN_SCOPE_TARGET: newTarget },
  );
  assert.equal(localUpdate.code, 0, localUpdate.stderr);
  assert.deepEqual(readReport(localUpdate.stdout).scope, [
    "scope-markdown-policy",
  ]);

  const consistent = await runDock(
    bin,
    ["check", "--config", "scope.config.mjs", "--file", newTarget, "--json"],
    consumer,
    { DOCK_MARKDOWN_SCOPE_TARGET: newTarget },
  );
  assert.equal(consistent.code, 0, consistent.stderr);
  assert.equal(parseEnvelope(consistent.stdout).variant, "consistent");
  assert.deepEqual(readReport(consistent.stdout).scope, [
    "scope-markdown-policy",
  ]);
}

async function verifyInstalledTypes(consumer: string): Promise<void> {
  const compiler = join(
    packageDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsc.cmd" : "tsc",
  );
  const result = await run(
    compiler,
    ["-p", join(consumer, "tsconfig.json"), "--pretty", "false"],
    consumer,
  );
  assert.equal(
    result.code,
    0,
    `安装制品公开类型正负例未通过：\n${result.stdout}\n${result.stderr}`,
  );
}

async function verifyInstalledReads(consumer: string): Promise<void> {
  const initial = await installedRuntime(consumer);
  const source = await readFile(join(consumer, "guide.md"), "utf8");
  const markerSource = await readFile(
    join(consumer, "markers-guide.md"),
    "utf8",
  );
  assert.equal(initial.chapter.value, "安装片段：版本一。");
  assert.equal(initial.chapter.range.start, source.indexOf("安装片段"));
  assert.equal(initial.code.value, "```ts\nconst answer = 42;\n```");
  assert.equal(initial.list.value, "- 列表选项。");
  assert.equal(initial["inline-code"].value, "`内联调用()`");
  assert.equal(initial.link.value, "[帮助链接](https://example.test/help)");
  assert.equal(
    initial.table.value,
    [
      "| 名称 | 说明       |",
      "| ---- | ---------- |",
      "| api  | **当前值** |",
      "| 空项 |            |",
    ].join("\n"),
  );
  assert.equal(initial["table-cell"].value, "**当前值**");
  assert.equal(initial["empty-cell"].value, "");
  assert.equal(
    initial["empty-cell"].range.start,
    initial["empty-cell"].range.end,
  );
  assert.equal(initial["runtime-port"].value, "4173");
  assert.equal(initial["stable-port"].value, "8080");
  assert.equal(initial["standalone-marker"].value, "独立片段");
  assert.equal(
    initial["marker-document"].value,
    [
      "😀事实 8080。",
      "<!-- 普通注释 -->",
      "",
      "```md",
      "<!-- dock:start fake -->示例<!-- dock:end fake -->",
      "```",
      "",
      "行内 `<!-- dock:start inline -->示例<!-- dock:end inline -->`。",
      '<div title="<!-- dock:start attribute -->"></div>',
      '<script>const text = "<!-- dock:start script -->";</script>',
      "",
    ].join("\n"),
  );
  assert.equal(initial["marker-document"].range.start, 0);
  assert.equal(initial["marker-document"].range.end, markerSource.length);
  assert.equal(initial.standalone.value, initial.chapter.value);
  assert.equal(initial["ordinary-file"].value, source);
  assert.equal(initial["ordinary-file"].range.start, 0);
  assert.equal(initial["ordinary-file"].range.end, source.length);
}

async function verifyInstalledInlineScript(consumer: string): Promise<void> {
  const guidePath = join(consumer, "inline-script-guide.md");
  const config = "inline-script-config.mjs";
  const baselinePath = join(consumer, "inline-script.baseline.json");
  const bin = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "dock.cmd" : "dock",
  );
  const sourceWithReal = await readFile(guidePath, "utf8");

  const initial = await installedInlineRuntime(consumer);
  assert.equal(initial.source, sourceWithReal);
  assertInlineValue(initial, "real", sourceWithReal);
  assert.equal(
    initial.whole,
    sourceWithReal.replace(
      "<!-- dock:start sample -->real<!-- dock:end sample -->",
      "real",
    ),
  );

  const baselineUpdate = await runDock(
    bin,
    ["baseline", "update", "--config", config, "--json"],
    consumer,
  );
  assert.equal(baselineUpdate.code, 0, baselineUpdate.stderr);
  assert.equal(parseEnvelope(baselineUpdate.stdout).variant, "updated");
  const baseline = await readFile(baselinePath);

  const fakeOnly = sourceWithReal.replace(
    "<!-- dock:start sample -->real<!-- dock:end sample -->\n",
    "",
  );
  await writeFile(guidePath, fakeOnly, "utf8");
  const fakeRead = await installedInlineRuntime(consumer);
  assert.equal(fakeRead.source, fakeOnly);
  assertInlineError(fakeRead, "missing-selection");
  assert.equal(fakeRead.whole, fakeOnly);

  const check = await runDock(
    bin,
    ["check", "--config", config, "--json"],
    consumer,
  );
  assert.equal(check.code, 1, check.stderr);
  assert.equal(parseEnvelope(check.stdout).variant, "errors");
  assertReferenceError(check.stdout, "missing-selection", "sample");
  const rejectedUpdate = await runDock(
    bin,
    ["baseline", "update", "--config", config, "--json"],
    consumer,
  );
  assert.equal(rejectedUpdate.code, 1, rejectedUpdate.stderr);
  assert.equal(parseEnvelope(rejectedUpdate.stdout).variant, "rejected");
  assert.deepEqual(await readFile(baselinePath), baseline);

  await writeFile(guidePath, sourceWithReal, "utf8");
  const restored = await installedInlineRuntime(consumer);
  assertInlineValue(restored, "real", sourceWithReal);
  assert.equal(
    restored.whole,
    sourceWithReal.replace(
      "<!-- dock:start sample -->real<!-- dock:end sample -->",
      "real",
    ),
  );
}

type InstalledInlineRuntime = {
  readonly source: string;
  readonly selected: RecordValue;
  readonly collected: RecordValue;
  readonly whole: string;
};

async function installedInlineRuntime(
  consumer: string,
): Promise<InstalledInlineRuntime> {
  const result = await run(
    "node",
    [join(consumer, "inline-script-runtime.mjs")],
    consumer,
  );
  assert.equal(
    result.code,
    0,
    `安装制品段内脚本定位场景失败：\n${result.stdout}\n${result.stderr}`,
  );
  const parsed: unknown = JSON.parse(result.stdout);
  assert.ok(isRecord(parsed));
  assert.ok(typeof parsed.source === "string");
  assert.ok(isRecord(parsed.selected));
  assert.ok(isRecord(parsed.collected));
  assert.ok(typeof parsed.whole === "string");
  return parsed as InstalledInlineRuntime;
}

function assertInlineValue(
  runtime: InstalledInlineRuntime,
  expected: string,
  source: string,
): void {
  assert.equal(runtime.selected.kind, "value");
  assert.equal(runtime.selected.value, expected);
  assert.ok(isRecord(runtime.selected.range));
  assert.equal(runtime.selected.range.path, "inline-script-guide.md");
  assert.equal(runtime.selected.range.start, source.indexOf(expected));
  assert.equal(
    runtime.selected.range.end,
    source.indexOf(expected) + expected.length,
  );
  assert.equal(
    source.slice(runtime.selected.range.start, runtime.selected.range.end),
    expected,
  );
  assert.equal(runtime.collected.kind, "value");
  assert.equal(runtime.collected.value, expected);
  assert.deepEqual(runtime.collected.range, runtime.selected.range);
}

function assertInlineError(
  runtime: InstalledInlineRuntime,
  expected: string,
): void {
  assert.equal(runtime.selected.kind, "error");
  assert.equal(runtime.selected.code, expected);
  assert.equal(runtime.collected.kind, "error");
  assert.ok(isRecord(runtime.collected.error));
  assert.equal(runtime.collected.error.code, expected);
}

async function verifyInstalledEmptyCells(consumer: string): Promise<void> {
  const result = await run(
    "node",
    [join(consumer, "empty-cells.mjs")],
    consumer,
  );
  assert.equal(
    result.code,
    0,
    `安装制品空表格单元格读写失败：\n${result.stdout}\n${result.stderr}`,
  );
  const outcomes: unknown = JSON.parse(result.stdout);
  assert.ok(Array.isArray(outcomes));
  assert.equal(outcomes.length, 3);
  for (const outcome of outcomes) {
    assert.ok(isRecord(outcome));
    assert.ok(typeof outcome.name === "string");
    assert.ok(typeof outcome.source === "string");
    assert.ok(isRecord(outcome.read));
    assert.equal(
      outcome.read.value,
      "",
      `${outcome.name} 应读取空单元格：${JSON.stringify(outcome)}`,
    );
    assert.ok(isRecord(outcome.read.range));
    assert.equal(outcome.read.range.path, "guide.md");
    assert.ok(typeof outcome.read.range.start === "number");
    assert.ok(typeof outcome.read.range.end === "number");
    assert.equal(
      outcome.read.range.start,
      outcome.read.range.end,
      `${outcome.name} 的空范围应为 UTF-16 零长度：${JSON.stringify(outcome)}`,
    );
    assert.equal(outcome.read.range.start, outcome.source.indexOf("|  |") + 3);
    assert.equal(
      outcome.source.slice(outcome.read.range.start, outcome.read.range.end),
      "",
    );
    assert.equal(outcome.source[outcome.read.range.start - 1], " ");
    assert.equal(outcome.source[outcome.read.range.start], "|");
    assert.ok(isRecord(outcome.report));
    assert.ok(Array.isArray(outcome.report.bindings));
    const binding = outcome.report.bindings[0];
    assert.ok(isRecord(binding));
    assert.ok(isRecord(binding.current));
    assert.ok(isRecord(binding.current.references));
    assert.ok(isRecord(binding.current.references.cell));
    assert.equal(binding.current.references.cell.value, "");
    assert.equal(outcome.updateStatus, "updated");
    assert.equal(outcome.savedValue, "");
  }
}

async function verifyInstalledCli(consumer: string): Promise<void> {
  const bin = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "dock.cmd" : "dock",
  );
  const config = "dock.config.mjs";
  const baselinePath = join(consumer, "markdown.baseline.json");
  const initialReads = await installedRuntime(consumer);
  const initial = await runDock(
    bin,
    ["check", "--config", config, "--json"],
    consumer,
  );
  assert.equal(initial.code, 1, initial.stderr);
  assert.equal(parseEnvelope(initial.stdout).variant, "changed");
  assertReportSelection(
    initial.stdout,
    "markdown-policy",
    "chapter",
    initialReads.chapter,
  );
  assertReportSelection(
    initial.stdout,
    "markdown-policy",
    "stable-port",
    initialReads["stable-port"],
  );

  const update = await runDock(
    bin,
    ["baseline", "update", "--config", config, "--json"],
    consumer,
  );
  assert.equal(update.code, 0, update.stderr);
  assert.equal(parseEnvelope(update.stdout).variant, "updated");
  const originalBaseline = await readFile(baselinePath);
  const guideScope = await runDock(
    bin,
    ["check", "--config", config, "--file", "guide.md", "--json"],
    consumer,
  );
  assert.equal(guideScope.code, 0, guideScope.stderr);
  assert.deepEqual(readReport(guideScope.stdout).scope, [
    "markdown-policy",
    "ordinary-file-policy",
  ]);

  const invalidConfig = await runDock(
    bin,
    ["check", "--config", "invalid-config.mjs", "--json"],
    consumer,
  );
  assert.equal(invalidConfig.code, 1, invalidConfig.stderr);
  assert.match(`${invalidConfig.stdout}\n${invalidConfig.stderr}`, /language/u);
  const invalidConfigUpdate = await runDock(
    bin,
    ["baseline", "update", "--config", "invalid-config.mjs", "--json"],
    consumer,
  );
  assert.equal(invalidConfigUpdate.code, 1, invalidConfigUpdate.stderr);
  assert.deepEqual(await readFile(baselinePath), originalBaseline);

  const original = await readFile(join(consumer, "guide.md"), "utf8");
  const changedSource = original
    .replace("版本一", "版本二")
    .replace(
      "<!-- dock:start stable-port -->8080<!-- dock:end stable-port -->",
      "<!-- dock:start stable-port -->8081<!-- dock:end stable-port -->",
    );
  await writeFile(join(consumer, "guide.md"), changedSource, "utf8");
  const changed = await runDock(
    bin,
    ["check", "--config", config, "--json"],
    consumer,
  );
  assert.equal(changed.code, 1, changed.stderr);
  assert.equal(parseEnvelope(changed.stdout).variant, "changed");
  assert.equal(
    referenceChange(readReport(changed.stdout), "markdown-policy", "chapter"),
    "fact",
  );
  assert.equal(
    referenceChange(
      readReport(changed.stdout),
      "markdown-policy",
      "stable-port",
    ),
    "fact",
  );
  const changedReads = await installedRuntime(consumer);
  assertReportSelection(
    changed.stdout,
    "markdown-policy",
    "chapter",
    changedReads.chapter,
  );
  assert.equal(changedReads["stable-port"].value, "8081");
  assertReportSelection(
    changed.stdout,
    "markdown-policy",
    "stable-port",
    changedReads["stable-port"],
  );
  const localUpdate = await runDock(
    bin,
    ["baseline", "update", "--config", config, "--file", "guide.md", "--json"],
    consumer,
  );
  assert.equal(localUpdate.code, 0, localUpdate.stderr);
  assert.deepEqual(readReport(localUpdate.stdout).scope, [
    "markdown-policy",
    "ordinary-file-policy",
  ]);
  const localBaseline = JSON.parse(
    await readFile(baselinePath, "utf8"),
  ) as RecordValue;
  const originalBaselineValue = JSON.parse(
    originalBaseline.toString("utf8"),
  ) as RecordValue;
  assert.deepEqual(
    (localBaseline.bindings as RecordValue)["marker-document-policy"],
    (originalBaselineValue.bindings as RecordValue)["marker-document-policy"],
  );
  const changedUpdate = await runDock(
    bin,
    ["baseline", "update", "--config", config, "--json"],
    consumer,
  );
  assert.equal(changedUpdate.code, 0, changedUpdate.stderr);
  const updatedBaseline = await readFile(baselinePath);

  const movedSource = `😀无关前置内容\n\n${changedSource}`;
  await writeFile(join(consumer, "guide.md"), movedSource, "utf8");
  const moved = await runDock(
    bin,
    ["check", "--config", config, "--json"],
    consumer,
  );
  assert.equal(moved.code, 1, moved.stderr);
  assert.equal(parseEnvelope(moved.stdout).variant, "changed");
  const movedReport = readReport(moved.stdout);
  assert.ok(Array.isArray(movedReport.bindings));
  const movedMarkdownBinding = movedReport.bindings.find(
    (candidate) =>
      isRecord(candidate) && candidate.bindingId === "markdown-policy",
  );
  assert.ok(isRecord(movedMarkdownBinding));
  assert.equal(movedMarkdownBinding.consistency, "consistent");
  assert.deepEqual(movedMarkdownBinding.changes, []);
  assert.equal(
    referenceChange(movedReport, "ordinary-file-policy", "ordinary-file"),
    "fact",
  );
  const movedReads = await installedRuntime(consumer);
  assertReportSelection(
    moved.stdout,
    "markdown-policy",
    "chapter",
    movedReads.chapter,
  );
  assertReportSelection(
    moved.stdout,
    "markdown-policy",
    "stable-port",
    movedReads["stable-port"],
  );
  assert.notEqual(
    movedReads.chapter.range.start,
    initialReads.chapter.range.start,
  );
  assert.notEqual(
    movedReads["stable-port"].range.start,
    initialReads["stable-port"].range.start,
  );
  assert.deepEqual(await readFile(baselinePath), updatedBaseline);

  const changedChoice = await runDock(
    bin,
    ["check", "--config", config, "--json"],
    consumer,
    { DOCK_MARKDOWN_SHORT_SECTION: "1" },
  );
  assert.equal(changedChoice.code, 1, changedChoice.stderr);
  assert.equal(parseEnvelope(changedChoice.stdout).variant, "changed");
  const choiceReport = readReport(changedChoice.stdout);
  assert.equal(
    referenceChange(choiceReport, "markdown-policy", "chapter"),
    "reference-definition",
  );
  const choiceReads = await installedRuntime(consumer, {
    DOCK_MARKDOWN_SHORT_SECTION: "1",
  });
  assert.equal(choiceReads.chapter.value, movedReads.chapter.value);
  assertReportSelection(
    changedChoice.stdout,
    "markdown-policy",
    "chapter",
    choiceReads.chapter,
  );
  const choiceUpdate = await runDock(
    bin,
    ["baseline", "update", "--config", config, "--json"],
    consumer,
    { DOCK_MARKDOWN_SHORT_SECTION: "1" },
  );
  assert.equal(choiceUpdate.code, 0, choiceUpdate.stderr);
  const chosenBaseline = await readFile(baselinePath);

  const withoutHeading = movedSource.replace("## 安装", "## 部署");
  await writeFile(join(consumer, "guide.md"), withoutHeading, "utf8");
  const missing = await runDock(
    bin,
    ["check", "--config", config, "--json"],
    consumer,
    { DOCK_MARKDOWN_SHORT_SECTION: "1" },
  );
  assert.equal(missing.code, 1, missing.stderr);
  assert.equal(parseEnvelope(missing.stdout).variant, "errors");
  assertReferenceError(missing.stdout, "missing-selection");
  const rejectedMissing = await runDock(
    bin,
    ["baseline", "update", "--config", config, "--json"],
    consumer,
    { DOCK_MARKDOWN_SHORT_SECTION: "1" },
  );
  assert.equal(rejectedMissing.code, 1, rejectedMissing.stderr);
  assert.equal(parseEnvelope(rejectedMissing.stdout).variant, "rejected");
  assert.deepEqual(await readFile(baselinePath), chosenBaseline);

  const ambiguousSource = `${movedSource}\n# 附加\n\n## 安装\n\n备用章节。\n`;
  await writeFile(join(consumer, "guide.md"), ambiguousSource, "utf8");
  const ambiguous = await runDock(
    bin,
    ["check", "--config", config, "--json"],
    consumer,
    { DOCK_MARKDOWN_SHORT_SECTION: "1" },
  );
  assert.equal(ambiguous.code, 1, ambiguous.stderr);
  assert.equal(parseEnvelope(ambiguous.stdout).variant, "errors");
  assertReferenceError(ambiguous.stdout, "ambiguous-selection");
  const rejectedAmbiguous = await runDock(
    bin,
    ["baseline", "update", "--config", config, "--json"],
    consumer,
    { DOCK_MARKDOWN_SHORT_SECTION: "1" },
  );
  assert.equal(rejectedAmbiguous.code, 1, rejectedAmbiguous.stderr);
  assert.equal(parseEnvelope(rejectedAmbiguous.stdout).variant, "rejected");
  assert.deepEqual(await readFile(baselinePath), chosenBaseline);

  const missingMarkerSource = ambiguousSource.replace(
    "<!-- dock:end stable-port -->",
    "",
  );
  await writeFile(join(consumer, "guide.md"), missingMarkerSource, "utf8");
  const missingMarker = await runDock(
    bin,
    ["check", "--config", config, "--json"],
    consumer,
    { DOCK_MARKDOWN_SHORT_SECTION: "1" },
  );
  assert.equal(missingMarker.code, 1, missingMarker.stderr);
  assert.equal(parseEnvelope(missingMarker.stdout).variant, "errors");
  assertReferenceError(
    missingMarker.stdout,
    "missing-selection",
    "stable-port",
  );
  const textMissingMarker = await runDock(
    bin,
    ["check", "--config", config],
    consumer,
    { DOCK_MARKDOWN_SHORT_SECTION: "1" },
  );
  assert.equal(textMissingMarker.code, 1, textMissingMarker.stderr);
  const missingMarkerText = `${textMissingMarker.stdout}\n${textMissingMarker.stderr}`;
  assert.ok(missingMarkerText.includes("stable-port"));
  assert.ok(missingMarkerText.includes("missing-selection"));
  assert.ok(
    missingMarkerText.includes(
      referenceErrorMessage(
        missingMarker.stdout,
        "stable-port",
        "missing-selection",
      ),
    ),
  );
  const rejectedMissingMarker = await runDock(
    bin,
    ["baseline", "update", "--config", config, "--json"],
    consumer,
    { DOCK_MARKDOWN_SHORT_SECTION: "1" },
  );
  assert.equal(rejectedMissingMarker.code, 1, rejectedMissingMarker.stderr);
  assert.equal(parseEnvelope(rejectedMissingMarker.stdout).variant, "rejected");
  assert.deepEqual(await readFile(baselinePath), chosenBaseline);

  const duplicateMarkerSource = `${ambiguousSource}\n<!-- dock:start stable-port -->8080<!-- dock:end stable-port -->`;
  await writeFile(join(consumer, "guide.md"), duplicateMarkerSource, "utf8");
  const duplicateMarker = await runDock(
    bin,
    ["check", "--config", config, "--json"],
    consumer,
    { DOCK_MARKDOWN_SHORT_SECTION: "1" },
  );
  assert.equal(duplicateMarker.code, 1, duplicateMarker.stderr);
  assert.equal(parseEnvelope(duplicateMarker.stdout).variant, "errors");
  assertReferenceError(
    duplicateMarker.stdout,
    "ambiguous-selection",
    "stable-port",
  );
  const rejectedDuplicateMarker = await runDock(
    bin,
    ["baseline", "update", "--config", config, "--json"],
    consumer,
    { DOCK_MARKDOWN_SHORT_SECTION: "1" },
  );
  assert.equal(rejectedDuplicateMarker.code, 1, rejectedDuplicateMarker.stderr);
  assert.equal(
    parseEnvelope(rejectedDuplicateMarker.stdout).variant,
    "rejected",
  );
  assert.deepEqual(await readFile(baselinePath), chosenBaseline);

  const invalidMarkerConfig = await runDock(
    bin,
    ["check", "--config", "invalid-marker-config.mjs", "--json"],
    consumer,
  );
  assert.equal(invalidMarkerConfig.code, 1, invalidMarkerConfig.stderr);
  assert.match(
    `${invalidMarkerConfig.stdout}\n${invalidMarkerConfig.stderr}`,
    /标记选择|标记 ID/u,
  );
  assert.deepEqual(await readFile(baselinePath), chosenBaseline);
  assert.notDeepEqual(chosenBaseline, originalBaseline);
}

async function installedRuntime(
  consumer: string,
  env: NodeJS.ProcessEnv = {},
): Promise<InstalledReads> {
  const result = await run(
    "node",
    [join(consumer, "runtime.mjs")],
    consumer,
    env,
  );
  assert.equal(
    result.code,
    0,
    `安装制品 readReference／collect 场景失败：\n${result.stdout}\n${result.stderr}`,
  );
  return JSON.parse(result.stdout) as InstalledReads;
}

function assertReportSelection(
  output: string,
  bindingId: string,
  referenceId: string,
  expected: InstalledSelection,
): void {
  const report = readReport(output);
  const bindings = report.bindings;
  assert.ok(Array.isArray(bindings));
  const binding = bindings.find(
    (candidate) => isRecord(candidate) && candidate.bindingId === bindingId,
  );
  assert.ok(isRecord(binding));
  assert.ok(isRecord(binding.current));
  assert.ok(isRecord(binding.current.references));
  const reference = binding.current.references[referenceId];
  assert.ok(isRecord(reference));
  assert.equal(reference.value, expected.value);
  assert.deepEqual(reference.range, expected.range);
}

function referenceChange(
  report: RecordValue,
  bindingId: string,
  referenceId: string,
): string | undefined {
  assert.ok(Array.isArray(report.bindings));
  const binding = report.bindings.find(
    (candidate) => isRecord(candidate) && candidate.bindingId === bindingId,
  );
  assert.ok(isRecord(binding));
  assert.ok(Array.isArray(binding.changes));
  const change = binding.changes.find(
    (candidate) =>
      isRecord(candidate) &&
      (candidate.referenceId === referenceId ||
        (candidate.kind === "fact" && candidate.referenceId === referenceId)),
  );
  return isRecord(change) && typeof change.kind === "string"
    ? change.kind
    : undefined;
}

function assertReferenceError(
  output: string,
  code: string,
  referenceId?: string,
): void {
  const report = readReport(output);
  assert.ok(Array.isArray(report.bindings));
  assert.equal(
    report.bindings.some(
      (binding) =>
        isRecord(binding) &&
        Array.isArray(binding.errors) &&
        binding.errors.some(
          (error) =>
            isRecord(error) &&
            error.code === code &&
            (referenceId === undefined || error.referenceId === referenceId),
        ),
    ),
    true,
    `报告未包含引用错误 ${code}`,
  );
}

function referenceErrorMessage(
  output: string,
  referenceId: string,
  code: string,
): string {
  const report = readReport(output);
  assert.ok(Array.isArray(report.bindings));
  for (const binding of report.bindings) {
    if (!isRecord(binding) || !Array.isArray(binding.errors)) continue;
    for (const error of binding.errors) {
      if (
        isRecord(error) &&
        error.referenceId === referenceId &&
        error.code === code &&
        typeof error.message === "string"
      ) {
        return error.message;
      }
    }
  }
  assert.fail(`报告未包含引用 ${referenceId} 的错误 ${code}`);
}

function parseEnvelope(output: string): RecordValue {
  const value: unknown = JSON.parse(output);
  assert.ok(isRecord(value));
  return value;
}

function readReport(output: string): RecordValue {
  const envelope = parseEnvelope(output);
  assert.ok(isRecord(envelope.data));
  assert.ok(isRecord(envelope.data.report));
  return envelope.data.report;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runDock(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<ProcessResult> {
  return run(executable, arguments_, cwd, env);
}

function run(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<ProcessResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(executable, [...arguments_], {
      cwd,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectResult);
    child.once("close", (code) => {
      resolveResult({ code: code ?? 1, stdout, stderr });
    });
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Markdown 安装验收失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
