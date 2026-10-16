import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ProcessResult = {
  readonly code: number | null;
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
  };
};

type MaintenanceReport = {
  readonly execution?: {
    readonly commandAttempts: number;
    readonly failedCommands: number;
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
const versions = ["4.1.11", "5.0.3"] as const;

async function main(): Promise<void> {
  const artifacts = process.argv.slice(2);
  assert.equal(
    artifacts.length,
    4,
    "根 check:install 必须传入同批 core、SDK、Vitest 与 Node test 制品。",
  );
  const tarballs = artifacts.map((artifact) =>
    resolve(process.cwd(), artifact),
  );
  await Promise.all(tarballs.map((artifact) => access(artifact)));

  const [coreTarball, sdkTarball, vitestTarball, nodeTarball] = tarballs;
  assert.ok(coreTarball && sdkTarball && vitestTarball && nodeTarball);
  const vitestTarballs = [coreTarball, sdkTarball, vitestTarball];
  for (const version of versions) {
    await verifyVersion(version, vitestTarballs);
  }
  await verifyCrossFrameworkIdentityConflict([
    coreTarball,
    sdkTarball,
    vitestTarball,
    nodeTarball,
  ]);
  process.stdout.write(
    "Vitest 4.1.11 与 5.0.3 的安装类型、最终状态、完整关闭及跨框架身份冲突验收通过。\n",
  );
}

async function verifyCrossFrameworkIdentityConflict(
  tarballs: readonly string[],
): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "dock-test-frameworks-"));
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
        "vitest@4.1.11",
      ],
      consumer,
    );
    assert.equal(
      installation.code,
      0,
      `Node 与 Vitest 正式制品的交叉安装失败：\n${installation.stdout}\n${installation.stderr}`,
    );

    const maintenanceRoot = join(consumer, "maintenance-root");
    const marker = join(maintenanceRoot, "cross-framework-started.log");
    await mkdir(maintenanceRoot, { recursive: true });
    const dock = join(
      consumer,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "dock.cmd" : "dock",
    );
    const result = await runDock(
      dock,
      ["check", "--config", "cross-framework.config.mts", "--json"],
      consumer,
    );
    assert.equal(result.code, 1, result.stderr);
    const envelope = parseEnvelope(result.stdout);
    assert.equal(envelope.variant, "errors");
    const report = requireReport(envelope);
    assertBindingError(report, "Node 运行", "run-lifecycle-failed");
    assertBindingError(report, "Vitest 运行", "run-lifecycle-failed");
    assertExecutionSummary(report, 0, 0);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function verifyVersion(
  version: (typeof versions)[number],
  tarballs: readonly string[],
): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), `dock-vitest-${version}-`));
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
        `vitest@${version}`,
      ],
      consumer,
    );
    assert.equal(
      installation.code,
      0,
      `Vitest ${version} 正式制品干净安装失败：\n${installation.stdout}\n${installation.stderr}`,
    );

    const maintenanceRoot = join(consumer, "maintenance-root");
    await mkdir(maintenanceRoot, { recursive: true });
    await writeFile(join(maintenanceRoot, "business.data"), "ready\n");

    await verifyInstalledTypes(consumer, version);
    await verifyRuntimeInputs(consumer);
    const dock = join(
      consumer,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "dock.cmd" : "dock",
    );
    const baselinePath = join(maintenanceRoot, "happy.baseline.json");
    await verifyHappyRoundTrip(dock, consumer, baselinePath);
    await verifySuiteFailure(dock, consumer);
    await verifyAdditionalTests(dock, consumer);
    await verifyStatusFailures(dock, consumer, baselinePath);
    await verifyFilterAndIdentity(dock, consumer, baselinePath);
    await verifyConflictPreflight(dock, consumer, baselinePath);
    await verifyLifecycleFailures(dock, consumer, baselinePath, version);
    await verifyOperationLocalExecution(consumer);
    await verifyOrdinaryVitest(consumer);
    await verifyNoNodeDependency(consumer);
    process.stdout.write(`Vitest ${version} 安装场景通过。\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function verifyInstalledTypes(
  consumer: string,
  version: string,
): Promise<void> {
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
    `Vitest ${version} 安装声明的类型正负例未通过：\n${result.stdout}\n${result.stderr}`,
  );
}

async function verifyRuntimeInputs(consumer: string): Promise<void> {
  const result = await run(
    process.execPath,
    [join(consumer, "runtime-inputs.mts")],
    consumer,
  );
  assert.equal(
    result.code,
    0,
    `Vitest 动态声明未拒绝非法运行输入：\n${result.stdout}\n${result.stderr}`,
  );
}

async function verifyHappyRoundTrip(
  dock: string,
  consumer: string,
  baselinePath: string,
): Promise<void> {
  const arguments_ = ["--config", "happy.config.mts", "--json"];
  const firstCheck = await runDock(dock, ["check", ...arguments_], consumer);
  assert.equal(firstCheck.code, 1, firstCheck.stderr);
  const first = parseEnvelope(firstCheck.stdout);
  assert.equal(first.variant, "changed", firstCheck.stdout);
  const firstReport = requireReport(first);
  assertBindingHasNoErrors(firstReport, "通过状态");
  assertExecutionSummary(firstReport, 1, 5, 1);

  const update = await runDock(
    dock,
    ["baseline", "update", ...arguments_],
    consumer,
  );
  assert.equal(update.code, 0, update.stderr);
  const updated = parseEnvelope(update.stdout);
  assert.equal(updated.variant, "updated", update.stdout);
  const updateReport = requireReport(updated);
  assertBindingHasNoErrors(updateReport, "通过状态");
  assertExecutionSummary(updateReport, 1, 5, 1);
  const baselineBytes = await readFile(baselinePath);
  await assert.rejects(access(join(consumer, "happy.baseline.json")), {
    code: "ENOENT",
  });

  const current = await runDock(dock, ["check", ...arguments_], consumer);
  assert.equal(current.code, 0, current.stderr);
  const checked = parseEnvelope(current.stdout);
  assert.equal(checked.variant, "consistent", current.stdout);
  assertBindingHasNoErrors(requireReport(checked), "通过状态");
  assertExecutionSummary(requireReport(checked), 1, 5, 1);
  assert.deepEqual(await readFile(baselinePath), baselineBytes);

  const textCheck = await runDock(
    dock,
    ["check", "--config", "happy.config.mts"],
    consumer,
  );
  assert.equal(textCheck.code, 0, `${textCheck.stdout}\n${textCheck.stderr}`);
  assert.match(textCheck.stdout, /原生命令失败：1 次/);
}

async function verifyStatusFailures(
  dock: string,
  consumer: string,
  baselinePath: string,
): Promise<void> {
  const baselineBytes = await readFile(baselinePath);
  const statuses = await runDock(
    dock,
    ["check", "--config", "statuses.config.mts", "--json"],
    consumer,
  );
  assert.equal(statuses.code, 1, statuses.stderr);
  const statusEnvelope = parseEnvelope(statuses.stdout);
  assert.equal(statusEnvelope.variant, "errors");
  const statusReport = requireReport(statusEnvelope);
  assertBindingError(statusReport, "跳过状态", "test-skipped");
  assertBindingError(statusReport, "待实现状态", "test-todo");
  assertBindingError(statusReport, "主动跳过状态", "test-skipped");
  assertBindingError(statusReport, "缺失状态", "test-not-executed");
  assertExecutionSummary(statusReport, 1, 1);

  const failure = await runDock(
    dock,
    ["check", "--config", "failure.config.mts", "--json"],
    consumer,
  );
  assert.equal(failure.code, 1, failure.stderr);
  const failureEnvelope = parseEnvelope(failure.stdout);
  assert.equal(failureEnvelope.variant, "errors");
  const failureReport = requireReport(failureEnvelope);
  assertBindingError(failureReport, "失败状态", "test-failed");
  assertExecutionSummary(failureReport, 1, 2, 1);

  for (const [config, bindingId, code] of [
    ["statuses.config.mts", "跳过状态", "test-skipped"],
    ["failure.config.mts", "失败状态", "test-failed"],
  ] as const) {
    const update = await runDock(
      dock,
      ["baseline", "update", "--config", config, "--json"],
      consumer,
    );
    assert.equal(update.code, 1, update.stderr);
    const envelope = parseEnvelope(update.stdout);
    assert.equal(envelope.variant, "rejected");
    assertBindingError(requireReport(envelope), bindingId, code);
    assert.deepEqual(await readFile(baselinePath), baselineBytes);
  }
}

async function verifySuiteFailure(
  dock: string,
  consumer: string,
): Promise<void> {
  const maintenanceRoot = join(consumer, "maintenance-root");
  const baselinePath = join(
    maintenanceRoot,
    "suite-close-failure.baseline.json",
  );
  const markerPath = join(maintenanceRoot, "suite-after-all.marker");
  await rm(baselinePath, { force: true });
  await rm(markerPath, { force: true });

  const check = await runDock(
    dock,
    ["check", "--config", "suite-close-failure.config.mts", "--json"],
    consumer,
  );
  assert.equal(check.code, 1, `${check.stdout}\n${check.stderr}`);
  const checkEnvelope = parseEnvelope(check.stdout);
  assert.equal(checkEnvelope.variant, "errors", check.stdout);
  const checkReport = requireReport(checkEnvelope);
  assertBindingError(checkReport, "共同收尾状态", "run-lifecycle-failed");
  assertExecutionSummary(checkReport, 1, 3, 1);
  assert.equal(await readFile(markerPath, "utf8"), "收尾已执行\n");

  const update = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "suite-close-failure.config.mts",
      "--json",
    ],
    consumer,
  );
  assert.equal(update.code, 1, `${update.stdout}\n${update.stderr}`);
  const updateEnvelope = parseEnvelope(update.stdout);
  assert.equal(updateEnvelope.variant, "rejected", update.stdout);
  assertBindingError(
    requireReport(updateEnvelope),
    "共同收尾状态",
    "run-lifecycle-failed",
  );
  assertExecutionSummary(requireReport(updateEnvelope), 1, 3, 1);
  await assert.rejects(access(baselinePath), { code: "ENOENT" });
}

async function verifyAdditionalTests(
  dock: string,
  consumer: string,
): Promise<void> {
  const markerPath = join(
    consumer,
    "maintenance-root",
    "additional-test.marker",
  );
  await rm(markerPath, { force: true });

  const update = await runDock(
    dock,
    ["baseline", "update", "--config", "additional-tests.config.mjs", "--json"],
    consumer,
  );
  assert.equal(update.code, 0, `${update.stdout}\n${update.stderr}`);
  const envelope = parseEnvelope(update.stdout);
  assert.equal(envelope.variant, "updated", update.stdout);
  const report = requireReport(envelope);
  assertBindingHasNoErrors(report, "明确必需的状态");
  assert.equal(
    await readFile(markerPath, "utf8"),
    "额外测试已执行\n额外测试已执行\n",
  );
  assertExecutionSummary(report, 1, 3, 1);
}

async function verifyFilterAndIdentity(
  dock: string,
  consumer: string,
  baselinePath: string,
): Promise<void> {
  const baselineBytes = await readFile(baselinePath);
  const filtered = await runDock(
    dock,
    ["check", "--config", "filter.config.mts", "--json"],
    consumer,
  );
  assert.equal(filtered.code, 1, filtered.stderr);
  const filteredEnvelope = parseEnvelope(filtered.stdout);
  assert.equal(filteredEnvelope.variant, "errors");
  const filteredReport = requireReport(filteredEnvelope);
  assertBindingHasNoErrors(filteredReport, "保留状态");
  assertBindingHasSomeError(filteredReport, "筛除状态");
  assertExecutionSummary(filteredReport, 1, 1);

  const duplicate = await runDock(
    dock,
    ["check", "--config", "duplicate.config.mts", "--json"],
    consumer,
  );
  assert.equal(duplicate.code, 1, duplicate.stderr);
  const duplicateEnvelope = parseEnvelope(duplicate.stdout);
  assert.equal(duplicateEnvelope.variant, "errors");
  const duplicateReport = requireReport(duplicateEnvelope);
  assertBindingError(duplicateReport, "歧义状态", "duplicate-test-identity");
  assertExecutionSummary(duplicateReport, 1, 2);

  const update = await runDock(
    dock,
    ["baseline", "update", "--config", "duplicate.config.mts", "--json"],
    consumer,
  );
  assert.equal(update.code, 1, update.stderr);
  assert.equal(parseEnvelope(update.stdout).variant, "rejected");
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
}

async function verifyConflictPreflight(
  dock: string,
  consumer: string,
  baselinePath: string,
): Promise<void> {
  const marker = join(consumer, "maintenance-root", "conflict-started.marker");
  const baselineBytes = await readFile(baselinePath);
  const check = await runDock(
    dock,
    ["check", "--config", "conflict.config.mts", "--json"],
    consumer,
  );
  assert.equal(check.code, 1, check.stderr);
  const checkEnvelope = parseEnvelope(check.stdout);
  assert.equal(checkEnvelope.variant, "errors");
  const report = requireReport(checkEnvelope);
  assertBindingError(report, "冲突首项", "run-lifecycle-failed");
  assertBindingError(report, "冲突次项", "run-lifecycle-failed");
  assertExecutionSummary(report, 0, 0);
  await assert.rejects(access(marker), { code: "ENOENT" });

  const update = await runDock(
    dock,
    ["baseline", "update", "--config", "conflict.config.mts", "--json"],
    consumer,
  );
  assert.equal(update.code, 1, update.stderr);
  assert.equal(parseEnvelope(update.stdout).variant, "rejected");
  assertExecutionSummary(requireReport(parseEnvelope(update.stdout)), 0, 0);
  await assert.rejects(access(marker), { code: "ENOENT" });
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
}

async function verifyLifecycleFailures(
  dock: string,
  consumer: string,
  baselinePath: string,
  version: (typeof versions)[number],
): Promise<void> {
  const baselineBytes = await readFile(baselinePath);
  for (const [config, bindingId, testExecutions, failedCommands] of [
    ["close-failure.config.mts", "收尾状态", 1, version === "5.0.3" ? 1 : 0],
    ["unhandled.config.mts", "未处理错误", 1, 1],
    ["interrupted.config.mts", "中断状态", 0, 1],
    ["abnormal-exit.config.mts", "异常退出状态", 0, 1],
  ] as const) {
    if (config === "interrupted.config.mts") {
      await rm(
        join(consumer, "maintenance-root", "interrupted-started.marker"),
        { force: true },
      );
    }
    const check = await runDock(
      dock,
      ["check", "--config", config, "--json"],
      consumer,
    );
    assert.equal(check.code, 1, `${config}\n${check.stdout}\n${check.stderr}`);
    const envelope = parseEnvelope(check.stdout);
    assert.equal(
      envelope.variant,
      "errors",
      `${config}\n${check.stdout}\n${check.stderr}`,
    );
    const report = requireReport(envelope);
    assertBindingError(report, bindingId, "run-lifecycle-failed");
    assertExecutionSummary(report, 1, testExecutions, failedCommands);
    if (config === "interrupted.config.mts") {
      assert.equal(
        await readFile(
          join(consumer, "maintenance-root", "interrupted-started.marker"),
          "utf8",
        ),
        "started\n",
      );
    }

    const update = await runDock(
      dock,
      ["baseline", "update", "--config", config, "--json"],
      consumer,
    );
    assert.equal(
      update.code,
      1,
      `${config}\n${update.stdout}\n${update.stderr}`,
    );
    const updateEnvelope = parseEnvelope(update.stdout);
    assert.equal(updateEnvelope.variant, "rejected");
    const updateReport = requireReport(updateEnvelope);
    assertBindingError(updateReport, bindingId, "run-lifecycle-failed");
    assertExecutionSummary(updateReport, 1, testExecutions, failedCommands);
    assert.deepEqual(await readFile(baselinePath), baselineBytes);
  }
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
    `连续 check/update/check 没有各自取得当前 Vitest 运行：\n${result.stdout}\n${result.stderr}`,
  );
}

async function verifyOrdinaryVitest(consumer: string): Promise<void> {
  const testRoot = join(consumer, "test-workspace");
  const cli = join(consumer, "node_modules", "vitest", "vitest.mjs");
  const passing = await run(
    process.execPath,
    [
      cli,
      "run",
      "--root",
      testRoot,
      "--config",
      join(testRoot, "vitest.config.mjs"),
      "test/ordinary.test.mts",
    ],
    consumer,
  );
  assert.equal(
    passing.code,
    0,
    `普通 Vitest CLI 的通过语义发生变化：\n${passing.stdout}\n${passing.stderr}`,
  );

  const failing = await run(
    process.execPath,
    [
      cli,
      "run",
      "--root",
      testRoot,
      "--config",
      join(testRoot, "vitest.config.mjs"),
      "test/extra-failure.test.mts",
    ],
    consumer,
  );
  assert.equal(
    failing.code,
    1,
    `普通 Vitest CLI 的失败语义发生变化：\n${failing.stdout}\n${failing.stderr}`,
  );
}

async function verifyNoNodeDependency(consumer: string): Promise<void> {
  const listing = await run(
    "npm",
    ["ls", "--all", "--json", "--prefix", consumer],
    consumer,
  );
  assert.equal(listing.code, 0, listing.stderr);
  const names = new Set<string>();
  collectPackageNames(JSON.parse(listing.stdout) as unknown, names);
  assert.equal(
    names.has("@dock/reference-node-test"),
    false,
    "Vitest 引用包不依赖 Node 测试适配包。",
  );
}

async function runDock(
  dock: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<ProcessResult> {
  return await run(dock, arguments_, cwd);
}

function run(
  command: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<ProcessResult> {
  return new Promise((resolveResult, rejectResult) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...arguments_], {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      rejectResult(error);
      return;
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      if (process.platform !== "win32" && child.pid !== undefined) {
        process.kill(-child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
    }, 60_000);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectResult(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ code, signal, stdout, stderr, timedOut });
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
  failedCommands = 0,
): void {
  assert.deepEqual(report.execution, {
    commandAttempts,
    failedCommands,
    testExecutions,
  });
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

function assertBindingHasSomeError(
  report: MaintenanceReport,
  bindingId: string,
): void {
  const binding = report.bindings.find((item) => item.bindingId === bindingId);
  assert.ok(binding, `缺少关联 ${bindingId}`);
  assert.ok(binding.errors !== undefined, `关联 ${bindingId} 没有报告错误`);
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  const packageValue = value as {
    readonly dependencies?: unknown;
  };
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
    `Vitest 安装验收失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
