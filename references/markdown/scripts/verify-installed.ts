import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  readonly standalone: InstalledSelection;
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
    "根验收必须传入同批 core、SDK、file 与 Markdown 包制品路径。",
  );
  const tarballs = artifacts.map((artifact) =>
    resolve(process.cwd(), artifact),
  );
  await Promise.all(tarballs.map((artifact) => access(artifact)));

  const consumer = await mkdtemp(join(tmpdir(), "dock-markdown-consumer-"));
  try {
    await installConsumer(consumer, tarballs);
    await copyFixtures(consumer);
    await verifyInstalledTypes(consumer);
    await verifyInstalledReads(consumer);
    await verifyInstalledEmptyCells(consumer);
    await verifyInstalledCli(consumer);
    process.stdout.write("Markdown 安装制品公开类型、读取与 CLI 验收通过。\n");
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
    "invalid-config.mjs",
    "negative.mts",
    "positive.mts",
    "runtime.mjs",
    "tsconfig.json",
  ]) {
    await copyFile(join(fixtureDirectory, name), join(consumer, name));
  }
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
  assert.equal(initial.standalone.value, initial.chapter.value);
  assert.equal(initial["ordinary-file"].value, source);
  assert.equal(initial["ordinary-file"].range.start, 0);
  assert.equal(initial["ordinary-file"].range.end, source.length);
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

  const update = await runDock(
    bin,
    ["baseline", "update", "--config", config, "--json"],
    consumer,
  );
  assert.equal(update.code, 0, update.stderr);
  assert.equal(parseEnvelope(update.stdout).variant, "updated");
  const originalBaseline = await readFile(baselinePath);

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
  const changedSource = original.replace("版本一", "版本二");
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
  const changedReads = await installedRuntime(consumer);
  assertReportSelection(
    changed.stdout,
    "markdown-policy",
    "chapter",
    changedReads.chapter,
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
  assert.notEqual(
    movedReads.chapter.range.start,
    initialReads.chapter.range.start,
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

function assertReferenceError(output: string, code: string): void {
  const report = readReport(output);
  assert.ok(Array.isArray(report.bindings));
  assert.equal(
    report.bindings.some(
      (binding) =>
        isRecord(binding) &&
        Array.isArray(binding.errors) &&
        binding.errors.some((error) => isRecord(error) && error.code === code),
    ),
    true,
    `报告未包含引用错误 ${code}`,
  );
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
