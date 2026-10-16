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

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDirectory = join(
  packageDirectory,
  "fixtures",
  "installed-consumer",
);

async function main(): Promise<void> {
  const artifacts = process.argv.slice(2);
  assert.equal(
    artifacts.length,
    4,
    "根 Turbo 验收必须传入同批 core、SDK、file 与 TypeScript 包制品。",
  );
  const tarballs = artifacts.map((artifact) =>
    resolve(process.cwd(), artifact),
  );
  await Promise.all(tarballs.map((artifact) => access(artifact)));

  const consumer = await mkdtemp(join(tmpdir(), "dock-typescript-consumer-"));
  try {
    await installConsumer(consumer, tarballs);
    await copyFixtures(consumer);
    await verifyParserVersion(consumer);
    await verifyInstalledTypes(consumer);
    await verifyDynamicValidation(consumer);
    await verifyInstalledCli(consumer);
    process.stdout.write(
      "TypeScript 安装制品公开类型、解析、读取与 CLI 验收通过。\n",
    );
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
      name: "dock-typescript-installed-consumer",
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
    "invalid-runtime.mjs",
    "negative.mts",
    "positive.mts",
    "runtime.mjs",
    "symbol-source.ts",
    "tsconfig.json",
  ]) {
    await copyFile(join(fixtureDirectory, name), join(consumer, name));
  }
  await writeFile(
    join(consumer, "symbol-copy.ts"),
    await readFile(join(consumer, "symbol-source.ts")),
  );
}

async function verifyParserVersion(consumer: string): Promise<void> {
  const pkg = JSON.parse(
    await readFile(
      join(consumer, "node_modules", "typescript", "package.json"),
      "utf8",
    ),
  ) as { readonly version?: unknown };
  assert.equal(pkg.version, "5.9.3");
}

async function verifyInstalledTypes(consumer: string): Promise<void> {
  const compiler = join(
    consumer,
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

async function verifyDynamicValidation(consumer: string): Promise<void> {
  const result = await run(
    "node",
    [join(consumer, "invalid-runtime.mjs")],
    consumer,
  );
  assert.equal(
    result.code,
    0,
    `安装制品动态非法选择没有被拒绝：\n${result.stdout}\n${result.stderr}`,
  );
}

async function verifyInstalledCli(consumer: string): Promise<void> {
  const bin = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "dock.cmd" : "dock",
  );
  const baselinePath = join(consumer, "typescript.baseline.json");
  const initialRead = await installedRuntime(consumer);
  assert.equal(initialRead.value, "input + 1");

  const initialCheck = await runDock(
    bin,
    ["check", "--config", "dock.config.mjs", "--json"],
    consumer,
  );
  assert.equal(initialCheck.code, 1, initialCheck.stderr);
  assert.equal(parseEnvelope(initialCheck.stdout).variant, "changed");
  assertReportSelection(initialCheck.stdout, initialRead);

  const initialUpdate = await runDock(
    bin,
    ["baseline", "update", "--config", "dock.config.mjs", "--json"],
    consumer,
  );
  assert.equal(initialUpdate.code, 0, initialUpdate.stderr);
  assert.equal(parseEnvelope(initialUpdate.stdout).variant, "updated");
  const initialBaseline = await readFile(baselinePath);
  const consistent = await runDock(
    bin,
    ["check", "--config", "dock.config.mjs", "--json"],
    consumer,
  );
  assert.equal(consistent.code, 0, consistent.stderr);
  assert.equal(parseEnvelope(consistent.stdout).variant, "consistent");

  const sourcePath = join(consumer, "symbol-source.ts");
  const originalSource = await readFile(sourcePath, "utf8");
  const changedSource = originalSource.replace("input + 1", "input + 2");
  assert.notEqual(changedSource, originalSource);
  await writeFile(sourcePath, changedSource, "utf8");
  const changedRead = await installedRuntime(consumer);
  assert.equal(changedRead.value, "input + 2");
  const drift = await runDock(
    bin,
    ["check", "--config", "dock.config.mjs", "--json"],
    consumer,
  );
  assert.equal(drift.code, 1, drift.stderr);
  assert.equal(parseEnvelope(drift.stdout).variant, "changed");
  assert.equal(referenceChange(readReport(drift.stdout)), "fact");
  assertReportSelection(drift.stdout, changedRead);
  const validUpdate = await runDock(
    bin,
    ["baseline", "update", "--config", "dock.config.mjs", "--json"],
    consumer,
  );
  assert.equal(validUpdate.code, 0, validUpdate.stderr);
  const changedBaseline = await readFile(baselinePath);

  const movedSource = `// 无关前文\n${changedSource}`;
  await writeFile(sourcePath, movedSource, "utf8");
  const movedRead = await installedRuntime(consumer);
  assert.equal(movedRead.value, changedRead.value);
  assert.ok(movedRead.range.start > changedRead.range.start);
  const movedCheck = await runDock(
    bin,
    ["check", "--config", "dock.config.mjs", "--json"],
    consumer,
  );
  assert.equal(movedCheck.code, 0, movedCheck.stderr);
  assert.equal(parseEnvelope(movedCheck.stdout).variant, "consistent");
  assert.deepEqual(await readFile(baselinePath), changedBaseline);

  await writeFile(join(consumer, "symbol-copy.ts"), movedSource, "utf8");
  const targetChange = await runDock(
    bin,
    ["check", "--config", "dock.config.mjs", "--json"],
    consumer,
    { DOCK_SYMBOL_TARGET: "symbol-copy.ts" },
  );
  assert.equal(targetChange.code, 1, targetChange.stderr);
  assert.equal(parseEnvelope(targetChange.stdout).variant, "changed");
  assert.equal(
    referenceChange(readReport(targetChange.stdout)),
    "reference-definition",
  );
  const copyRead = {
    value: movedRead.value,
    range: { ...movedRead.range, path: "symbol-copy.ts" },
  };
  assertReportSelection(targetChange.stdout, copyRead);
  const targetUpdate = await runDock(
    bin,
    ["baseline", "update", "--config", "dock.config.mjs", "--json"],
    consumer,
    { DOCK_SYMBOL_TARGET: "symbol-copy.ts" },
  );
  assert.equal(targetUpdate.code, 0, targetUpdate.stderr);
  const targetBaseline = await readFile(baselinePath);

  const selectionChange = await runDock(
    bin,
    ["check", "--config", "dock.config.mjs", "--json"],
    consumer,
    { DOCK_SYMBOL_TARGET: "symbol-copy.ts", DOCK_SYMBOL_MODE: "quote" },
  );
  assert.equal(selectionChange.code, 1, selectionChange.stderr);
  assert.equal(parseEnvelope(selectionChange.stdout).variant, "changed");
  assert.equal(
    referenceChange(readReport(selectionChange.stdout)),
    "reference-definition",
  );
  assertReportSelection(selectionChange.stdout, copyRead);
  const selectionUpdate = await runDock(
    bin,
    ["baseline", "update", "--config", "dock.config.mjs", "--json"],
    consumer,
    { DOCK_SYMBOL_TARGET: "symbol-copy.ts", DOCK_SYMBOL_MODE: "quote" },
  );
  assert.equal(selectionUpdate.code, 0, selectionUpdate.stderr);
  const selectedBaseline = await readFile(baselinePath);

  const missing = await runDock(
    bin,
    ["check", "--config", "dock.config.mjs", "--json"],
    consumer,
    { DOCK_SYMBOL_TARGET: "symbol-copy.ts", DOCK_SYMBOL_MODE: "missing" },
  );
  assert.equal(missing.code, 1, missing.stderr);
  assert.equal(parseEnvelope(missing.stdout).variant, "errors");
  assertReferenceError(missing.stdout, "missing-symbol");
  const rejectedMissing = await runDock(
    bin,
    ["baseline", "update", "--config", "dock.config.mjs", "--json"],
    consumer,
    { DOCK_SYMBOL_TARGET: "symbol-copy.ts", DOCK_SYMBOL_MODE: "missing" },
  );
  assert.equal(rejectedMissing.code, 1, rejectedMissing.stderr);
  assert.equal(parseEnvelope(rejectedMissing.stdout).variant, "rejected");
  assert.deepEqual(await readFile(baselinePath), selectedBaseline);

  await writeFile(
    join(consumer, "symbol-copy.ts"),
    "function broken( {\n",
    "utf8",
  );
  const syntaxError = await runDock(
    bin,
    ["check", "--config", "dock.config.mjs", "--json"],
    consumer,
    { DOCK_SYMBOL_TARGET: "symbol-copy.ts", DOCK_SYMBOL_MODE: "quote" },
  );
  assert.equal(syntaxError.code, 1, syntaxError.stderr);
  assert.equal(parseEnvelope(syntaxError.stdout).variant, "errors");
  assertReferenceError(syntaxError.stdout, "typescript-syntax-error");
  const rejectedSyntax = await runDock(
    bin,
    ["baseline", "update", "--config", "dock.config.mjs", "--json"],
    consumer,
    { DOCK_SYMBOL_TARGET: "symbol-copy.ts", DOCK_SYMBOL_MODE: "quote" },
  );
  assert.equal(rejectedSyntax.code, 1, rejectedSyntax.stderr);
  assert.equal(parseEnvelope(rejectedSyntax.stdout).variant, "rejected");
  assert.deepEqual(await readFile(baselinePath), selectedBaseline);
  assert.notDeepEqual(selectedBaseline, initialBaseline);
  assert.notDeepEqual(targetBaseline, changedBaseline);
  assert.notDeepEqual(selectedBaseline, targetBaseline);
}

async function installedRuntime(consumer: string): Promise<InstalledSelection> {
  const result = await run("node", [join(consumer, "runtime.mjs")], consumer);
  assert.equal(
    result.code,
    0,
    `安装制品 readReference／collect 场景失败：\n${result.stdout}\n${result.stderr}`,
  );
  const value: unknown = JSON.parse(result.stdout);
  assert.ok(isRecord(value));
  assert.ok(isRecord(value.read));
  const read = value.read;
  const rangeValue = read.range;
  assert.ok(isRecord(rangeValue));
  const range = rangeValue;
  assert.equal(range.path, "symbol-source.ts");
  assert.ok(typeof range.start === "number");
  assert.ok(typeof range.end === "number");
  assert.ok(typeof read.value === "string");
  assert.ok(isRecord(value.checked));
  assert.deepEqual(
    { value: value.checked.value, range: value.checked.range },
    read,
  );
  return {
    value: read.value,
    range: { path: range.path, start: range.start, end: range.end },
  };
}

type InstalledSelection = {
  readonly value: string;
  readonly range: {
    readonly path: string;
    readonly start: number;
    readonly end: number;
  };
};

function assertReportSelection(
  output: string,
  expected: InstalledSelection,
): void {
  const report = readReport(output);
  assert.ok(Array.isArray(report.bindings));
  const binding = report.bindings.find(
    (candidate) =>
      isRecord(candidate) && candidate.bindingId === "typescript-policy",
  );
  assert.ok(isRecord(binding));
  assert.ok(isRecord(binding.current));
  assert.ok(isRecord(binding.current.references));
  const reference = binding.current.references["calculate-expression"];
  assert.ok(isRecord(reference));
  assert.equal(reference.value, expected.value);
  assert.deepEqual(reference.range, expected.range);
}

function referenceChange(report: RecordValue): string | undefined {
  assert.ok(Array.isArray(report.bindings));
  const binding = report.bindings.find(
    (candidate) =>
      isRecord(candidate) && candidate.bindingId === "typescript-policy",
  );
  assert.ok(isRecord(binding));
  assert.ok(Array.isArray(binding.changes));
  const change = binding.changes.find(
    (candidate) =>
      isRecord(candidate) && candidate.referenceId === "calculate-expression",
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
    `TypeScript 安装验收失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
