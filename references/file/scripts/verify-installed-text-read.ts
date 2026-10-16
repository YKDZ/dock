import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

/** 通过正式消费者的已安装制品验收文本定位、当前读取与失败边界。 */
export async function verifyInstalledTextRead(consumer: string): Promise<void> {
  const directory = join(consumer, `text-read-consumer-${randomUUID()}`);
  const bin = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "dock.cmd" : "dock",
  );
  await mkdir(directory);
  try {
    await copyFile(
      join(fixtureDirectory, "dock.config-text-read.mjs"),
      join(directory, "dock.config.mjs"),
    );
    await copyFile(
      join(fixtureDirectory, "text-read-runtime.mjs"),
      join(directory, "text-read-runtime.mjs"),
    );
    await verifyInstalledTextReadTypes(directory);
    const initialSource =
      "😀说明\n<!-- 原文注释保留 -->\n#region runtime\nport=4173\n#endregion runtime\n";
    await writeFile(join(directory, "guide.md"), initialSource, "utf8");

    const initial = await runDock(
      bin,
      ["check", "--config", "dock.config.mjs", "--json"],
      directory,
    );
    assert.equal(initial.code, 1, initial.stderr);
    assert.equal(parseEnvelope(initial.stdout).variant, "changed");
    assertSelectedValue(
      initial.stdout,
      "4173",
      "guide.md",
      initialSource.indexOf("4173"),
      "runtime-policy",
      "runtime-port",
    );

    await assertInstalledDirectRead(
      directory,
      "4173",
      initialSource.indexOf("4173"),
    );

    const update = await runDock(
      bin,
      ["baseline", "update", "--config", "dock.config.mjs", "--json"],
      directory,
    );
    assert.equal(update.code, 0, update.stderr);
    assert.equal(parseEnvelope(update.stdout).variant, "updated");

    const movedSource = `前置😀\n${initialSource}`;
    await writeFile(join(directory, "guide.md"), movedSource, "utf8");
    const moved = await runDock(
      bin,
      ["check", "--config", "dock.config.mjs", "--json"],
      directory,
    );
    assert.equal(moved.code, 0, moved.stderr);
    assertSelectedValue(
      moved.stdout,
      "4173",
      "guide.md",
      movedSource.indexOf("4173"),
      "runtime-policy",
      "runtime-port",
    );
    await assertInstalledDirectRead(
      directory,
      "4173",
      movedSource.indexOf("4173"),
    );
    const movedText = await runDock(
      bin,
      ["check", "--config", "dock.config.mjs"],
      directory,
    );
    assert.equal(movedText.code, 0, movedText.stderr);
    assert.match(
      movedText.stdout,
      new RegExp(
        `文本偏移 ${movedSource.indexOf("4173")}–${movedSource.indexOf("4173") + 4}`,
      ),
    );

    const changedSource = movedSource.replace("4173", "5173");
    await writeFile(join(directory, "guide.md"), changedSource, "utf8");
    const changed = await runDock(
      bin,
      ["check", "--config", "dock.config.mjs", "--json"],
      directory,
    );
    assert.equal(changed.code, 1, changed.stderr);
    assert.equal(parseEnvelope(changed.stdout).variant, "changed");
    assertSelectedValue(
      changed.stdout,
      "5173",
      "guide.md",
      changedSource.indexOf("5173"),
      "runtime-policy",
      "runtime-port",
    );
    await assertInstalledDirectRead(
      directory,
      "5173",
      changedSource.indexOf("5173"),
    );

    const baselinePath = join(directory, "dock.baseline.json");
    const savedBaseline = await readFile(baselinePath);
    await writeFile(
      join(directory, "dock.config.mjs"),
      [
        'import { file } from "@dock/reference-file";',
        'import { binding, defineConfig } from "@dock/sdk";',
        'const selected = file.from("guide.md").quote("missing current text").reference("runtime-port");',
        'export default defineConfig({ plugins: [file], bindings: [binding("runtime-policy", [selected])] });',
      ].join("\n"),
    );
    const invalidRead = await runDock(
      bin,
      ["check", "--config", "dock.config.mjs", "--json"],
      directory,
    );
    assert.equal(invalidRead.code, 1, invalidRead.stderr);
    assert.equal(parseEnvelope(invalidRead.stdout).variant, "errors");
    assert.equal(
      findReferenceError(invalidRead.stdout, "missing-selection"),
      true,
    );
    const invalidUpdate = await runDock(
      bin,
      ["baseline", "update", "--config", "dock.config.mjs", "--json"],
      directory,
    );
    assert.equal(invalidUpdate.code, 1, invalidUpdate.stderr);
    assert.equal(parseEnvelope(invalidUpdate.stdout).variant, "rejected");
    assert.deepEqual(await readFile(baselinePath), savedBaseline);

    await verifyInstalledExistence(bin, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertInstalledDirectRead(
  directory: string,
  value: string,
  start: number,
): Promise<void> {
  const result = await run(
    "node",
    [join(directory, "text-read-runtime.mjs"), value, String(start)],
    directory,
  );
  assert.equal(
    result.code,
    0,
    `安装制品 readReference 场景失败：\n${result.stdout}\n${result.stderr}`,
  );
}

async function verifyInstalledTextReadTypes(directory: string): Promise<void> {
  for (const name of [
    "text-read-positive.mts",
    "text-read-negative.mts",
    "text-read-tsconfig.json",
  ]) {
    await copyFile(join(fixtureDirectory, name), join(directory, name));
  }
  const compiler = join(
    packageDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsc.cmd" : "tsc",
  );
  const result = await run(
    compiler,
    ["-p", join(directory, "text-read-tsconfig.json"), "--pretty", "false"],
    directory,
  );
  assert.equal(
    result.code,
    0,
    `安装制品 readReference 类型正负例未通过：\n${result.stdout}\n${result.stderr}`,
  );
}

async function verifyInstalledExistence(
  bin: string,
  directory: string,
): Promise<void> {
  const configPath = join(directory, "dock.config-exists.mjs");
  await writeFile(
    configPath,
    [
      'import { file } from "@dock/reference-file";',
      'import { binding, defineConfig } from "@dock/sdk";',
      'const reference = file.from("guide.md").exists().reference("guide-exists");',
      'export default defineConfig({ plugins: [file], bindings: [binding("existence-policy", [reference])], baseline: "exists.baseline.json" });',
    ].join("\n"),
  );
  const initial = await runDock(
    bin,
    ["check", "--config", "dock.config-exists.mjs", "--json"],
    directory,
  );
  assert.equal(initial.code, 1, initial.stderr);
  assertSelectedValue(
    initial.stdout,
    true,
    "guide.md",
    undefined,
    "existence-policy",
    "guide-exists",
  );
  const update = await runDock(
    bin,
    ["baseline", "update", "--config", "dock.config-exists.mjs", "--json"],
    directory,
  );
  assert.equal(update.code, 0, update.stderr);
  const baselinePath = join(directory, "exists.baseline.json");
  const originalBaseline = await readFile(baselinePath);

  await rm(join(directory, "guide.md"));
  const missing = await runDock(
    bin,
    ["check", "--config", "dock.config-exists.mjs", "--json"],
    directory,
  );
  assert.equal(missing.code, 1, missing.stderr);
  assert.equal(parseEnvelope(missing.stdout).variant, "errors");
  assert.equal(findReferenceError(missing.stdout, "missing-file"), true);
  const rejected = await runDock(
    bin,
    ["baseline", "update", "--config", "dock.config-exists.mjs", "--json"],
    directory,
  );
  assert.equal(rejected.code, 1, rejected.stderr);
  assert.equal(parseEnvelope(rejected.stdout).variant, "rejected");
  assert.deepEqual(await readFile(baselinePath), originalBaseline);
}

function assertSelectedValue(
  output: string,
  value: unknown,
  path: string,
  start: number | undefined,
  bindingId: string,
  referenceId: string,
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
  assert.equal(reference.value, value);
  if (start === undefined) {
    assert.equal(Object.hasOwn(reference, "range"), false);
    return;
  }
  assert.deepEqual(reference.range, {
    path,
    start,
    end: start + String(value).length,
  });
}

function findReferenceError(output: string, code: string): boolean {
  const report = readReport(output);
  assert.ok(Array.isArray(report.bindings));
  return report.bindings.some((candidate) => {
    if (!isRecord(candidate) || !Array.isArray(candidate.errors)) return false;
    return candidate.errors.some(
      (error) => isRecord(error) && error.code === code,
    );
  });
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
  bin: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<ProcessResult> {
  return run(bin, arguments_, cwd);
}

function run(
  command: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<ProcessResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(command, [...arguments_], { cwd });
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
