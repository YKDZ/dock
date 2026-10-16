import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, copyFile, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ProcessResult = {
  readonly code: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

type CliEnvelope = {
  readonly kind: string;
  readonly variant?: string;
  readonly data?: {
    readonly report?: unknown;
    readonly errors?: readonly {
      readonly bindingId?: string;
      readonly code: string;
      readonly message: string;
    }[];
  };
};

type MaintenanceReport = {
  readonly execution?: {
    readonly commandAttempts: number;
    readonly testExecutions: number;
  };
  readonly bindings: readonly {
    readonly bindingId: string;
    readonly errors?: readonly { readonly code: string }[];
  }[];
};

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDirectory = join(
  packageDirectory,
  "fixtures",
  "installed-consumer",
);

async function main(): Promise<void> {
  assert.equal(
    process.version,
    "v24.21.0",
    "Node 状态迁移只在已确认的 Node 24.21.0 上验收。",
  );
  const artifacts = process.argv.slice(2);
  assert.equal(
    artifacts.length,
    3,
    "根 check:install 必须传入同批 core、SDK 与 Node test 制品。",
  );
  const tarballs = artifacts.map((artifact) =>
    resolve(process.cwd(), artifact),
  );
  await Promise.all(tarballs.map((artifact) => access(artifact)));

  const temporary = await mkdtemp(join(tmpdir(), "dock-node-installed-"));
  const consumer = join(temporary, "consumer");
  try {
    await cp(fixtureDirectory, consumer, { recursive: true });
    const installation = await run(
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
      installation.code,
      0,
      `Node 正式制品干净安装失败：\n${installation.stdout}\n${installation.stderr}`,
    );

    await verifyInstalledTypes(consumer);
    await verifyRuntimeInputDiagnostics(consumer);
    const bin = join(
      consumer,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "dock.cmd" : "dock",
    );
    await verifyHappyRoundTrip(bin, consumer);
    await verifyEffectiveRoot(bin, consumer);
    await verifyOperationLocalExecution(consumer);
    await verifyFailureIsolation(bin, consumer);
    await verifyRunLifecycle(bin, consumer);
    await verifyInterruptedProcess(bin, consumer);
    await verifyStatusesAndIdentity(bin, consumer);
    await verifyConflictPreflight(bin, consumer);
    await verifyOrdinaryNodeTest(consumer);
    await verifyNoFrameworkDependency(consumer);
    process.stdout.write(
      "Node 原生状态、安装类型、维护往返与故障隔离验收通过。\n",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
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
    `安装制品公开 Node 类型正负例未通过：\n${result.stdout}\n${result.stderr}`,
  );
}

async function verifyRuntimeInputDiagnostics(consumer: string): Promise<void> {
  const result = await run(
    process.execPath,
    [join(consumer, "runtime-inputs.mjs")],
    consumer,
  );
  assert.equal(
    result.code,
    0,
    `动态 Node 声明未给出明确输入诊断：\n${result.stdout}\n${result.stderr}`,
  );
}

async function verifyHappyRoundTrip(
  bin: string,
  consumer: string,
): Promise<void> {
  const firstCheck = await runDock(
    bin,
    ["check", "--config", "dock.config.mts", "--json"],
    consumer,
  );
  assert.equal(firstCheck.code, 1, firstCheck.stderr);
  assert.notEqual(
    firstCheck.stdout.trim(),
    "",
    `首次检查未输出 JSON 报告：\n${firstCheck.stderr}`,
  );
  const initial = parseEnvelope(firstCheck.stdout);
  assert.equal(initial.variant, "changed", JSON.stringify(initial, null, 2));
  assertExecutionSummary(requireReport(initial), 1, 2);

  const textCheck = await runDock(
    bin,
    ["check", "--config", "dock.config.mts"],
    consumer,
  );
  assert.equal(textCheck.code, 1, textCheck.stderr);
  assert.match(textCheck.stdout, /执行：2 个测试，1 次命令尝试/);

  const update = await runDock(
    bin,
    ["baseline", "update", "--config", "dock.config.mts", "--json"],
    consumer,
  );
  assert.equal(update.code, 0, update.stderr);
  const updated = parseEnvelope(update.stdout);
  assert.equal(updated.variant, "updated");
  assertExecutionSummary(requireReport(updated), 1, 2);
  await access(join(consumer, "dock.baseline.json"));

  const current = await runDock(
    bin,
    ["check", "--config", "dock.config.mts", "--json"],
    consumer,
  );
  assert.equal(current.code, 0, current.stderr);
  const checked = parseEnvelope(current.stdout);
  assert.equal(checked.variant, "consistent");
  assertExecutionSummary(requireReport(checked), 1, 2);
}

async function verifyEffectiveRoot(
  bin: string,
  consumer: string,
): Promise<void> {
  const arguments_ = ["--config", "configurations/rooted.config.mts", "--json"];
  const update = await runDock(
    bin,
    ["baseline", "update", ...arguments_],
    consumer,
  );
  assert.equal(update.code, 0, update.stderr);
  const updated = parseEnvelope(update.stdout);
  assert.equal(updated.variant, "updated");
  const updateReport = requireReport(updated);
  assertBindingHasNoErrors(updateReport, "有效 root 维护");
  assertExecutionSummary(updateReport, 1, 1);
  await access(join(consumer, "effective-root", "rooted.baseline.json"));

  const check = await runDock(bin, ["check", ...arguments_], consumer);
  assert.equal(check.code, 0, check.stderr);
  const checked = parseEnvelope(check.stdout);
  assert.equal(checked.variant, "consistent");
  const checkReport = requireReport(checked);
  assertBindingHasNoErrors(checkReport, "有效 root 维护");
  assertExecutionSummary(checkReport, 1, 1);
}

async function verifyFailureIsolation(
  bin: string,
  consumer: string,
): Promise<void> {
  const check = await runDock(
    bin,
    ["check", "--config", "isolation.config.mts", "--json"],
    consumer,
  );
  assert.equal(check.code, 1, check.stderr);
  const envelope = parseEnvelope(check.stdout);
  assert.equal(envelope.variant, "errors");
  const report = requireReport(envelope);
  assertExecutionSummary(report, 1, 2);
  assertBindingError(report, "失败业务", "test-failed");
  assertBindingHasNoErrors(report, "独立业务");

  const update = await runDock(
    bin,
    ["baseline", "update", "--config", "isolation.config.mts", "--json"],
    consumer,
  );
  assert.equal(update.code, 1, update.stderr);
  assert.equal(parseEnvelope(update.stdout).variant, "rejected");
  await assert.rejects(access(join(consumer, "isolation.baseline.json")), {
    code: "ENOENT",
  });
}

async function verifyOperationLocalExecution(consumer: string): Promise<void> {
  const result = await run(
    process.execPath,
    [join(consumer, "operation-local.mts")],
    consumer,
  );
  assert.equal(
    result.code,
    0,
    `同进程连续维护没有重新执行 Node 测试：\n${result.stdout}\n${result.stderr}`,
  );
}

async function verifyRunLifecycle(
  bin: string,
  consumer: string,
): Promise<void> {
  const closeFailure = await runDock(
    bin,
    ["check", "--config", "close-failure.config.mts", "--json"],
    consumer,
  );
  assert.equal(closeFailure.code, 1, closeFailure.stderr);
  const closeEnvelope = parseEnvelope(closeFailure.stdout);
  assert.equal(closeEnvelope.variant, "errors");
  assertBindingError(
    requireReport(closeEnvelope),
    "关闭状态",
    "run-lifecycle-failed",
  );

  const cancelled = await runDock(
    bin,
    ["check", "--config", "cancelled.config.mts", "--json"],
    consumer,
  );
  assert.equal(cancelled.code, 1, cancelled.stderr);
  const cancelledEnvelope = parseEnvelope(cancelled.stdout);
  assert.equal(cancelledEnvelope.variant, "errors");
  const cancelledReport = requireReport(cancelledEnvelope);
  assertBindingError(cancelledReport, "已进入", "test-cancelled");
  assertBindingError(cancelledReport, "未进入", "test-not-executed");
  assertExecutionSummary(cancelledReport, 1, 2);

  const startupFailure = await runDock(
    bin,
    ["check", "--config", "startup-failure.config.mts", "--json"],
    consumer,
  );
  assert.equal(startupFailure.code, 1, startupFailure.stderr);
  const startupEnvelope = parseEnvelope(startupFailure.stdout);
  assert.equal(startupEnvelope.variant, "errors");
  assertBindingError(
    requireReport(startupEnvelope),
    "启动失败",
    "run-lifecycle-failed",
  );
}

async function verifyInterruptedProcess(
  bin: string,
  consumer: string,
): Promise<void> {
  const baselinePath = join(consumer, "interrupted.baseline.json");
  await copyFile(join(consumer, "dock.baseline.json"), baselinePath);
  const baselineBytes = await readFile(baselinePath);

  const check = await runDock(
    bin,
    ["check", "--config", "interrupted.config.mts", "--json"],
    consumer,
  );
  assert.equal(check.code, 1, check.stderr);
  assert.equal(check.signal, null);
  assert.equal(check.timedOut, false);
  const checkEnvelope = parseEnvelope(check.stdout);
  assert.equal(checkEnvelope.variant, "errors");
  const checkReport = requireReport(checkEnvelope);
  assertBindingError(checkReport, "中断状态", "run-lifecycle-failed");
  assert.equal(checkReport.execution?.commandAttempts, 1);
  assert.deepEqual(await readFile(baselinePath), baselineBytes);

  const update = await runDock(
    bin,
    ["baseline", "update", "--config", "interrupted.config.mts", "--json"],
    consumer,
  );
  assert.equal(update.code, 1, update.stderr);
  assert.equal(update.signal, null);
  assert.equal(update.timedOut, false);
  const updateEnvelope = parseEnvelope(update.stdout);
  assert.equal(updateEnvelope.variant, "rejected");
  const updateReport = requireReport(updateEnvelope);
  assertBindingError(updateReport, "中断状态", "run-lifecycle-failed");
  assert.equal(updateReport.execution?.commandAttempts, 1);
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
}

async function verifyStatusesAndIdentity(
  bin: string,
  consumer: string,
): Promise<void> {
  const statuses = await runDock(
    bin,
    ["check", "--config", "statuses.config.mts", "--json"],
    consumer,
  );
  assert.equal(statuses.code, 1, statuses.stderr);
  const statusReport = requireReport(parseEnvelope(statuses.stdout));
  assertBindingError(statusReport, "非通过状态", "test-skipped");
  assertBindingError(statusReport, "非通过状态", "test-todo");

  const filtered = await runDock(
    bin,
    ["check", "--config", "filtered.config.mts", "--json"],
    consumer,
  );
  assert.equal(filtered.code, 1, filtered.stderr);
  const filteredReport = requireReport(parseEnvelope(filtered.stdout));
  assertBindingError(filteredReport, "被筛除", "test-filtered");
  assertBindingHasNoErrors(filteredReport, "筛选保留");
  assertExecutionSummary(filteredReport, 1, 1);

  const duplicate = await runDock(
    bin,
    ["check", "--config", "duplicate.config.mts", "--json"],
    consumer,
  );
  assert.equal(duplicate.code, 1, duplicate.stderr);
  const duplicateReport = requireReport(parseEnvelope(duplicate.stdout));
  assertBindingError(duplicateReport, "重复业务", "duplicate-test-identity");
  assertExecutionSummary(duplicateReport, 1, 2);
}

async function verifyConflictPreflight(
  bin: string,
  consumer: string,
): Promise<void> {
  const marker = join(consumer, "test-workspace", "conflict-started.marker");
  const check = await runDock(
    bin,
    ["check", "--config", "conflict.config.mts", "--json"],
    consumer,
  );
  assert.equal(check.code, 1, check.stderr);
  const report = requireReport(parseEnvelope(check.stdout));
  assertBindingError(report, "首项冲突", "run-lifecycle-failed");
  assertBindingError(report, "次项冲突", "run-lifecycle-failed");
  assertExecutionSummary(report, 0, 0);
  await assert.rejects(access(marker), { code: "ENOENT" });
}

async function verifyOrdinaryNodeTest(consumer: string): Promise<void> {
  const passing = await run(
    process.execPath,
    ["--test", join(consumer, "test-workspace/test/ordinary.test.mts")],
    consumer,
  );
  assert.equal(
    passing.code,
    0,
    `普通 Node 原生通过语义发生变化：\n${passing.stdout}\n${passing.stderr}`,
  );

  const failing = await run(
    process.execPath,
    ["--test", join(consumer, "test-workspace/test/ordinary-failure.test.mts")],
    consumer,
  );
  assert.equal(
    failing.code,
    1,
    `普通 Node 原生失败语义发生变化：\n${failing.stdout}\n${failing.stderr}`,
  );
}

async function verifyNoFrameworkDependency(consumer: string): Promise<void> {
  const listing = await run(
    "npm",
    ["ls", "--all", "--json", "--prefix", consumer],
    consumer,
  );
  assert.equal(listing.code, 0, listing.stderr);
  const names = new Set<string>();
  collectPackageNames(JSON.parse(listing.stdout) as unknown, names);
  for (const dependency of [
    "vitest",
    "@vitest/runner",
    "@dock/reference-vitest",
  ]) {
    assert.equal(names.has(dependency), false, `Node 包不能依赖 ${dependency}`);
  }
}

async function runDock(
  bin: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<ProcessResult> {
  return await run(bin, arguments_, cwd);
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
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 30_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectResult(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveResult({
        code: code ?? 1,
        signal,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function parseEnvelope(output: string): CliEnvelope {
  return JSON.parse(output) as CliEnvelope;
}

function requireReport(envelope: CliEnvelope): MaintenanceReport {
  assert.ok(envelope.data?.report !== undefined);
  return envelope.data.report as MaintenanceReport;
}

function assertExecutionSummary(
  report: MaintenanceReport,
  commandAttempts: number,
  testExecutions: number,
): void {
  assert.deepEqual(report.execution, { commandAttempts, testExecutions });
}

function assertBindingError(
  report: MaintenanceReport,
  bindingId: string,
  code: string,
): void {
  const binding = report.bindings.find((item) => item.bindingId === bindingId);
  assert.ok(binding, `缺少关联 ${bindingId}`);
  assert.ok(
    binding.errors?.some((error) => error.code === code),
    `关联 ${bindingId} 未报告 ${code}：${JSON.stringify(binding.errors)}`,
  );
}

function assertBindingHasNoErrors(
  report: MaintenanceReport,
  bindingId: string,
): void {
  const binding = report.bindings.find((item) => item.bindingId === bindingId);
  assert.ok(binding, `缺少关联 ${bindingId}`);
  assert.equal(binding.errors, undefined, `关联 ${bindingId} 受到无关错误影响`);
}

function collectPackageNames(value: unknown, names: Set<string>): void {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return;
  const packageValue = value as {
    readonly name?: unknown;
    readonly dependencies?: unknown;
  };
  if (typeof packageValue.name === "string") names.add(packageValue.name);
  if (
    typeof packageValue.dependencies !== "object" ||
    packageValue.dependencies === null ||
    Array.isArray(packageValue.dependencies)
  ) {
    return;
  }
  for (const [name, dependency] of Object.entries(packageValue.dependencies)) {
    names.add(name);
    collectPackageNames(dependency, names);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Node 安装验收失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
