import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  cp,
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ResolvedMaintenance } from "@ykdz/dock";

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
    readonly code?: string;
    readonly report?: unknown;
    readonly resolution?: ResolvedMaintenance;
  };
};

type ReadDiagnostic = {
  readonly runId: string;
  readonly testId: string;
  readonly attempt: number;
  readonly referenceId: string;
  readonly value: unknown;
  readonly range?: {
    readonly path: string;
    readonly start: number;
    readonly end: number;
  };
};

type MaintenanceReport = {
  readonly scope?: readonly string[];
  readonly execution?: {
    readonly commandAttempts: number;
    readonly failedCommands: number;
    readonly testExecutions: number;
    readonly reads?: readonly {
      readonly runId: string;
      readonly testId: string;
      readonly attempt: number;
      readonly referenceId: string;
      readonly value: unknown;
      readonly range?: {
        readonly path: string;
        readonly start: number;
        readonly end: number;
      };
    }[];
  };
  readonly bindings: readonly {
    readonly bindingId: string;
    readonly current?: {
      readonly references: Readonly<
        Record<string, { readonly value: unknown }>
      >;
    };
    readonly errors?: readonly { readonly code: string }[];
    readonly changes?: readonly {
      readonly kind: string;
      readonly referenceId: string;
      readonly memberChanges?: readonly {
        readonly memberId: string;
        readonly beforePresent: boolean;
        readonly afterPresent: boolean;
        readonly before?: unknown;
        readonly after?: unknown;
      }[];
    }[];
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
    5,
    "根 check:install 必须传入同批 core、host、Vitest、Node test 与 file 制品。",
  );
  const tarballs = artifacts.map((artifact) =>
    resolve(process.cwd(), artifact),
  );
  await Promise.all(tarballs.map((artifact) => access(artifact)));

  const [coreTarball, hostTarball, vitestTarball, nodeTarball, fileTarball] =
    tarballs;
  assert.ok(
    coreTarball && hostTarball && vitestTarball && nodeTarball && fileTarball,
  );
  const vitestTarballs = [coreTarball, hostTarball, vitestTarball];
  for (const version of versions) {
    await verifyVersion(version, vitestTarballs, [
      coreTarball,
      hostTarball,
      vitestTarball,
      fileTarball,
    ]);
  }
  await test("Node 与 Vitest：跨框架身份冲突", async () => {
    await verifyCrossFrameworkIdentityConflict([
      coreTarball,
      hostTarball,
      vitestTarball,
      nodeTarball,
      fileTarball,
    ]);
  });
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
        "--prefer-offline",
        ...tarballs,
        "vitest@4.1.11",
      ],
      consumer,
      360_000,
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
      [
        "check",
        "--config",
        "cross-framework.config.mts",
        "--binding",
        "Node 运行",
        "--json",
      ],
      consumer,
    );
    assert.equal(result.code, 1, result.stderr);
    assert.equal(
      parseEnvelope(result.stderr).data?.code,
      "execution-identity-conflict",
    );
    await assert.rejects(access(marker), { code: "ENOENT" });

    const update = await runDock(
      dock,
      [
        "baseline",
        "update",
        "--config",
        "cross-framework.config.mts",
        "--binding",
        "Node 运行",
        "--json",
      ],
      consumer,
    );
    assert.equal(update.code, 1, update.stderr);
    assert.equal(
      parseEnvelope(update.stderr).data?.code,
      "execution-identity-conflict",
    );
    await assert.rejects(access(marker), { code: "ENOENT" });
    await assert.rejects(access(join(maintenanceRoot, "dock.baseline.json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function verifyVersion(
  version: (typeof versions)[number],
  tarballs: readonly string[],
  readTarballs: readonly string[],
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
        "--prefer-offline",
        ...tarballs,
        `vitest@${version}`,
      ],
      consumer,
      360_000,
    );
    assert.equal(
      installation.code,
      0,
      `Vitest ${version} 正式制品干净安装失败（signal=${installation.signal}, timedOut=${installation.timedOut}）：\n${installation.stdout}\n${installation.stderr}`,
    );

    await installReadConsumer(consumer, readTarballs, version);
    const scenarios: readonly [
      string,
      (dock: string, consumer: string) => Promise<void>,
    ][] = [
      [
        "公开类型与读取类型",
        async (_dock, consumer) => {
          await verifyInstalledTypes(consumer, version);
          await verifyReadTypes(consumer, version);
        },
      ],
      ["无效输入", (_dock, consumer) => verifyRuntimeInputs(consumer)],
      ["用户配置与声明查看", verifyUserConfig],
      [
        "基线往返",
        (dock, consumer) =>
          verifyHappyRoundTrip(
            dock,
            consumer,
            join(consumer, "maintenance-root", "happy.baseline.json"),
          ),
      ],
      [
        "观察与读取",
        (dock, consumer) =>
          verifyObservationAndReadRoundTrip(dock, consumer, version),
      ],
      ["测试组", verifyGroups],
      ["测试组失败", verifySuiteFailure],
      ["附加测试", verifyAdditionalTests],
      [
        "状态失败",
        (dock, consumer) =>
          verifyStatusFailures(
            dock,
            consumer,
            join(consumer, "maintenance-root", "happy.baseline.json"),
          ),
      ],
      [
        "名称筛选与身份",
        (dock, consumer) =>
          verifyFilterAndIdentity(
            dock,
            consumer,
            join(consumer, "maintenance-root", "happy.baseline.json"),
          ),
      ],
      ["范围筛选", verifyInstalledScope],
      [
        "冲突预检",
        (dock, consumer) =>
          verifyConflictPreflight(
            dock,
            consumer,
            join(consumer, "maintenance-root", "happy.baseline.json"),
          ),
      ],
      [
        "运行中断与关闭失败",
        (dock, consumer) =>
          verifyLifecycleFailures(
            dock,
            consumer,
            join(consumer, "maintenance-root", "happy.baseline.json"),
            version,
          ),
      ],
      [
        "操作内执行共享",
        (_dock, consumer) => verifyOperationLocalExecution(consumer),
      ],
      ["普通原生测试", (_dock, consumer) => verifyOrdinaryVitest(consumer)],
      ["依赖边界", (_dock, consumer) => verifyNoNodeDependency(consumer)],
    ];
    for (const [index, [name, verify]] of scenarios.entries()) {
      await test(`Vitest ${version}：${name}`, async () => {
        const scenario = join(temporary, `scenario-${index}`);
        await cp(fixtureDirectory, scenario, { recursive: true });
        await symlink(
          join(consumer, "node_modules"),
          join(scenario, "node_modules"),
          "dir",
        );
        await symlink(
          join(consumer, "test-workspace", "node_modules"),
          join(scenario, "test-workspace", "node_modules"),
          "dir",
        );
        try {
          const maintenanceRoot = join(scenario, "maintenance-root");
          await mkdir(maintenanceRoot, { recursive: true });
          await writeFile(join(maintenanceRoot, "business.data"), "ready\n");
          const dock = join(
            scenario,
            "node_modules",
            ".bin",
            process.platform === "win32" ? "dock.cmd" : "dock",
          );
          await verify(dock, scenario);
        } finally {
          await rm(scenario, { recursive: true, force: true });
        }
      });
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function verifyUserConfig(dock: string, consumer: string): Promise<void> {
  const arguments_ = [
    "--config",
    "user-config.config.mts",
    "--binding",
    "用户配置状态",
  ];
  const viewed = await runDock(
    dock,
    ["inspect", ...arguments_, "--json"],
    consumer,
  );
  assert.equal(viewed.code, 0, viewed.stderr);
  const resolution = parseEnvelope(viewed.stdout).data?.resolution;
  assert.ok(resolution);
  assert.deepEqual(
    resolution.runs.map((run) => ({
      identity: run.identity,
      references: run.references,
      selectedReferences: run.selectedReferences,
    })),
    [
      {
        identity: "用户配置运行",
        references: ["配置通过", "范围外测试"],
        selectedReferences: ["配置通过"],
      },
    ],
  );
  const host = await run(
    process.execPath,
    [join(consumer, "user-config-runtime.mts")],
    consumer,
    60_000,
  );
  assert.equal(host.code, 0, host.stderr);
  assert.deepEqual(JSON.parse(host.stdout), resolution);
  const text = await runDock(dock, ["inspect", ...arguments_], consumer);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /运行声明 用户配置运行/);
  assert.match(text.stdout, /本次选中 配置通过/);
  const maintenanceRoot = join(consumer, "maintenance-root");
  await assert.rejects(access(join(maintenanceRoot, "config-evaluated.log")), {
    code: "ENOENT",
  });
  const checked = await runDock(
    dock,
    ["check", ...arguments_, "--json"],
    consumer,
  );
  assert.equal(checked.code, 1, checked.stderr);
  const report = requireReport(parseEnvelope(checked.stdout));
  assertBindingHasNoErrors(report, "用户配置状态");
  assertExecutionSummary(report, 1, 1);
  assert.match(
    await readFile(join(maintenanceRoot, "config-evaluated.log"), "utf8"),
    /serve\/test/,
  );
  assert.equal(
    await readFile(join(maintenanceRoot, "user-reporter.log"), "utf8"),
    "ended\n",
  );
}

async function verifyInstalledScope(
  dock: string,
  consumer: string,
): Promise<void> {
  const config = "scope.config.mts";
  const oldFile = "../test-workspace/test/scope-old.test.mts";
  const newFile = "../test-workspace/test/scope-new.test.mts";
  const oldTarget = "test/scope-old.test.mts";
  const newTarget = "test/scope-new.test.mts";
  const arguments_ = ["--config", config, "--json"];

  const initial = await runDock(
    dock,
    ["baseline", "update", ...arguments_],
    consumer,
    { DOCK_VITEST_SCOPE_TARGET: oldTarget },
  );
  assert.equal(initial.code, 0, initial.stderr);
  assert.equal(parseEnvelope(initial.stdout).variant, "updated");

  const historical = await runDock(
    dock,
    ["check", "--config", config, "--file", oldFile, "--json"],
    consumer,
    { DOCK_VITEST_SCOPE_TARGET: newTarget },
  );
  assert.equal(historical.code, 1, historical.stderr);
  assert.equal(parseEnvelope(historical.stdout).variant, "changed");
  assertScopeDefinitionChange(historical.stdout, "scope-vitest-reference");

  const current = await runDock(
    dock,
    ["check", "--config", config, "--file", newFile, "--json"],
    consumer,
    { DOCK_VITEST_SCOPE_TARGET: newTarget },
  );
  assert.equal(current.code, 1, current.stderr);
  assert.equal(parseEnvelope(current.stdout).variant, "changed");
  assertScopeDefinitionChange(current.stdout, "scope-vitest-reference");

  const localUpdate = await runDock(
    dock,
    ["baseline", "update", "--config", config, "--file", oldFile, "--json"],
    consumer,
    { DOCK_VITEST_SCOPE_TARGET: newTarget },
  );
  assert.equal(localUpdate.code, 0, localUpdate.stderr);
  assert.deepEqual(requireReport(parseEnvelope(localUpdate.stdout)).scope, [
    "scope-vitest-policy",
  ]);

  const consistent = await runDock(
    dock,
    ["check", "--config", config, "--file", newFile, "--json"],
    consumer,
    { DOCK_VITEST_SCOPE_TARGET: newTarget },
  );
  assert.equal(consistent.code, 0, consistent.stderr);
  assert.equal(parseEnvelope(consistent.stdout).variant, "consistent");
  assert.deepEqual(requireReport(parseEnvelope(consistent.stdout)).scope, [
    "scope-vitest-policy",
  ]);
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

async function installReadConsumer(
  consumer: string,
  tarballs: readonly string[],
  version: string,
): Promise<void> {
  const testRoot = join(consumer, "test-workspace");
  const installation = await run(
    "npm",
    [
      "install",
      "--prefix",
      testRoot,
      "--no-save",
      "--no-package-lock",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      ...tarballs,
      `vitest@${version}`,
    ],
    testRoot,
    360_000,
  );
  assert.equal(
    installation.code,
    0,
    `Vitest ${version} 的读取消费安装失败（signal=${installation.signal}, timedOut=${installation.timedOut}）：\n${installation.stdout}\n${installation.stderr}`,
  );
}

async function verifyReadTypes(
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
    ["-p", join(consumer, "tsconfig.read.json"), "--pretty", "false"],
    consumer,
  );
  assert.equal(
    result.code,
    0,
    `Vitest ${version} 安装声明的读取正负例未通过：\n${result.stdout}\n${result.stderr}`,
  );
}

async function verifyObservationAndReadRoundTrip(
  dock: string,
  consumer: string,
  version: (typeof versions)[number],
): Promise<void> {
  const testRoot = join(consumer, "test-workspace");
  const maintenanceRoot = join(consumer, "maintenance-root");
  const outerVitest = await realpath(
    join(consumer, "node_modules", "@ykdz", "dock-reference-vitest"),
  );
  const testVitest = await realpath(
    join(testRoot, "node_modules", "@ykdz", "dock-reference-vitest"),
  );
  assert.notEqual(
    outerVitest,
    testVitest,
    "测试工作区必须从另一份真实物理安装导入 Vitest helper。",
  );
  const installedPackage = JSON.parse(
    await readFile(
      join(
        testRoot,
        "node_modules",
        "@ykdz",
        "dock-reference-vitest",
        "package.json",
      ),
      "utf8",
    ),
  ) as { readonly version: string };
  const sourcePackage = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { readonly version: string };
  assert.equal(installedPackage.version, sourcePackage.version);

  await writeFile(join(maintenanceRoot, "read-target.txt"), "value: ready\n");
  const multiFileBaseline = join(maintenanceRoot, "attempts.baseline.json");
  await rm(multiFileBaseline, { force: true });
  const multiFile = await runDock(
    dock,
    ["check", "--config", "attempts.config.mts", "--json"],
    consumer,
  );
  assert.equal(
    multiFile.code,
    1,
    `Vitest ${version} 多文件观察核对失败：\n${multiFile.stdout}\n${multiFile.stderr}`,
  );
  const multiFileEnvelope = parseEnvelope(multiFile.stdout);
  assert.equal(multiFileEnvelope.variant, "changed", multiFile.stdout);
  const multiFileReport = requireReport(multiFileEnvelope);
  assertBindingHasNoErrors(multiFileReport, "多文件观察记录");
  assertExecutionSummary(multiFileReport, 1, 2);

  const multiFileUpdate = await runDock(
    dock,
    ["baseline", "update", "--config", "attempts.config.mts", "--json"],
    consumer,
  );
  assert.equal(multiFileUpdate.code, 0, multiFileUpdate.stderr);
  assert.equal(parseEnvelope(multiFileUpdate.stdout).variant, "updated");
  const multiFileCurrent = await runDock(
    dock,
    ["check", "--config", "attempts.config.mts", "--json"],
    consumer,
  );
  assert.equal(multiFileCurrent.code, 0, multiFileCurrent.stderr);
  assert.equal(parseEnvelope(multiFileCurrent.stdout).variant, "consistent");

  const baselinePath = join(maintenanceRoot, "read-observation.baseline.json");
  await rm(baselinePath, { force: true });
  const firstCheck = await runDock(
    dock,
    ["check", "--config", "read-observation.config.mts", "--json"],
    consumer,
  );
  assert.equal(firstCheck.code, 1, firstCheck.stderr);
  const firstEnvelope = parseEnvelope(firstCheck.stdout);
  assert.equal(firstEnvelope.variant, "changed", firstCheck.stdout);
  const firstReport = requireReport(firstEnvelope);
  assertBindingHasNoErrors(firstReport, "业务文本");
  assertExecutionSummary(firstReport, 1, 1);
  assertReadDiagnostics(firstReport, [
    {
      runId: "文件读取业务观察",
      testId: JSON.stringify([
        "test/read-observation.test.mts",
        "业务文本观察",
      ]),
      attempt: 1,
      referenceId: "business-text-source",
      value: "ready",
      range: { path: "read-target.txt", start: 7, end: 12 },
    },
  ]);

  const update = await runDock(
    dock,
    ["baseline", "update", "--config", "read-observation.config.mts", "--json"],
    consumer,
  );
  assert.equal(update.code, 0, update.stderr);
  assert.equal(parseEnvelope(update.stdout).variant, "updated");
  const baselineBytes = await readFile(baselinePath);
  const consistent = await runDock(
    dock,
    ["check", "--config", "read-observation.config.mts", "--json"],
    consumer,
  );
  assert.equal(consistent.code, 0, consistent.stderr);
  assert.equal(parseEnvelope(consistent.stdout).variant, "consistent");
  assert.deepEqual(await readFile(baselinePath), baselineBytes);

  await writeFile(
    join(maintenanceRoot, "read-target.txt"),
    "moved: prefix\nvalue: changed\n",
  );
  const changed = await runDock(
    dock,
    ["check", "--config", "read-observation.config.mts", "--json"],
    consumer,
  );
  assert.equal(changed.code, 1, changed.stderr);
  const changedEnvelope = parseEnvelope(changed.stdout);
  assert.equal(changedEnvelope.variant, "changed", changed.stdout);
  const changedReport = requireReport(changedEnvelope);
  assertBindingHasNoErrors(changedReport, "业务文本");
  assertReadDiagnostics(changedReport, [
    {
      runId: "文件读取业务观察",
      testId: JSON.stringify([
        "test/read-observation.test.mts",
        "业务文本观察",
      ]),
      attempt: 1,
      referenceId: "business-text-source",
      value: "changed",
      range: { path: "read-target.txt", start: 21, end: 28 },
    },
  ]);

  const changedUpdate = await runDock(
    dock,
    ["baseline", "update", "--config", "read-observation.config.mts", "--json"],
    consumer,
  );
  assert.equal(changedUpdate.code, 0, changedUpdate.stderr);
  assert.equal(parseEnvelope(changedUpdate.stdout).variant, "updated");
  const changedCurrent = await runDock(
    dock,
    ["check", "--config", "read-observation.config.mts", "--json"],
    consumer,
  );
  assert.equal(changedCurrent.code, 0, changedCurrent.stderr);
  assert.equal(parseEnvelope(changedCurrent.stdout).variant, "consistent");

  await writeFile(
    join(maintenanceRoot, "read-target.txt"),
    "value: first\nvalue: second\n",
  );
  const ambiguousRead = await runDock(
    dock,
    ["check", "--config", "ambiguous-read.config.mts", "--json"],
    consumer,
  );
  assert.equal(ambiguousRead.code, 1, ambiguousRead.stderr);
  const ambiguousReadEnvelope = parseEnvelope(ambiguousRead.stdout);
  assert.equal(ambiguousReadEnvelope.variant, "changed", ambiguousRead.stdout);
  const ambiguousReadReport = requireReport(ambiguousReadEnvelope);
  assertBindingHasNoErrors(ambiguousReadReport, "读取选择歧义");
  assertReadDiagnostics(ambiguousReadReport, []);
  assert.equal(
    ambiguousReadReport.bindings.find(
      (binding) => binding.bindingId === "读取选择歧义",
    )?.current?.references["读取错误结果"]?.value,
    "ambiguous-selection",
    ambiguousRead.stdout,
  );
  await writeFile(
    join(maintenanceRoot, "read-target.txt"),
    "moved: prefix\nvalue: changed\n",
  );

  const missingBaseline = join(
    maintenanceRoot,
    "missing-observation.baseline.json",
  );
  const missing = await runDock(
    dock,
    ["check", "--config", "missing-observation.config.mts", "--json"],
    consumer,
  );
  assert.equal(missing.code, 1, missing.stderr);
  const missingEnvelope = parseEnvelope(missing.stdout);
  assert.equal(missingEnvelope.variant, "errors", missing.stdout);
  const missingReport = requireReport(missingEnvelope);
  assertBindingError(missingReport, "最终尝试观察", "observation-missing");
  assertExecutionSummary(missingReport, 1, 2);
  const retryTestId = JSON.stringify([
    "test/missing-final-observation.test.mts",
    "最终成功缺少观察",
  ]);
  const retryRead = {
    runId: "最终尝试观察",
    testId: retryTestId,
    referenceId: "retry-source",
    value: "moved: prefix\nvalue: changed\n",
    range: {
      path: "read-target.txt",
      start: 0,
      end: "moved: prefix\nvalue: changed\n".length,
    },
  };
  assertReadDiagnostics(missingReport, [
    { ...retryRead, attempt: 1 },
    { ...retryRead, attempt: 2 },
  ]);

  await rm(missingBaseline, { force: true });
  const missingUpdate = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "missing-observation.config.mts",
      "--json",
    ],
    consumer,
  );
  assert.equal(missingUpdate.code, 1, missingUpdate.stderr);
  assert.equal(parseEnvelope(missingUpdate.stdout).variant, "rejected");
  assertBindingError(
    requireReport(parseEnvelope(missingUpdate.stdout)),
    "最终尝试观察",
    "observation-missing",
  );
  await assert.rejects(access(missingBaseline), { code: "ENOENT" });

  const finalFailureBaseline = join(
    maintenanceRoot,
    "final-failure.baseline.json",
  );
  await rm(finalFailureBaseline, { force: true });
  const finalFailure = await runDock(
    dock,
    ["check", "--config", "final-failure.config.mts", "--json"],
    consumer,
  );
  assert.equal(finalFailure.code, 1, finalFailure.stderr);
  const finalFailureEnvelope = parseEnvelope(finalFailure.stdout);
  assert.equal(finalFailureEnvelope.variant, "errors", finalFailure.stdout);
  const finalFailureReport = requireReport(finalFailureEnvelope);
  assertBindingError(finalFailureReport, "最终失败观察", "test-failed");
  assertExecutionSummary(finalFailureReport, 1, 2, 1);
  const finalFailureUpdate = await runDock(
    dock,
    ["baseline", "update", "--config", "final-failure.config.mts", "--json"],
    consumer,
  );
  assert.equal(finalFailureUpdate.code, 1, finalFailureUpdate.stderr);
  assert.equal(parseEnvelope(finalFailureUpdate.stdout).variant, "rejected");
  assertBindingError(
    requireReport(parseEnvelope(finalFailureUpdate.stdout)),
    "最终失败观察",
    "test-failed",
  );
  await assert.rejects(access(finalFailureBaseline), { code: "ENOENT" });

  const duplicate = await runDock(
    dock,
    ["check", "--config", "duplicate-observation.config.mts", "--json"],
    consumer,
  );
  assert.equal(duplicate.code, 1, duplicate.stderr);
  const duplicateEnvelope = parseEnvelope(duplicate.stdout);
  assert.equal(duplicateEnvelope.variant, "errors");
  assertBindingError(
    requireReport(duplicateEnvelope),
    "重复观察",
    "observation-duplicate",
  );
  const duplicateBaseline = join(
    maintenanceRoot,
    "duplicate-observation.baseline.json",
  );
  await rm(duplicateBaseline, { force: true });
  const duplicateUpdate = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "duplicate-observation.config.mts",
      "--json",
    ],
    consumer,
  );
  assert.equal(duplicateUpdate.code, 1, duplicateUpdate.stderr);
  assert.equal(parseEnvelope(duplicateUpdate.stdout).variant, "rejected");
  await assert.rejects(access(duplicateBaseline), { code: "ENOENT" });

  const text = await runDock(
    dock,
    ["check", "--config", "read-observation.config.mts"],
    consumer,
  );
  assert.equal(text.code, 0, `${text.stdout}\n${text.stderr}`);
  for (const fragment of [
    "测试内读取 business-text-source",
    "运行 文件读取业务观察",
    "业务文本观察",
    "尝试 1",
    '"changed"',
    "范围 read-target.txt:21-28",
  ]) {
    assert.ok(
      text.stdout.includes(fragment),
      `文本报告缺少 ${fragment}：\n${text.stdout}`,
    );
  }
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

async function verifyGroups(dock: string, consumer: string): Promise<void> {
  const maintenanceRoot = join(consumer, "maintenance-root");
  const baselinePath = join(maintenanceRoot, "groups.baseline.json");
  const primaryMemberId = JSON.stringify([
    "test/groups.test.mts",
    "preview config",
    "inner > label",
    "primary",
  ]);
  const renamedMemberId = JSON.stringify([
    "test/groups.test.mts",
    "preview config",
    "inner > label",
    "primary renamed",
  ]);
  const sameNamedNestedMemberId = JSON.stringify([
    "test/groups.test.mts",
    "preview config",
    "other nested",
    "primary",
  ]);
  const variant = { DOCK_VITEST_GROUP_VARIANT: "baseline" };
  await rm(baselinePath, { force: true });

  const initial = await runDock(
    dock,
    ["baseline", "update", "--config", "groups.config.mts", "--json"],
    consumer,
    variant,
  );
  assert.equal(initial.code, 0, `${initial.stdout}\n${initial.stderr}`);
  assert.equal(parseEnvelope(initial.stdout).variant, "updated");
  const initialReport = requireReport(parseEnvelope(initial.stdout));
  assertBindingHasNoErrors(initialReport, "预览组");
  assertBindingHasNoErrors(initialReport, "空组");
  assertBindingHasNoErrors(initialReport, "全部预览成员");
  const allPreviewMembers = initialReport.bindings.find(
    (binding) => binding.bindingId === "全部预览成员",
  )?.current?.references["all-preview-members"]?.value;
  assert.ok(Array.isArray(allPreviewMembers));
  const allPreviewMemberIds = new Set(
    allPreviewMembers.map((member) => {
      assert.ok(
        typeof member === "object" &&
          member !== null &&
          "id" in member &&
          typeof member.id === "string",
      );
      return member.id;
    }),
  );
  assert.equal(allPreviewMemberIds.has(primaryMemberId), true);
  assert.equal(allPreviewMemberIds.has(sameNamedNestedMemberId), true);
  assert.notEqual(primaryMemberId, sameNamedNestedMemberId);
  assert.equal(allPreviewMemberIds.size, 4);
  assertExecutionSummary(initialReport, 1, 4);
  let baselineBytes = await readFile(baselinePath);

  const stable = await runDock(
    dock,
    ["check", "--config", "groups.config.mts", "--json"],
    consumer,
    variant,
  );
  assert.equal(stable.code, 0, `${stable.stdout}\n${stable.stderr}`);
  assert.equal(parseEnvelope(stable.stdout).variant, "consistent");
  assertExecutionSummary(requireReport(parseEnvelope(stable.stdout)), 1, 4);

  const changed = await runDock(
    dock,
    ["check", "--config", "groups.config.mts", "--json"],
    consumer,
    { DOCK_VITEST_GROUP_VARIANT: "changed" },
  );
  assert.equal(changed.code, 1, `${changed.stdout}\n${changed.stderr}`);
  assert.equal(parseEnvelope(changed.stdout).variant, "changed");
  const changedReport = requireReport(parseEnvelope(changed.stdout));
  assertBindingHasNoErrors(changedReport, "预览组");
  assertExecutionSummary(changedReport, 1, 4);
  const changedFact = changedReport.bindings
    .find((binding) => binding.bindingId === "预览组")
    ?.changes?.find(
      (change) =>
        change.kind === "fact" && change.referenceId === "preview-members",
    );
  assert.ok(changedFact);
  const changedPrimary = changedFact.memberChanges?.find(
    (change) => change.memberId === primaryMemberId,
  );
  assert.ok(changedPrimary);
  assert.equal(changedPrimary.beforePresent, true);
  assert.equal(changedPrimary.afterPresent, true);
  assert.notDeepEqual(changedPrimary.before, changedPrimary.after);

  const changedUpdate = await runDock(
    dock,
    ["baseline", "update", "--config", "groups.config.mts", "--json"],
    consumer,
    { DOCK_VITEST_GROUP_VARIANT: "changed" },
  );
  assert.equal(changedUpdate.code, 0, changedUpdate.stderr);
  assert.equal(parseEnvelope(changedUpdate.stdout).variant, "updated");
  assertExecutionSummary(
    requireReport(parseEnvelope(changedUpdate.stdout)),
    1,
    4,
  );
  baselineBytes = await readFile(baselinePath);

  const renamed = await runDock(
    dock,
    ["check", "--config", "groups.config.mts", "--json"],
    consumer,
    { DOCK_VITEST_GROUP_VARIANT: "renamed" },
  );
  assert.equal(renamed.code, 1, `${renamed.stdout}\n${renamed.stderr}`);
  assert.equal(parseEnvelope(renamed.stdout).variant, "changed");
  const renamedReport = requireReport(parseEnvelope(renamed.stdout));
  assertBindingHasNoErrors(renamedReport, "预览组");
  assertExecutionSummary(renamedReport, 1, 4);
  const renamedFact = renamedReport.bindings
    .find((binding) => binding.bindingId === "预览组")
    ?.changes?.find(
      (change) =>
        change.kind === "fact" && change.referenceId === "preview-members",
    );
  assert.ok(renamedFact);
  const renamedMemberChanges = renamedFact.memberChanges ?? [];
  const removedMember = renamedMemberChanges.find(
    (change) => change.memberId === primaryMemberId,
  );
  assert.ok(removedMember);
  assert.equal(removedMember.beforePresent, true);
  assert.equal(removedMember.afterPresent, false);
  assert.equal("before" in removedMember, true);
  assert.equal("after" in removedMember, false);
  const addedMember = renamedMemberChanges.find(
    (change) => change.memberId === renamedMemberId,
  );
  assert.ok(addedMember);
  assert.equal(addedMember.beforePresent, false);
  assert.equal(addedMember.afterPresent, true);
  assert.equal("before" in addedMember, false);
  assert.equal("after" in addedMember, true);
  assert.deepEqual(await readFile(baselinePath), baselineBytes);

  const renamedUpdate = await runDock(
    dock,
    ["baseline", "update", "--config", "groups.config.mts", "--json"],
    consumer,
    { DOCK_VITEST_GROUP_VARIANT: "renamed" },
  );
  assert.equal(renamedUpdate.code, 0, renamedUpdate.stderr);
  assert.equal(parseEnvelope(renamedUpdate.stdout).variant, "updated");
  const renamedCheck = await runDock(
    dock,
    ["check", "--config", "groups.config.mts", "--json"],
    consumer,
    { DOCK_VITEST_GROUP_VARIANT: "renamed" },
  );
  assert.equal(
    renamedCheck.code,
    0,
    `${renamedCheck.stdout}\n${renamedCheck.stderr}`,
  );
  assert.equal(parseEnvelope(renamedCheck.stdout).variant, "consistent");
  assertExecutionSummary(
    requireReport(parseEnvelope(renamedCheck.stdout)),
    1,
    4,
  );

  const sharedBaseline = join(maintenanceRoot, "groups-shared.baseline.json");
  const groupMarker = join(maintenanceRoot, "groups-extra.marker");
  await rm(sharedBaseline, { force: true });
  await rm(groupMarker, { force: true });
  const sharedUpdate = await runDock(
    dock,
    ["baseline", "update", "--config", "groups-shared.config.mts", "--json"],
    consumer,
    {
      DOCK_VITEST_GROUP_MARKER: groupMarker,
      DOCK_VITEST_GROUP_POISON: "1",
    },
  );
  assert.equal(
    sharedUpdate.code,
    0,
    `${sharedUpdate.stdout}\n${sharedUpdate.stderr}`,
  );
  assert.equal(parseEnvelope(sharedUpdate.stdout).variant, "updated");
  const sharedReport = requireReport(parseEnvelope(sharedUpdate.stdout));
  assertBindingHasNoErrors(sharedReport, "组和单测共享");
  assertExecutionSummary(sharedReport, 1, 2);
  await assert.rejects(access(groupMarker), { code: "ENOENT" });
  await rm(groupMarker, { force: true });
  const sharedCheck = await runDock(
    dock,
    ["check", "--config", "groups-shared.config.mts", "--json"],
    consumer,
    {
      DOCK_VITEST_GROUP_MARKER: groupMarker,
      DOCK_VITEST_GROUP_POISON: "1",
    },
  );
  assert.equal(
    sharedCheck.code,
    0,
    `${sharedCheck.stdout}\n${sharedCheck.stderr}`,
  );
  assert.equal(parseEnvelope(sharedCheck.stdout).variant, "consistent");
  assertExecutionSummary(
    requireReport(parseEnvelope(sharedCheck.stdout)),
    1,
    2,
  );
  await assert.rejects(access(groupMarker), { code: "ENOENT" });

  const additionalEnvironment = {
    DOCK_VITEST_GROUP_ADDITIONAL: "1",
    DOCK_VITEST_GROUP_MARKER: groupMarker,
  };
  await rm(groupMarker, { force: true });
  const additionalUpdate = await runDock(
    dock,
    ["baseline", "update", "--config", "groups-shared.config.mts", "--json"],
    consumer,
    additionalEnvironment,
  );
  assert.equal(
    additionalUpdate.code,
    0,
    `${additionalUpdate.stdout}\n${additionalUpdate.stderr}`,
  );
  assert.equal(parseEnvelope(additionalUpdate.stdout).variant, "updated");
  assertExecutionSummary(
    requireReport(parseEnvelope(additionalUpdate.stdout)),
    1,
    3,
  );
  await access(groupMarker);
  await rm(groupMarker, { force: true });
  const additionalCheck = await runDock(
    dock,
    ["check", "--config", "groups-shared.config.mts", "--json"],
    consumer,
    additionalEnvironment,
  );
  assert.equal(additionalCheck.code, 0, additionalCheck.stderr);
  assert.equal(parseEnvelope(additionalCheck.stdout).variant, "consistent");
  assertExecutionSummary(
    requireReport(parseEnvelope(additionalCheck.stdout)),
    1,
    3,
  );
  await access(groupMarker);

  const caseBaseline = join(maintenanceRoot, "group-case.baseline.json");
  const caseMarker = join(maintenanceRoot, "case-extra.marker");
  await rm(caseBaseline, { force: true });
  await rm(caseMarker, { force: true });
  const nonprefixPattern = {
    DOCK_VITEST_CASE_PATTERN: "nonprefix",
    DOCK_VITEST_CASE_EXTRA_MARKER: caseMarker,
  };
  const patternUpdate = await runDock(
    dock,
    ["baseline", "update", "--config", "group-case.config.mts", "--json"],
    consumer,
    nonprefixPattern,
  );
  assert.equal(patternUpdate.code, 0, patternUpdate.stderr);
  assert.equal(parseEnvelope(patternUpdate.stdout).variant, "updated");
  assertBindingHasNoErrors(
    requireReport(parseEnvelope(patternUpdate.stdout)),
    "configured pattern",
  );
  assertExecutionSummary(
    requireReport(parseEnvelope(patternUpdate.stdout)),
    1,
    1,
  );
  await assert.rejects(access(caseMarker), { code: "ENOENT" });

  const nonprefixCheck = await runDock(
    dock,
    ["check", "--config", "group-case.config.mts", "--json"],
    consumer,
    nonprefixPattern,
  );
  assert.equal(nonprefixCheck.code, 0, nonprefixCheck.stderr);
  assert.equal(parseEnvelope(nonprefixCheck.stdout).variant, "consistent");
  assertExecutionSummary(
    requireReport(parseEnvelope(nonprefixCheck.stdout)),
    1,
    1,
  );
  await assert.rejects(access(caseMarker), { code: "ENOENT" });

  const flaggedPattern = {
    DOCK_VITEST_CASE_PATTERN: "prefix",
    DOCK_VITEST_CASE_EXTRA_MARKER: caseMarker,
  };
  const flaggedCheck = await runDock(
    dock,
    ["check", "--config", "group-case.config.mts", "--json"],
    consumer,
    flaggedPattern,
  );
  assert.equal(flaggedCheck.code, 0, flaggedCheck.stderr);
  assert.equal(parseEnvelope(flaggedCheck.stdout).variant, "consistent");
  assertExecutionSummary(
    requireReport(parseEnvelope(flaggedCheck.stdout)),
    1,
    1,
  );
  await assert.rejects(access(caseMarker), { code: "ENOENT" });

  const collisionBaseline = join(
    maintenanceRoot,
    "group-collision.baseline.json",
  );
  await rm(collisionBaseline, { force: true });
  const collisionUpdate = await runDock(
    dock,
    ["baseline", "update", "--config", "group-collision.config.mts", "--json"],
    consumer,
  );
  assert.equal(
    collisionUpdate.code,
    0,
    `${collisionUpdate.stdout}\n${collisionUpdate.stderr}`,
  );
  assert.equal(parseEnvelope(collisionUpdate.stdout).variant, "updated");
  const collisionReport = requireReport(parseEnvelope(collisionUpdate.stdout));
  assertBindingHasNoErrors(collisionReport, "路径相同标题组");
  assertExecutionSummary(collisionReport, 1, 2);
  const collisionBinding = collisionReport.bindings.find(
    (binding) => binding.bindingId === "路径相同标题组",
  );
  assert.ok(collisionBinding?.current);
  const flatMemberId = JSON.stringify([
    "test/group-collision.test.mts",
    "outer",
    "nested > child",
    "same",
  ]);
  const nestedMemberId = JSON.stringify([
    "test/group-collision.test.mts",
    "outer",
    "nested",
    "child",
    "same",
  ]);
  const flatMembers = collisionBinding.current.references["flat-path"]?.value;
  const nestedMembers =
    collisionBinding.current.references["nested-path"]?.value;
  assert.ok(Array.isArray(flatMembers));
  assert.ok(Array.isArray(nestedMembers));
  assert.deepEqual(
    flatMembers.map((member) => (member as { id?: unknown }).id),
    [flatMemberId],
  );
  assert.deepEqual(
    nestedMembers.map((member) => (member as { id?: unknown }).id),
    [nestedMemberId],
  );
  assert.notEqual(flatMemberId, nestedMemberId);

  const collisionCheck = await runDock(
    dock,
    ["check", "--config", "group-collision.config.mts", "--json"],
    consumer,
  );
  assert.equal(collisionCheck.code, 0, collisionCheck.stderr);
  assert.equal(parseEnvelope(collisionCheck.stdout).variant, "consistent");
  assertExecutionSummary(
    requireReport(parseEnvelope(collisionCheck.stdout)),
    1,
    2,
  );

  const ambiguousBaseline = join(
    maintenanceRoot,
    "group-collision-single.baseline.json",
  );
  await rm(ambiguousBaseline, { force: true });
  const ambiguousSingle = await runDock(
    dock,
    ["check", "--config", "group-collision-single.config.mts", "--json"],
    consumer,
  );
  assert.equal(ambiguousSingle.code, 1, ambiguousSingle.stderr);
  assert.equal(parseEnvelope(ambiguousSingle.stdout).variant, "errors");
  assertBindingError(
    requireReport(parseEnvelope(ambiguousSingle.stdout)),
    "标题对应多个路径",
    "duplicate-test-identity",
  );
  assertExecutionSummary(
    requireReport(parseEnvelope(ambiguousSingle.stdout)),
    1,
    2,
  );
  const ambiguousUpdate = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "group-collision-single.config.mts",
      "--json",
    ],
    consumer,
  );
  assert.equal(ambiguousUpdate.code, 1, ambiguousUpdate.stderr);
  assert.equal(parseEnvelope(ambiguousUpdate.stdout).variant, "rejected");
  assertBindingError(
    requireReport(parseEnvelope(ambiguousUpdate.stdout)),
    "标题对应多个路径",
    "duplicate-test-identity",
  );
  await assert.rejects(access(ambiguousBaseline), { code: "ENOENT" });

  const failureBytes = await readFile(baselinePath);
  const invalid = await runDock(
    dock,
    ["check", "--config", "group-failures.config.mts", "--json"],
    consumer,
  );
  assert.equal(invalid.code, 1, `${invalid.stdout}\n${invalid.stderr}`);
  const invalidEnvelope = parseEnvelope(invalid.stdout);
  assert.equal(invalidEnvelope.variant, "errors");
  const invalidReport = requireReport(invalidEnvelope);
  assertBindingError(invalidReport, "含错误组与有效单测", "test-skipped");
  assertBindingError(invalidReport, "含错误组与有效单测", "test-todo");
  assertBindingError(
    invalidReport,
    "含错误组与有效单测",
    "observation-missing",
  );
  assertBindingError(
    invalidReport,
    "含错误组与有效单测",
    "observation-duplicate",
  );
  assertExecutionSummary(invalidReport, 1, 3);

  const invalidUpdate = await runDock(
    dock,
    ["baseline", "update", "--config", "group-failures.config.mts", "--json"],
    consumer,
  );
  assert.equal(
    invalidUpdate.code,
    1,
    `${invalidUpdate.stdout}\n${invalidUpdate.stderr}`,
  );
  assert.equal(parseEnvelope(invalidUpdate.stdout).variant, "rejected");
  assertBindingError(
    requireReport(parseEnvelope(invalidUpdate.stdout)),
    "含错误组与有效单测",
    "observation-missing",
  );
  assertBindingError(
    requireReport(parseEnvelope(invalidUpdate.stdout)),
    "含错误组与有效单测",
    "observation-duplicate",
  );
  assert.deepEqual(await readFile(baselinePath), failureBytes);

  const filtered = await runDock(
    dock,
    ["check", "--config", "group-filter.config.mts", "--json"],
    consumer,
  );
  assert.equal(filtered.code, 1, `${filtered.stdout}\n${filtered.stderr}`);
  const filteredReport = requireReport(parseEnvelope(filtered.stdout));
  assertBindingError(filteredReport, "受筛选组", "test-skipped");
  assertExecutionSummary(filteredReport, 1, 1);
  const filteredUpdate = await runDock(
    dock,
    ["baseline", "update", "--config", "group-filter.config.mts", "--json"],
    consumer,
  );
  assert.equal(filteredUpdate.code, 1, filteredUpdate.stderr);
  assert.equal(parseEnvelope(filteredUpdate.stdout).variant, "rejected");
  assert.deepEqual(await readFile(baselinePath), failureBytes);

  const missingSuite = await runDock(
    dock,
    ["check", "--config", "group-missing-suite.config.mts", "--json"],
    consumer,
  );
  assert.equal(missingSuite.code, 1, missingSuite.stderr);
  assertBindingError(
    requireReport(parseEnvelope(missingSuite.stdout)),
    "不存在的组",
    "test-group-not-found",
  );
  const missingSuiteUpdate = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "group-missing-suite.config.mts",
      "--json",
    ],
    consumer,
  );
  assert.equal(missingSuiteUpdate.code, 1, missingSuiteUpdate.stderr);
  assert.equal(parseEnvelope(missingSuiteUpdate.stdout).variant, "rejected");
  assert.deepEqual(await readFile(baselinePath), failureBytes);

  const collectionError = await runDock(
    dock,
    ["check", "--config", "group-collection-error.config.mts", "--json"],
    consumer,
    { DOCK_VITEST_GROUP_SCENARIO: "collection-error" },
  );
  assert.equal(
    collectionError.code,
    1,
    `${collectionError.stdout}\n${collectionError.stderr}`,
  );
  assertBindingError(
    requireReport(parseEnvelope(collectionError.stdout)),
    "收集失败组",
    "run-lifecycle-failed",
  );
  const collectionErrorUpdate = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "group-collection-error.config.mts",
      "--json",
    ],
    consumer,
    { DOCK_VITEST_GROUP_SCENARIO: "collection-error" },
  );
  assert.equal(collectionErrorUpdate.code, 1, collectionErrorUpdate.stderr);
  assert.equal(parseEnvelope(collectionErrorUpdate.stdout).variant, "rejected");
  assert.deepEqual(await readFile(baselinePath), failureBytes);
}

async function verifyStatusFailures(
  dock: string,
  consumer: string,
  baselinePath: string,
): Promise<void> {
  const initial = await runDock(
    dock,
    ["baseline", "update", "--config", "happy.config.mts", "--json"],
    consumer,
  );
  assert.equal(initial.code, 0, initial.stderr);
  assert.equal(parseEnvelope(initial.stdout).variant, "updated");
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
  const initial = await runDock(
    dock,
    ["baseline", "update", "--config", "happy.config.mts", "--json"],
    consumer,
  );
  assert.equal(initial.code, 0, initial.stderr);
  assert.equal(parseEnvelope(initial.stdout).variant, "updated");
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
  const initial = await runDock(
    dock,
    ["baseline", "update", "--config", "happy.config.mts", "--json"],
    consumer,
  );
  assert.equal(initial.code, 0, initial.stderr);
  assert.equal(parseEnvelope(initial.stdout).variant, "updated");
  const baselineBytes = await readFile(baselinePath);
  const check = await runDock(
    dock,
    ["check", "--config", "conflict.config.mts", "--json"],
    consumer,
  );
  assert.equal(check.code, 1, check.stderr);
  assert.equal(
    parseEnvelope(check.stderr).data?.code,
    "plugin-reference-validation-failed",
  );
  await assert.rejects(access(marker), { code: "ENOENT" });

  const update = await runDock(
    dock,
    ["baseline", "update", "--config", "conflict.config.mts", "--json"],
    consumer,
  );
  assert.equal(update.code, 1, update.stderr);
  assert.equal(
    parseEnvelope(update.stderr).data?.code,
    "plugin-reference-validation-failed",
  );
  await assert.rejects(access(marker), { code: "ENOENT" });
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
}

async function verifyLifecycleFailures(
  dock: string,
  consumer: string,
  baselinePath: string,
  version: (typeof versions)[number],
): Promise<void> {
  const initial = await runDock(
    dock,
    ["baseline", "update", "--config", "happy.config.mts", "--json"],
    consumer,
  );
  assert.equal(initial.code, 0, initial.stderr);
  assert.equal(parseEnvelope(initial.stdout).variant, "updated");
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
    names.has("@ykdz/dock-reference-node-test"),
    false,
    "Vitest 引用包不依赖 Node 测试适配包。",
  );
}

async function runDock(
  dock: string,
  arguments_: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<ProcessResult> {
  return await run(dock, arguments_, cwd, 60_000, env);
}

function run(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  timeoutMs = 60_000,
  env: NodeJS.ProcessEnv = {},
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
        env: { ...process.env, ...env },
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
    }, timeoutMs);
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
  assert.deepEqual(
    {
      commandAttempts: report.execution?.commandAttempts,
      failedCommands: report.execution?.failedCommands,
      testExecutions: report.execution?.testExecutions,
    },
    { commandAttempts, failedCommands, testExecutions },
  );
}

function assertReadDiagnostics(
  report: MaintenanceReport,
  expected: readonly ReadDiagnostic[],
): void {
  assert.deepEqual(report.execution?.reads ?? [], expected);
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

function assertScopeDefinitionChange(
  output: string,
  referenceId: string,
): void {
  const report = requireReport(parseEnvelope(output));
  assert.deepEqual(report.scope, ["scope-vitest-policy"]);
  const binding = report.bindings.find(
    (candidate) => candidate.bindingId === "scope-vitest-policy",
  );
  assert.ok(binding, "缺少 Vitest 范围关联");
  assert.ok(
    binding.changes?.some(
      (change) =>
        change.kind === "reference-definition" &&
        change.referenceId === referenceId,
    ),
    `文件改指没有报告引用定义变化：${JSON.stringify(binding.changes)}`,
  );
  assertBindingHasNoErrors(report, "scope-vitest-policy");
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
