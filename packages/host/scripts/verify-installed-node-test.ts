import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  readonly schemaVersion: string;
  readonly outputMode?: string;
  readonly kind: string;
  readonly variant?: string;
  readonly data?: {
    readonly code?: string;
    readonly report?: unknown;
    readonly errors?: readonly {
      readonly bindingId?: string;
      readonly code: string;
      readonly message: string;
    }[];
  };
};

type MaintenanceReport = {
  readonly pluginDiagnostics: readonly {
    readonly pluginId: string;
    readonly data: unknown;
    readonly text: readonly string[];
  }[];
  readonly pluginErrors: readonly {
    readonly pluginId: string;
    readonly code: string;
    readonly message: string;
  }[];
  readonly bindings: readonly {
    readonly bindingId: string;
    readonly errors?: readonly { readonly code: string }[];
    readonly changes?: readonly {
      readonly kind: string;
      readonly referenceId: string;
      readonly before?: unknown;
      readonly after?: unknown;
    }[];
  }[];
};

type NodeRunDiagnostic = {
  readonly identity: string;
  readonly configuration: {
    readonly framework: string;
    readonly root: string;
    readonly testRoot: string;
    readonly files: readonly string[];
    readonly observationKeys: readonly string[];
    readonly namePattern?: string;
  };
  readonly commandAttempts: number;
  readonly failedCommands: number;
  readonly testExecutions: number;
  readonly failures: readonly {
    readonly id: string;
    readonly status: string;
    readonly message?: string;
  }[];
  readonly errors: readonly {
    readonly code: string;
    readonly message: string;
  }[];
  readonly commandResult?: {
    readonly exitCode: number | null;
    readonly signal: string | null;
  };
  readonly reads: readonly {
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

type NodeDiagnosticData = {
  readonly runs: readonly NodeRunDiagnostic[];
};

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDirectory = join(
  packageDirectory,
  "fixtures",
  "installed-consumer",
  "node-test",
);

export async function verifyInstalledNodeTest(
  dockTarball: string,
): Promise<void> {
  assert.equal(
    process.version,
    "v26.13.1",
    "Node test installed verification requires Node v26.13.1.",
  );
  const tarball = resolve(process.cwd(), dockTarball);
  await access(tarball);

  const temporary = await mkdtemp(join(tmpdir(), "dock-node-installed-"));
  const consumer = join(temporary, "consumer");
  const secondary = join(consumer, "secondary");
  try {
    await cp(fixtureDirectory, consumer, { recursive: true });
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "dock-node-test-consumer",
        private: true,
        type: "module",
      }),
    );
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
        tarball,
      ],
      consumer,
      360_000,
    );
    assert.equal(
      installation.code,
      0,
      `Clean consumer install of @ykdz/dock failed (signal=${installation.signal}, timedOut=${installation.timedOut}):\n${installation.stdout}\n${installation.stderr}`,
    );

    await mkdir(secondary, { recursive: true });
    await writeFile(
      join(secondary, "package.json"),
      JSON.stringify({
        name: "dock-node-test-secondary-consumer",
        private: true,
        type: "module",
      }),
    );
    const secondaryInstallation = await run(
      "npm",
      [
        "install",
        "--prefix",
        secondary,
        "--no-save",
        "--no-package-lock",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
        tarball,
      ],
      consumer,
      360_000,
    );
    assert.equal(
      secondaryInstallation.code,
      0,
      `Secondary clean consumer install of @ykdz/dock failed (signal=${secondaryInstallation.signal}, timedOut=${secondaryInstallation.timedOut}):\n${secondaryInstallation.stdout}\n${secondaryInstallation.stderr}`,
    );
    await verifyPhysicalCopies(consumer, secondary);

    const scenarios: readonly [
      string,
      (bin: string, consumer: string) => Promise<void>,
    ][] = [
      ["public-types", (_bin, dir) => verifyInstalledTypes(dir)],
      [
        "invalid-runtime-inputs",
        (_bin, dir) => verifyRuntimeInputDiagnostics(dir),
      ],
      [
        "invalid-runtime-observations",
        (_bin, dir) => verifyRuntimeObservationDiagnostics(dir),
      ],
      ["happy-round-trip", verifyHappyRoundTrip],
      ["observations-and-reads", verifyObservationAndReadScenarios],
      ["read-failure-diagnostics", verifyReadFailureDiagnostics],
      ["loop-observed-registrations", verifyLoopObservedRegistrations],
      ["effective-root", verifyEffectiveRoot],
      [
        "operation-local-execution",
        (_bin, dir) => verifyOperationLocalExecution(dir),
      ],
      ["failure-isolation", verifyFailureIsolation],
      ["run-lifecycle", verifyRunLifecycle],
      ["after-end-failure", verifyAfterEndFailure],
      ["interrupted-process", verifyInterruptedProcess],
      ["statuses-and-identity", verifyStatusesAndIdentity],
      ["conflict-preflight", verifyConflictPreflight],
      ["ordinary-node-test", (_bin, dir) => verifyOrdinaryNodeTest(dir)],
      ["no-vitest-dependency", (_bin, dir) => verifyNoFrameworkDependency(dir)],
      ["scope-filtering", (_bin, dir) => verifyInstalledScope(dir)],
    ];
    for (const [index, [name, verify]] of scenarios.entries()) {
      const scenario = join(temporary, `scenario-${index}`);
      await cp(fixtureDirectory, scenario, { recursive: true });
      await symlink(
        join(consumer, "node_modules"),
        join(scenario, "node_modules"),
        "dir",
      );
      await symlink(
        join(secondary, "node_modules"),
        join(scenario, "secondary", "node_modules"),
        "dir",
      );
      try {
        const bin = join(
          scenario,
          "node_modules",
          ".bin",
          process.platform === "win32" ? "dock.cmd" : "dock",
        );
        await verify(bin, scenario);
      } catch (error) {
        throw new Error(
          `Node installed scenario "${name}" failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      } finally {
        await rm(scenario, { recursive: true, force: true });
      }
    }
    process.stdout.write(
      "Clean consumer @ykdz/dock node-test installed verification passed.\n",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function verifyPhysicalCopies(
  consumer: string,
  secondary: string,
): Promise<void> {
  const first = join(consumer, "node_modules", "@ykdz", "dock");
  const second = join(secondary, "node_modules", "@ykdz", "dock");
  const [firstPath, secondPath] = await Promise.all([
    realpath(first),
    realpath(second),
  ]);
  assert.notEqual(
    firstPath,
    secondPath,
    "@ykdz/dock must come from two separate physical installations.",
  );
  const [firstPackage, secondPackage] = await Promise.all([
    readFile(join(firstPath, "package.json"), "utf8"),
    readFile(join(secondPath, "package.json"), "utf8"),
  ]);
  assert.equal(
    JSON.parse(firstPackage).version,
    JSON.parse(secondPackage).version,
    "Both physical installations of @ykdz/dock must have the same version.",
  );
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
    `Installed public node-test type positive/negative checks failed:\n${result.stdout}\n${result.stderr}`,
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
    `Dynamic Node test declarations did not produce clear input diagnostics:\n${result.stdout}\n${result.stderr}`,
  );
}

async function verifyRuntimeObservationDiagnostics(
  consumer: string,
): Promise<void> {
  const result = await run(
    process.execPath,
    [join(consumer, "runtime-observations.mjs")],
    consumer,
  );
  assert.equal(
    result.code,
    0,
    `Dynamic observations did not reject invalid JSON values:\n${result.stdout}\n${result.stderr}`,
  );
}

async function verifyInstalledScope(consumer: string): Promise<void> {
  const result = await run(
    process.execPath,
    [join(consumer, "scope-runtime.mjs")],
    consumer,
  );
  assert.equal(
    result.code,
    0,
    `Node installed scope filtering verification failed:\n${result.stdout}\n${result.stderr}`,
  );
}

async function verifyHappyRoundTrip(
  bin: string,
  consumer: string,
): Promise<void> {
  const firstCheck = await runDock(
    bin,
    ["check", "--config", "dock.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(firstCheck.code, 1, firstCheck.stderr);
  assert.notEqual(
    firstCheck.stdout.trim(),
    "",
    `Initial check did not emit JSON report:\n${firstCheck.stderr}`,
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
  assert.match(
    textCheck.stdout,
    /Node run business-run: 2 test attempt\(s\), 1 command attempt\(s\)/,
  );

  const update = await runDock(
    bin,
    [
      "baseline",
      "update",
      "--config",
      "dock.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(update.code, 0, `${update.stderr}\n${update.stdout}`);
  const updated = parseEnvelope(update.stdout);
  assert.equal(updated.variant, "updated");
  assertExecutionSummary(requireReport(updated), 1, 2);
  await access(join(consumer, "dock.baseline.json"));

  const current = await runDock(
    bin,
    ["check", "--config", "dock.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(current.code, 0, current.stderr);
  const checked = parseEnvelope(current.stdout);
  assert.equal(checked.variant, "consistent");
  assertExecutionSummary(requireReport(checked), 1, 2);

  const currentText = await runDock(
    bin,
    ["check", "--config", "dock.config.mts"],
    consumer,
  );
  assert.equal(currentText.code, 0, currentText.stderr);
  assert.match(
    currentText.stdout,
    /Reference primary-business-status, file .*test\/happy\.test\.mts/,
  );
  assert.match(
    currentText.stdout,
    /Reference secondary-business-status, file .*test\/happy\.test\.mts/,
  );
  assert.match(currentText.stdout, /Current fact: \{"status":"passed"\}/);
  assert.doesNotMatch(
    currentText.stdout,
    /"pluginId"|"kind"|"files"|"testRoot"|"observationKeys"|"namePattern"/,
  );
}

async function verifyObservationAndReadScenarios(
  bin: string,
  consumer: string,
): Promise<void> {
  const businessText = "😀—Reading: 温度 🧭：24\nAmount: 17\n";
  await writeFile(join(consumer, "read-business.txt"), businessText);
  await writeFile(
    join(consumer, "read-unassociated.txt"),
    "Unassociated: unassociated current content\n",
  );

  const update = await runDock(
    bin,
    [
      "baseline",
      "update",
      "--config",
      "observations.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(update.code, 0, `${update.stdout}\n${update.stderr}`);
  const updated = parseEnvelope(update.stdout);
  assert.equal(updated.variant, "updated");
  const updatedReport = requireReport(updated);
  assertExecutionSummary(updatedReport, 1, 1);
  assertReadDiagnostic(
    updatedReport,
    "current-business-text",
    "温度 🧭：24",
    businessText.indexOf("温度 🧭：24"),
  );
  assertReadDiagnostic(
    updatedReport,
    "current-business-amount",
    "17",
    businessText.indexOf("17"),
  );
  assertReadDiagnostic(
    updatedReport,
    "unassociated-business-text",
    "unassociated current content",
  );

  const check = await runDock(
    bin,
    ["check", "--config", "observations.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(check.code, 0, check.stderr);
  const checked = parseEnvelope(check.stdout);
  assert.equal(checked.variant, "consistent");
  assertReadDiagnostic(
    requireReport(checked),
    "current-business-text",
    "温度 🧭：24",
    businessText.indexOf("温度 🧭：24"),
  );

  const textCheck = await runDock(
    bin,
    ["check", "--config", "observations.config.mts"],
    consumer,
  );
  assert.equal(textCheck.code, 0, textCheck.stderr);
  assert.match(textCheck.stdout, /Read in Node test current-business-text/);
  assert.match(textCheck.stdout, /温度 🧭：24/);
  assert.match(textCheck.stdout, /read current value and record observations/);
  assert.match(textCheck.stdout, /read-business\.txt/);

  const changedBusinessText = businessText.replace("Amount: 17", "Amount: 19");
  await writeFile(join(consumer, "read-business.txt"), changedBusinessText);
  const changed = await runDock(
    bin,
    ["check", "--config", "observations.config.mts", "--output", "structured"],
    consumer,
  );
  const changedEnvelope = parseEnvelope(changed.stdout);
  assert.equal(changedEnvelope.variant, "changed", changed.stderr);
  const changedReport = requireReport(changedEnvelope);
  assertExecutionSummary(changedReport, 1, 1);
  const numericChange = changedReport.bindings
    .flatMap((item) => item.changes ?? [])
    .find(
      (item) => item.kind === "fact" && item.referenceId === "current-amount",
    );
  assert.deepEqual(numericChange, {
    kind: "fact",
    referenceId: "current-amount",
    before: 17,
    after: 19,
  });

  const driftUpdate = await runDock(
    bin,
    [
      "baseline",
      "update",
      "--config",
      "observations.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(driftUpdate.code, 0, driftUpdate.stderr);
  assert.equal(parseEnvelope(driftUpdate.stdout).variant, "updated");

  const driftCheck = await runDock(
    bin,
    ["check", "--config", "observations.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(driftCheck.code, 0, driftCheck.stderr);
  assert.equal(parseEnvelope(driftCheck.stdout).variant, "consistent");
  assertExecutionSummary(requireReport(parseEnvelope(driftCheck.stdout)), 1, 1);

  const diagnostics = await runDock(
    bin,
    [
      "check",
      "--config",
      "diagnostic-observations.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(diagnostics.code, 1, diagnostics.stderr);
  const diagnosticReport = requireReport(parseEnvelope(diagnostics.stdout));
  assertExecutionSummary(diagnosticReport, 1, 2);
  assertBindingError(
    diagnosticReport,
    "observation-missing-or-duplicate",
    "observation-missing",
  );
  assertBindingError(
    diagnosticReport,
    "observation-missing-or-duplicate",
    "observation-duplicate",
  );

  const diagnosticUpdate = await runDock(
    bin,
    [
      "baseline",
      "update",
      "--config",
      "diagnostic-observations.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(diagnosticUpdate.code, 1, diagnosticUpdate.stderr);
  assert.equal(parseEnvelope(diagnosticUpdate.stdout).variant, "rejected");
  await assert.rejects(
    access(join(consumer, "diagnostic-observations.baseline.json")),
    { code: "ENOENT" },
  );
}

async function verifyLoopObservedRegistrations(
  bin: string,
  consumer: string,
): Promise<void> {
  const update = await runDock(
    bin,
    [
      "baseline",
      "update",
      "--config",
      "loop-observations.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(update.code, 0, `${update.stdout}\n${update.stderr}`);
  const updated = parseEnvelope(update.stdout);
  assert.equal(updated.variant, "updated");
  assertExecutionSummary(requireReport(updated), 1, 2);

  const baseline = JSON.parse(
    await readFile(join(consumer, "loop-observations.baseline.json"), "utf8"),
  ) as {
    readonly bindings: Record<
      string,
      { readonly references: Record<string, { readonly value: unknown }> }
    >;
  };
  assert.equal(
    baseline.bindings.alpha?.references["alpha-observation"]?.value,
    1,
  );
  assert.equal(
    baseline.bindings.beta?.references["beta-observation"]?.value,
    2,
  );

  const check = await runDock(
    bin,
    [
      "check",
      "--config",
      "loop-observations.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(check.code, 0, check.stderr);
  assert.equal(parseEnvelope(check.stdout).variant, "consistent");
  assertExecutionSummary(requireReport(parseEnvelope(check.stdout)), 1, 2);
}

async function verifyReadFailureDiagnostics(
  bin: string,
  consumer: string,
): Promise<void> {
  await writeFile(
    join(consumer, "read-business.txt"),
    "😀—Reading: 温度 🧭：24\nAmount: 17\n",
  );
  const configuration = "failed-read.config.mts";
  const marker = join(consumer, "failed-read.marker");
  const baselinePath = join(consumer, "failed-read.baseline.json");
  const initialUpdate = await runDock(
    bin,
    ["baseline", "update", "--config", configuration, "--output", "structured"],
    consumer,
  );
  assert.equal(initialUpdate.code, 0, initialUpdate.stderr);
  assert.equal(parseEnvelope(initialUpdate.stdout).variant, "updated");
  const baselineBytes = await readFile(baselinePath);

  await writeFile(marker, "fail after current read\n");
  try {
    const check = await runDock(
      bin,
      ["check", "--config", configuration, "--output", "structured"],
      consumer,
    );
    assert.equal(check.code, 1, check.stderr);
    const checkReport = requireReport(parseEnvelope(check.stdout));
    assertBindingError(
      checkReport,
      "business-assertion-after-read",
      "test-failed",
    );
    assertReadDiagnostic(
      checkReport,
      "current-business-text",
      "温度 🧭：24",
      undefined,
      "business assertion fails after read",
    );

    const textCheck = await runDock(
      bin,
      ["check", "--config", configuration],
      consumer,
    );
    assert.equal(textCheck.code, 1, textCheck.stderr);
    assert.match(textCheck.stdout, /Read in Node test current-business-text/);
    assert.match(textCheck.stdout, /温度 🧭：24/);
    assert.match(textCheck.stdout, /business assertion fails after read/);
    assert.match(textCheck.stdout, /read-business\.txt/);

    const update = await runDock(
      bin,
      [
        "baseline",
        "update",
        "--config",
        configuration,
        "--output",
        "structured",
      ],
      consumer,
    );
    assert.equal(update.code, 1, update.stderr);
    assert.equal(parseEnvelope(update.stdout).variant, "rejected");
    assert.deepEqual(await readFile(baselinePath), baselineBytes);
  } finally {
    await rm(marker, { force: true });
  }
}

function assertReadDiagnostic(
  report: MaintenanceReport,
  referenceId: string,
  value: unknown,
  start?: number,
  testName = "read current value and record observations",
): void {
  const diagnostic = requireNodeDiagnostic(report);
  const read = diagnostic.runs
    .flatMap((run) => run.reads)
    .find((candidate) => candidate.referenceId === referenceId);
  assert.ok(
    read,
    `Execution report did not include read ${referenceId}: ${JSON.stringify(diagnostic)}`,
  );
  assert.equal(read.value, value);
  assert.equal(typeof read.runId, "string");
  assert.notEqual(read.runId, "");
  const identity = JSON.parse(read.testId) as unknown;
  assert.ok(
    typeof identity === "object" &&
      identity !== null &&
      !Array.isArray(identity),
  );
  assert.equal((identity as { name?: unknown }).name, testName);
  if (start !== undefined) {
    assert.ok(read.range);
    assert.equal(read.range.start, start);
    assert.equal(read.range.end, start + String(value).length);
  }
}

async function verifyEffectiveRoot(
  bin: string,
  consumer: string,
): Promise<void> {
  const arguments_ = [
    "--config",
    "configurations/rooted.config.mts",
    "--output",
    "structured",
  ];
  const update = await runDock(
    bin,
    ["baseline", "update", ...arguments_],
    consumer,
  );
  assert.equal(update.code, 0, update.stderr);
  const updated = parseEnvelope(update.stdout);
  assert.equal(updated.variant, "updated");
  const updateReport = requireReport(updated);
  assertBindingHasNoErrors(updateReport, "effective-root-maintenance");
  assertExecutionSummary(updateReport, 1, 1);
  await access(join(consumer, "effective-root", "rooted.baseline.json"));

  const check = await runDock(bin, ["check", ...arguments_], consumer);
  assert.equal(check.code, 0, check.stderr);
  const checked = parseEnvelope(check.stdout);
  assert.equal(checked.variant, "consistent");
  const checkReport = requireReport(checked);
  assertBindingHasNoErrors(checkReport, "effective-root-maintenance");
  assertExecutionSummary(checkReport, 1, 1);
}

async function verifyFailureIsolation(
  bin: string,
  consumer: string,
): Promise<void> {
  const check = await runDock(
    bin,
    ["check", "--config", "isolation.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(check.code, 1, check.stderr);
  const envelope = parseEnvelope(check.stdout);
  assert.equal(envelope.variant, "errors");
  const report = requireReport(envelope);
  assertExecutionSummary(report, 1, 2, 1);
  assertBindingError(report, "failing-business", "test-failed");
  assertBindingHasNoErrors(report, "independent-business");
  const runDiagnostic = requireNodeDiagnostic(report).runs[0];
  assert.ok(runDiagnostic);
  assert.equal(runDiagnostic.commandResult?.exitCode, 1);
  assert.ok(
    runDiagnostic.failures.some((failure) => failure.status === "failed"),
  );

  const update = await runDock(
    bin,
    [
      "baseline",
      "update",
      "--config",
      "isolation.config.mts",
      "--output",
      "structured",
    ],
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
    `Sequential maintenance calls in the same process did not re-execute Node tests:\n${result.stdout}\n${result.stderr}`,
  );
}

async function verifyRunLifecycle(
  bin: string,
  consumer: string,
): Promise<void> {
  const closeFailure = await runDock(
    bin,
    ["check", "--config", "close-failure.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(closeFailure.code, 1, closeFailure.stderr);
  const closeEnvelope = parseEnvelope(closeFailure.stdout);
  assert.equal(closeEnvelope.variant, "errors");
  assertBindingError(
    requireReport(closeEnvelope),
    "close-status",
    "run-lifecycle-failed",
  );

  const cancelled = await runDock(
    bin,
    ["check", "--config", "cancelled.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(cancelled.code, 1, cancelled.stderr);
  const cancelledEnvelope = parseEnvelope(cancelled.stdout);
  assert.equal(cancelledEnvelope.variant, "errors");
  const cancelledReport = requireReport(cancelledEnvelope);
  assertBindingError(cancelledReport, "entered", "test-cancelled");
  assertBindingError(cancelledReport, "unentered", "test-not-executed");
  assertExecutionSummary(cancelledReport, 1, 2, 1);

  const startupFailure = await runDock(
    bin,
    [
      "check",
      "--config",
      "startup-failure.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(startupFailure.code, 1, startupFailure.stderr);
  const startupEnvelope = parseEnvelope(startupFailure.stdout);
  assert.equal(startupEnvelope.variant, "errors");
  assertBindingError(
    requireReport(startupEnvelope),
    "startup-failure",
    "run-lifecycle-failed",
  );
}

async function verifyInterruptedProcess(
  bin: string,
  consumer: string,
): Promise<void> {
  const baselinePath = join(consumer, "interrupted.baseline.json");
  const initial = await runDock(
    bin,
    [
      "baseline",
      "update",
      "--config",
      "interrupted.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(initial.code, 0, initial.stderr);
  assert.equal(parseEnvelope(initial.stdout).variant, "updated");
  await writeFile(join(consumer, "interrupted.marker"), "interrupt\n");
  const baselineBytes = await readFile(baselinePath);

  const check = await runDock(
    bin,
    ["check", "--config", "interrupted.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(check.code, 1, check.stderr);
  assert.equal(check.signal, null);
  assert.equal(check.timedOut, false);
  const checkEnvelope = parseEnvelope(check.stdout);
  assert.equal(checkEnvelope.variant, "errors");
  const checkReport = requireReport(checkEnvelope);
  assertBindingError(
    checkReport,
    "interrupted-binding",
    "run-lifecycle-failed",
  );
  assertNodeCommandSummary(checkReport, 1, 1);
  assert.deepEqual(await readFile(baselinePath), baselineBytes);

  const update = await runDock(
    bin,
    [
      "baseline",
      "update",
      "--config",
      "interrupted.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(update.code, 1, update.stderr);
  assert.equal(update.signal, null);
  assert.equal(update.timedOut, false);
  const updateEnvelope = parseEnvelope(update.stdout);
  assert.equal(updateEnvelope.variant, "rejected");
  const updateReport = requireReport(updateEnvelope);
  assertBindingError(
    updateReport,
    "interrupted-binding",
    "run-lifecycle-failed",
  );
  assertNodeCommandSummary(updateReport, 1, 1);
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
}

async function verifyAfterEndFailure(
  bin: string,
  consumer: string,
): Promise<void> {
  const configuration = "after-end.config.mts";
  const marker = join(consumer, "after-end.marker");
  const baselinePath = join(consumer, "after-end.baseline.json");
  const initialUpdate = await runDock(
    bin,
    ["baseline", "update", "--config", configuration, "--output", "structured"],
    consumer,
  );
  assert.equal(initialUpdate.code, 0, initialUpdate.stderr);
  assert.equal(parseEnvelope(initialUpdate.stdout).variant, "updated");
  const baselineBytes = await readFile(baselinePath);

  for (const failure of ["uncaught", "rejection", "exit"] as const) {
    await writeFile(marker, failure);
    try {
      const check = await runDock(
        bin,
        ["check", "--config", configuration, "--output", "structured"],
        consumer,
      );
      const update = await runDock(
        bin,
        [
          "baseline",
          "update",
          "--config",
          configuration,
          "--output",
          "structured",
        ],
        consumer,
      );
      assert.equal(
        check.code,
        1,
        `check (${failure}) stdout:\n${check.stdout}\ncheck stderr:\n${check.stderr}\nupdate stdout:\n${update.stdout}\nupdate stderr:\n${update.stderr}`,
      );
      const checkEnvelope = parseEnvelope(check.stdout);
      assert.equal(checkEnvelope.variant, "errors");
      const checkReport = requireReport(checkEnvelope);
      assertBindingError(
        checkReport,
        "async-failure-binding",
        "run-lifecycle-failed",
      );
      assertNodeCommandSummary(checkReport, 1, 1);

      assert.equal(
        update.code,
        1,
        `update (${failure}) stdout:\n${update.stdout}\nupdate stderr:\n${update.stderr}`,
      );
      const updateEnvelope = parseEnvelope(update.stdout);
      assert.equal(updateEnvelope.variant, "rejected");
      const updateReport = requireReport(updateEnvelope);
      assertBindingError(
        updateReport,
        "async-failure-binding",
        "run-lifecycle-failed",
      );
      assertNodeCommandSummary(updateReport, 1, 1);
      assert.deepEqual(await readFile(baselinePath), baselineBytes);
    } finally {
      await rm(marker, { force: true });
    }
  }
}

async function verifyStatusesAndIdentity(
  bin: string,
  consumer: string,
): Promise<void> {
  const statuses = await runDock(
    bin,
    ["check", "--config", "statuses.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(statuses.code, 1, statuses.stderr);
  const statusReport = requireReport(parseEnvelope(statuses.stdout));
  assertBindingError(statusReport, "non-passing-binding", "test-skipped");
  assertBindingError(statusReport, "non-passing-binding", "test-todo");

  const filtered = await runDock(
    bin,
    ["check", "--config", "filtered.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(filtered.code, 1, filtered.stderr);
  const filteredReport = requireReport(parseEnvelope(filtered.stdout));
  assertBindingError(filteredReport, "filtered-binding", "test-filtered");
  assertBindingHasNoErrors(filteredReport, "kept-binding");
  assertExecutionSummary(filteredReport, 1, 1);

  const duplicate = await runDock(
    bin,
    ["check", "--config", "duplicate.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(duplicate.code, 1, duplicate.stderr);
  const duplicateReport = requireReport(parseEnvelope(duplicate.stdout));
  assertBindingError(
    duplicateReport,
    "duplicate-binding",
    "duplicate-test-identity",
  );
  assertExecutionSummary(duplicateReport, 1, 2);
}

async function verifyConflictPreflight(
  bin: string,
  consumer: string,
): Promise<void> {
  const marker = join(consumer, "test-workspace", "conflict-started.marker");
  const check = await runDock(
    bin,
    ["check", "--config", "conflict.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(check.code, 1, check.stderr);
  assert.equal(parseEnvelope(check.stderr).data?.code, "plugin-prepare-failed");
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
    `Ordinary node:test passing semantics changed:\n${passing.stdout}\n${passing.stderr}`,
  );

  const failing = await run(
    process.execPath,
    ["--test", join(consumer, "test-workspace/test/ordinary-failure.test.mts")],
    consumer,
  );
  assert.equal(
    failing.code,
    1,
    `Ordinary node:test failing semantics changed:\n${failing.stdout}\n${failing.stderr}`,
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
    "@ykdz/dock-reference-vitest",
    "@ykdz/dock-reference-node-test",
    "@ykdz/dock-core",
    "@ykdz/dock-reference-file",
  ]) {
    assert.equal(
      names.has(dependency),
      false,
      `Installed @ykdz/dock node-test consumer must not depend on ${dependency}`,
    );
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
  timeoutMs = 30_000,
): Promise<ProcessResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(command, [...arguments_], { cwd });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
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
  const envelope = JSON.parse(output) as CliEnvelope;
  assert.equal(envelope.schemaVersion, "3", output);
  assert.equal(envelope.outputMode, "structured", output);
  return envelope;
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
  assertNodeDiagnosticSummary(
    report,
    commandAttempts,
    testExecutions,
    failedCommands,
  );
}

function assertNodeDiagnosticSummary(
  report: MaintenanceReport,
  commandAttempts: number,
  testExecutions: number,
  failedCommands = 0,
): void {
  assertNodeCommandSummary(report, commandAttempts, failedCommands);
  const diagnostic = requireNodeDiagnostic(report);
  assert.equal(
    diagnostic.runs.reduce((sum, runItem) => sum + runItem.testExecutions, 0),
    testExecutions,
  );
}

function assertNodeCommandSummary(
  report: MaintenanceReport,
  commandAttempts: number,
  failedCommands: number,
): void {
  assert.deepEqual(report.pluginErrors, []);
  const diagnostic = requireNodeDiagnostic(report);
  assert.equal(
    diagnostic.runs.reduce((sum, runItem) => sum + runItem.commandAttempts, 0),
    commandAttempts,
  );
  assert.equal(
    diagnostic.runs.reduce((sum, runItem) => sum + runItem.failedCommands, 0),
    failedCommands,
  );
  for (const runItem of diagnostic.runs) {
    assert.ok(runItem.identity.length > 0);
    assert.ok(runItem.configuration.files.length > 0);
  }
}

function requireNodeDiagnostic(report: MaintenanceReport): NodeDiagnosticData {
  const diagnostic = report.pluginDiagnostics.find(
    (item) => item.pluginId === "@ykdz/dock-reference-node-test",
  );
  assert.ok(diagnostic, "Report is missing Node test plugin diagnostics.");
  return diagnostic.data as NodeDiagnosticData;
}

function assertBindingError(
  report: MaintenanceReport,
  bindingId: string,
  code: string,
): void {
  const item = report.bindings.find(
    (candidate) => candidate.bindingId === bindingId,
  );
  assert.ok(item, `Missing binding ${bindingId}`);
  assert.ok(
    item.errors?.some((error) => error.code === code),
    `Binding ${bindingId} did not report ${code}: ${JSON.stringify(item.errors)}`,
  );
}

function assertBindingHasNoErrors(
  report: MaintenanceReport,
  bindingId: string,
): void {
  const item = report.bindings.find(
    (candidate) => candidate.bindingId === bindingId,
  );
  assert.ok(item, `Missing binding ${bindingId}`);
  assert.equal(
    item.errors,
    undefined,
    `Binding ${bindingId} was unexpectedly affected by errors`,
  );
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

async function main(): Promise<void> {
  const artifacts = process.argv.slice(2);
  assert.equal(
    artifacts.length,
    1,
    "Installed Node test verification expects the single @ykdz/dock tarball path.",
  );
  const tarball = resolve(process.cwd(), artifacts[0]!);
  await access(tarball);
  await verifyInstalledNodeTest(tarball);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `Node installed verification failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
