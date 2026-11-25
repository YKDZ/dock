import assert from "node:assert/strict";
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
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ResolvedMaintenance } from "@boringparts/dock";

import {
  assertForbiddenDependencies,
  dockBin,
  hostCompiler,
  installConsumer,
  packageDirectory,
  parseEnvelope,
  run,
  type CliEnvelope,
  type ProcessResult,
} from "./verify-installed-shared.ts";

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

type VitestRunDiagnostic = {
  readonly identity: string;
  readonly command: {
    readonly attempted: boolean;
    readonly code: number | null;
    readonly signal: string | null;
  };
  readonly testAttempts: number;
  readonly tests: readonly {
    readonly identity: string;
    readonly status: string;
    readonly attemptCount: number;
    readonly message?: string;
  }[];
  readonly failures: readonly {
    readonly identity: string;
    readonly status: string;
    readonly attemptCount: number;
    readonly message?: string;
  }[];
  readonly reads: readonly {
    readonly testIdentity: string;
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

type MaintenanceReport = {
  readonly scope?: readonly string[];
  readonly pluginDiagnostics: readonly {
    readonly pluginId: string;
    readonly data: { readonly runs: readonly VitestRunDiagnostic[] };
    readonly text: readonly string[];
  }[];
  readonly pluginErrors: readonly {
    readonly pluginId: string;
    readonly code: string;
    readonly message: string;
  }[];
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

type CrossFrameworkReport = {
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
  readonly bindings: MaintenanceReport["bindings"];
};

const fixtureDirectory = join(
  packageDirectory,
  "fixtures",
  "installed-consumer",
  "vitest",
);

type VitestVersion = "4.1.11" | "5.0.3";

async function main(): Promise<void> {
  const artifacts = process.argv.slice(2);
  assert.equal(
    artifacts.length,
    1,
    "Installed Vitest verification expects the @boringparts/dock tarball path.",
  );
  const dockTarball = resolve(process.cwd(), artifacts[0]!);
  await access(dockTarball);
  await verifyInstalledVitest(dockTarball);
}

/**
 * Verifies `@boringparts/dock/vitest` across Environment B (Vitest 4.1.11 with dual physical
 * installations and cross-framework co-registration) and Environment C (Vitest 5.0.3 peer compatibility).
 */
export async function verifyInstalledVitest(
  dockTarball: string,
): Promise<void> {
  const resolvedTarball = resolve(process.cwd(), dockTarball);
  await access(resolvedTarball);

  await verifyVitest4111Environment(resolvedTarball);
  await verifyVitest503Environment(resolvedTarball);
}

async function verifyVitest4111Environment(dockTarball: string): Promise<void> {
  const version: VitestVersion = "4.1.11";
  const temporary = await mkdtemp(join(tmpdir(), `dock-vitest-${version}-`));
  const consumer = join(temporary, "consumer");
  try {
    await cp(fixtureDirectory, consumer, { recursive: true });
    await installConsumer(
      consumer,
      [dockTarball, `vitest@${version}`],
      `dock-vitest-${version}-consumer`,
    );
    await installConsumer(
      join(consumer, "test-workspace"),
      [dockTarball, `vitest@${version}`],
      `dock-vitest-read-workspace-${version}`,
    );

    const scenarios: readonly [
      string,
      (dock: string, scenarioConsumer: string) => Promise<void>,
    ][] = [
      [
        "public types, read types, and cross-framework types",
        async (_dock, scenarioConsumer) => {
          await verifyInstalledTypes(scenarioConsumer, version);
          await verifyReadTypes(scenarioConsumer, version);
          await verifyCrossFrameworkTypes(scenarioConsumer);
        },
      ],
      ["cross-framework co-registration", verifyCrossFrameworkScenario],
      [
        "invalid runtime inputs",
        (_dock, scenarioConsumer) => verifyRuntimeInputs(scenarioConsumer),
      ],
      ["user config and inspect", verifyUserConfig],
      [
        "baseline round trip",
        (dock, scenarioConsumer) =>
          verifyHappyRoundTrip(
            dock,
            scenarioConsumer,
            join(scenarioConsumer, "maintenance-root", "happy.baseline.json"),
          ),
      ],
      [
        "observations and dual-install readReferenceInTest",
        (dock, scenarioConsumer) =>
          verifyObservationAndReadRoundTrip(
            dock,
            scenarioConsumer,
            version,
            true,
          ),
      ],
      ["test suites", verifyGroupsFull],
      ["suite teardown failure", verifySuiteFailure],
      ["additional tests", verifyAdditionalTests],
      [
        "status failures",
        (dock, scenarioConsumer) =>
          verifyStatusFailures(
            dock,
            scenarioConsumer,
            join(scenarioConsumer, "maintenance-root", "happy.baseline.json"),
          ),
      ],
      [
        "name filtering and identity",
        (dock, scenarioConsumer) =>
          verifyFilterAndIdentity(
            dock,
            scenarioConsumer,
            join(scenarioConsumer, "maintenance-root", "happy.baseline.json"),
          ),
      ],
      [
        "conflict preflight",
        (dock, scenarioConsumer) =>
          verifyConflictPreflight(
            dock,
            scenarioConsumer,
            join(scenarioConsumer, "maintenance-root", "happy.baseline.json"),
          ),
      ],
      [
        "interrupted runs and 4.1.11 zero-exit close failure",
        (dock, scenarioConsumer) =>
          verifyLifecycleFailures(
            dock,
            scenarioConsumer,
            join(scenarioConsumer, "maintenance-root", "happy.baseline.json"),
            version,
            true,
          ),
      ],
      [
        "operation-local execution",
        (_dock, scenarioConsumer) =>
          verifyOperationLocalExecution(scenarioConsumer),
      ],
      [
        "ordinary native Vitest CLI",
        (_dock, scenarioConsumer) => verifyOrdinaryVitest(scenarioConsumer),
      ],
      [
        "dependency boundaries",
        (_dock, scenarioConsumer) =>
          verifyDependencyBoundaries(scenarioConsumer),
      ],
    ];

    await runVitestScenarios(
      temporary,
      consumer,
      join(consumer, "test-workspace", "node_modules"),
      version,
      scenarios,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function verifyVitest503Environment(dockTarball: string): Promise<void> {
  const version: VitestVersion = "5.0.3";
  const temporary = await mkdtemp(join(tmpdir(), `dock-vitest-${version}-`));
  const consumer = join(temporary, "consumer");
  try {
    await cp(fixtureDirectory, consumer, { recursive: true });
    await installConsumer(
      consumer,
      [dockTarball, `vitest@${version}`],
      `dock-vitest-${version}-consumer`,
    );

    const scenarios: readonly [
      string,
      (dock: string, scenarioConsumer: string) => Promise<void>,
    ][] = [
      [
        "public types, read types, and dependency boundaries",
        async (_dock, scenarioConsumer) => {
          await verifyInstalledTypes(scenarioConsumer, version);
          await verifyReadTypes(scenarioConsumer, version);
          await verifyDependencyBoundaries(scenarioConsumer);
        },
      ],
      [
        "user config and baseline round trip",
        async (dock, scenarioConsumer) => {
          await verifyUserConfig(dock, scenarioConsumer);
          await verifyHappyRoundTrip(
            dock,
            scenarioConsumer,
            join(scenarioConsumer, "maintenance-root", "happy.baseline.json"),
          );
        },
      ],
      [
        "observations, readReferenceInTest, and retry missing observation",
        (dock, scenarioConsumer) =>
          verifyObservationAndReadRoundTrip(
            dock,
            scenarioConsumer,
            version,
            false,
          ),
      ],
      ["test suite discovery and failures", verifyGroupsSmoke],
      [
        "suite teardown and close failures",
        async (dock, scenarioConsumer) => {
          await verifySuiteFailure(dock, scenarioConsumer);
          await verifyLifecycleFailures(
            dock,
            scenarioConsumer,
            join(scenarioConsumer, "maintenance-root", "happy.baseline.json"),
            version,
            false,
          );
        },
      ],
    ];

    await runVitestScenarios(
      temporary,
      consumer,
      join(consumer, "node_modules"),
      version,
      scenarios,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runVitestScenarios(
  temporary: string,
  consumer: string,
  testWorkspaceNodeModules: string,
  version: VitestVersion,
  scenarios: readonly (readonly [
    string,
    (dock: string, scenarioConsumer: string) => Promise<void>,
  ])[],
): Promise<void> {
  for (const [index, [name, verify]] of scenarios.entries()) {
    const scenario = join(temporary, `scenario-${index}`);
    await cp(fixtureDirectory, scenario, { recursive: true });
    await symlink(
      join(consumer, "node_modules"),
      join(scenario, "node_modules"),
      "dir",
    );
    await symlink(
      testWorkspaceNodeModules,
      join(scenario, "test-workspace", "node_modules"),
      "dir",
    );
    try {
      const maintenanceRoot = join(scenario, "maintenance-root");
      await mkdir(maintenanceRoot, { recursive: true });
      await writeFile(join(maintenanceRoot, "business.data"), "ready\n");
      await verify(dockBin(scenario), scenario);
    } catch (error) {
      throw new Error(
        `Vitest ${version} scenario "${name}" failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        { cause: error },
      );
    } finally {
      await rm(scenario, { recursive: true, force: true });
    }
  }
}

async function verifyCrossFrameworkScenario(
  dock: string,
  consumer: string,
): Promise<void> {
  const maintenanceRoot = join(consumer, "maintenance-root");
  const marker = join(maintenanceRoot, "cross-framework-started.log");
  await mkdir(maintenanceRoot, { recursive: true });
  const configurations = [
    "cross-framework.config.mts",
    "cross-framework-reordered.config.mts",
  ];
  const reports: CrossFrameworkReport[] = [];

  for (const configuration of configurations) {
    await rm(marker, { force: true });
    const result = await runDock(
      dock,
      ["check", "--config", configuration, "--output", "structured"],
      consumer,
    );
    assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
    const envelope = parseEnvelope(result.stdout);
    assert.equal(envelope.variant, "changed");
    const report = requireReport(envelope) as CrossFrameworkReport;
    assert.deepEqual(report.pluginErrors, []);
    assert.deepEqual(
      report.pluginDiagnostics.map(({ pluginId }) => pluginId).sort(),
      ["dock:node-test", "dock:vitest"],
    );
    for (const diagnostic of report.pluginDiagnostics) {
      const data = diagnostic.data as {
        readonly runs: readonly {
          readonly identity: string;
          readonly configuration?: { readonly framework?: string };
        }[];
      };
      assert.deepEqual(
        data.runs.map(({ identity }) => identity),
        ["shared run identity"],
      );
      assert.deepEqual(
        data.runs.map(({ configuration }) => configuration?.framework),
        [diagnostic.pluginId],
      );
    }
    assert.deepEqual(
      report.bindings.map(({ bindingId }) => bindingId),
      ["Node run", "Vitest run"],
    );
    assert.deepEqual(
      report.bindings.map((binding) =>
        Object.fromEntries(
          Object.entries(binding.current?.references ?? {}).map(
            ([referenceId, reference]) => [referenceId, reference.value],
          ),
        ),
      ),
      [
        { "Node status": { status: "passed" } },
        { "Vitest status": { status: "passed" } },
      ],
    );
    assert.deepEqual(await markerLines(marker), ["node", "vitest"]);
    reports.push(report);
  }

  assert.deepEqual(
    reports[0]?.bindings,
    reports[1]?.bindings,
    "Reordering registered plugins must not change binding results.",
  );
  assert.deepEqual(
    diagnosticsByPlugin(reports[0]!),
    diagnosticsByPlugin(reports[1]!),
    "Reordering registered plugins must not change plugin diagnostics.",
  );

  await rm(marker, { force: true });
  const textResult = await runDock(
    dock,
    ["check", "--config", configurations[0]!],
    consumer,
  );
  assert.equal(
    textResult.code,
    1,
    `${textResult.stdout}\n${textResult.stderr}`,
  );
  assert.match(textResult.stdout, /Binding Node run/);
  assert.match(textResult.stdout, /Binding Vitest run/);
  assert.deepEqual(await markerLines(marker), ["node", "vitest"]);

  for (const selected of [
    {
      bindingId: "Node run",
      referenceId: "Node status",
      pluginId: "dock:node-test",
      started: "node",
    },
    {
      bindingId: "Vitest run",
      referenceId: "Vitest status",
      pluginId: "dock:vitest",
      started: "vitest",
    },
  ]) {
    await rm(marker, { force: true });
    const filtered = await runDock(
      dock,
      [
        "check",
        "--config",
        configurations[0]!,
        "--binding",
        selected.bindingId,
        "--output",
        "structured",
      ],
      consumer,
    );
    assert.equal(filtered.code, 1, `${filtered.stdout}\n${filtered.stderr}`);
    const envelope = parseEnvelope(filtered.stdout);
    assert.equal(envelope.variant, "changed");
    const report = requireReport(envelope) as CrossFrameworkReport;
    assert.deepEqual(
      report.bindings.map(({ bindingId }) => bindingId),
      [selected.bindingId],
    );
    assert.deepEqual(
      report.pluginDiagnostics.map(({ pluginId }) => pluginId),
      [selected.pluginId],
    );
    assert.deepEqual(report.pluginErrors, []);
    assert.deepEqual(
      report.bindings[0]?.current?.references[selected.referenceId]?.value,
      { status: "passed" },
    );
    assert.deepEqual(await markerLines(marker), [selected.started]);
  }
}

function diagnosticsByPlugin(report: CrossFrameworkReport) {
  return report.pluginDiagnostics
    .map(({ pluginId, data, text }) => ({ pluginId, data, text }))
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

async function markerLines(marker: string): Promise<string[]> {
  const contents = await readFile(marker, "utf8");
  return contents.trim().split(/\r?\n/u).sort();
}

async function verifyCrossFrameworkTypes(consumer: string): Promise<void> {
  const result = await run(
    hostCompiler,
    [
      "-p",
      join(consumer, "cross-framework-types-tsconfig.json"),
      "--pretty",
      "false",
    ],
    consumer,
  );
  assert.equal(
    result.code,
    0,
    `Node and Vitest combined public type positive checks failed:\n${result.stdout}\n${result.stderr}`,
  );
}

async function verifyInstalledTypes(
  consumer: string,
  version: string,
): Promise<void> {
  const result = await run(
    hostCompiler,
    ["-p", join(consumer, "tsconfig.json"), "--pretty", "false"],
    consumer,
  );
  assert.equal(
    result.code,
    0,
    `Vitest ${version} installed declaration positive/negative type checks failed:\n${result.stdout}\n${result.stderr}`,
  );
}

async function verifyReadTypes(
  consumer: string,
  version: string,
): Promise<void> {
  const result = await run(
    hostCompiler,
    ["-p", join(consumer, "tsconfig.read.json"), "--pretty", "false"],
    consumer,
  );
  assert.equal(
    result.code,
    0,
    `Vitest ${version} read positive/negative type checks failed:\n${result.stdout}\n${result.stderr}`,
  );
}

async function verifyUserConfig(dock: string, consumer: string): Promise<void> {
  const arguments_ = [
    "--config",
    "user-config.config.mts",
    "--binding",
    "user config status",
  ];
  const viewed = await runDock(
    dock,
    ["inspect", ...arguments_, "--output", "structured"],
    consumer,
  );
  assert.equal(viewed.code, 0, viewed.stderr);
  const resolution = parseEnvelope(viewed.stdout).data?.resolution as
    | ResolvedMaintenance
    | undefined;
  assert.ok(resolution);
  const plugin = resolution.plugins.find(({ id }) => id === "dock:vitest");
  assert.ok(plugin?.description);
  const description = plugin.description.data as unknown as {
    readonly runs: readonly {
      readonly identity: string;
      readonly references: readonly string[];
      readonly selectedReferences: readonly string[];
    }[];
  };
  assert.deepEqual(
    description.runs.map((runItem) => ({
      identity: runItem.identity,
      references: runItem.references,
      selectedReferences: runItem.selectedReferences,
    })),
    [
      {
        identity: "user config run",
        references: ["config passed", "out of scope test"],
        selectedReferences: ["config passed"],
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
  assert.match(text.stdout, /Vitest run declaration user config run/);
  assert.match(text.stdout, /; selected config passed/);
  const maintenanceRoot = join(consumer, "maintenance-root");
  await assert.rejects(access(join(maintenanceRoot, "config-evaluated.log")), {
    code: "ENOENT",
  });
  const checked = await runDock(
    dock,
    ["check", ...arguments_, "--output", "structured"],
    consumer,
  );
  assert.equal(checked.code, 1, checked.stderr);
  const report = requireReport(parseEnvelope(checked.stdout));
  assertBindingHasNoErrors(report, "user config status");
  assertVitestDiagnostics(report, 1, 1);
  assert.match(
    await readFile(join(maintenanceRoot, "config-evaluated.log"), "utf8"),
    /serve\/test/,
  );
  assert.equal(
    await readFile(join(maintenanceRoot, "user-reporter.log"), "utf8"),
    "ended\n",
  );
}

async function verifyObservationAndReadRoundTrip(
  dock: string,
  consumer: string,
  version: VitestVersion,
  expectDualPhysicalInstall: boolean,
): Promise<void> {
  const testRoot = join(consumer, "test-workspace");
  const maintenanceRoot = join(consumer, "maintenance-root");
  if (expectDualPhysicalInstall) {
    const outerDock = await realpath(
      join(consumer, "node_modules", "@boringparts", "dock"),
    );
    const testDock = await realpath(
      join(testRoot, "node_modules", "@boringparts", "dock"),
    );
    assert.notEqual(
      outerDock,
      testDock,
      "Test workspace must import Vitest helpers from a separate physical installation.",
    );
  }

  await writeFile(join(maintenanceRoot, "read-target.txt"), "value: ready\n");
  if (expectDualPhysicalInstall) {
    const multiFileBaseline = join(maintenanceRoot, "attempts.baseline.json");
    await rm(multiFileBaseline, { force: true });
    const multiFileUpdate = await runDock(
      dock,
      [
        "baseline",
        "update",
        "--config",
        "attempts.config.mts",
        "--output",
        "structured",
      ],
      consumer,
    );
    assert.equal(multiFileUpdate.code, 0, multiFileUpdate.stderr);
    assertVitestDiagnostics(
      requireReport(parseEnvelope(multiFileUpdate.stdout)),
      1,
      2,
    );
  }

  const baselinePath = join(maintenanceRoot, "read-observation.baseline.json");
  await rm(baselinePath, { force: true });
  const firstCheck = await runDock(
    dock,
    [
      "check",
      "--config",
      "read-observation.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(firstCheck.code, 1, firstCheck.stderr);
  const firstReport = requireReport(parseEnvelope(firstCheck.stdout));
  assertBindingHasNoErrors(firstReport, "business text");
  assertVitestDiagnostics(firstReport, 1, 1);
  assertReadDiagnostics(firstReport, [
    {
      runId: "file read business observation",
      testId: JSON.stringify([
        "test/read-observation.test.mts",
        "business text observation",
      ]),
      attempt: 1,
      referenceId: "business-text-source",
      value: "ready",
      range: { path: "read-target.txt", start: 7, end: 12 },
    },
  ]);

  const update = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "read-observation.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(update.code, 0, update.stderr);
  const baselineBytes = await readFile(baselinePath);
  const consistent = await runDock(
    dock,
    [
      "check",
      "--config",
      "read-observation.config.mts",
      "--output",
      "structured",
    ],
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
    [
      "check",
      "--config",
      "read-observation.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(changed.code, 1, changed.stderr);
  assertReadDiagnostics(requireReport(parseEnvelope(changed.stdout)), [
    {
      runId: "file read business observation",
      testId: JSON.stringify([
        "test/read-observation.test.mts",
        "business text observation",
      ]),
      attempt: 1,
      referenceId: "business-text-source",
      value: "changed",
      range: { path: "read-target.txt", start: 21, end: 28 },
    },
  ]);
  const changedUpdate = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "read-observation.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(changedUpdate.code, 0, changedUpdate.stderr);

  const consistentText = await runDock(
    dock,
    ["check", "--config", "read-observation.config.mts"],
    consumer,
  );
  assert.equal(
    consistentText.code,
    0,
    `${consistentText.stdout}\n${consistentText.stderr}`,
  );
  assert.equal(
    consistentText.stdout,
    "Scope: business text\nAll checked bindings are consistent with baseline.\n",
  );

  const consistentStructured = await runDock(
    dock,
    [
      "check",
      "--config",
      "read-observation.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(consistentStructured.code, 0, consistentStructured.stderr);
  const structuredReport = requireReport(
    parseEnvelope(consistentStructured.stdout),
  );
  const structuredDiagText = structuredReport.pluginDiagnostics
    .find(({ pluginId }) => pluginId === "dock:vitest")
    ?.text.join("\n");
  for (const fragment of [
    "read reference business-text-source",
    "Vitest run file read business observation",
    "business text observation",
    "attempt 1",
    '"changed"',
    "read-target.txt:21-28",
  ]) {
    assert.ok(
      structuredDiagText?.includes(fragment),
      `Structured diagnostic text is missing ${fragment} on Vitest ${version}:\n${structuredDiagText ?? ""}`,
    );
  }

  if (expectDualPhysicalInstall) {
    await writeFile(
      join(maintenanceRoot, "read-target.txt"),
      "value: first\nvalue: second\n",
    );
    const ambiguousRead = await runDock(
      dock,
      [
        "check",
        "--config",
        "ambiguous-read.config.mts",
        "--output",
        "structured",
      ],
      consumer,
    );
    assert.equal(ambiguousRead.code, 1, ambiguousRead.stderr);
    const ambiguousReport = requireReport(parseEnvelope(ambiguousRead.stdout));
    assertBindingHasNoErrors(ambiguousReport, "read selection ambiguity");
    assertReadDiagnostics(ambiguousReport, []);
    assert.equal(
      ambiguousReport.bindings.find(
        (binding) => binding.bindingId === "read selection ambiguity",
      )?.current?.references["read error outcome"]?.value,
      "ambiguous-selection",
    );
    await writeFile(
      join(maintenanceRoot, "read-target.txt"),
      "moved: prefix\nvalue: changed\n",
    );
  }

  // Passing final retry without selected observation rejects update without accepting earlier attempt's observation.
  const missingBaseline = join(
    maintenanceRoot,
    "missing-observation.baseline.json",
  );
  await rm(missingBaseline, { force: true });
  const missing = await runDock(
    dock,
    [
      "check",
      "--config",
      "missing-observation.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(missing.code, 1, missing.stderr);
  const missingReport = requireReport(parseEnvelope(missing.stdout));
  assertBindingError(
    missingReport,
    "final attempt observation",
    "observation-missing",
  );
  assertVitestDiagnostics(missingReport, 1, 2);
  const missingUpdate = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "missing-observation.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(missingUpdate.code, 1, missingUpdate.stderr);
  assert.equal(parseEnvelope(missingUpdate.stdout).variant, "rejected");
  await assert.rejects(access(missingBaseline), { code: "ENOENT" });

  // Final retry failure rejects update and preserves absence of baseline.
  const finalFailureBaseline = join(
    maintenanceRoot,
    "final-failure.baseline.json",
  );
  await rm(finalFailureBaseline, { force: true });
  const finalFailureUpdate = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "final-failure.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(finalFailureUpdate.code, 1, finalFailureUpdate.stderr);
  assert.equal(parseEnvelope(finalFailureUpdate.stdout).variant, "rejected");
  assertBindingError(
    requireReport(parseEnvelope(finalFailureUpdate.stdout)),
    "final failure observation",
    "test-failed",
  );
  await assert.rejects(access(finalFailureBaseline), { code: "ENOENT" });

  if (expectDualPhysicalInstall) {
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
        "--output",
        "structured",
      ],
      consumer,
    );
    assert.equal(duplicateUpdate.code, 1, duplicateUpdate.stderr);
    assert.equal(parseEnvelope(duplicateUpdate.stdout).variant, "rejected");
    assertBindingError(
      requireReport(parseEnvelope(duplicateUpdate.stdout)),
      "duplicate observation",
      "observation-duplicate",
    );
    await assert.rejects(access(duplicateBaseline), { code: "ENOENT" });
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
    `Vitest dynamic declaration failed to reject invalid run inputs:\n${result.stdout}\n${result.stderr}`,
  );
}

async function verifyHappyRoundTrip(
  dock: string,
  consumer: string,
  baselinePath: string,
): Promise<void> {
  const arguments_ = ["--config", "happy.config.mts", "--output", "structured"];
  const firstCheck = await runDock(dock, ["check", ...arguments_], consumer);
  assert.equal(firstCheck.code, 1, firstCheck.stderr);
  const first = parseEnvelope(firstCheck.stdout);
  assert.equal(first.variant, "changed", firstCheck.stdout);
  const firstReport = requireReport(first);
  assertBindingHasNoErrors(firstReport, "passing status");
  assertVitestDiagnostics(firstReport, 1, 5, 1);

  const update = await runDock(
    dock,
    ["baseline", "update", ...arguments_],
    consumer,
  );
  assert.equal(update.code, 0, update.stderr);
  assert.equal(parseEnvelope(update.stdout).variant, "updated");
  const baselineBytes = await readFile(baselinePath);

  const current = await runDock(dock, ["check", ...arguments_], consumer);
  assert.equal(current.code, 0, current.stderr);
  const checked = parseEnvelope(current.stdout);
  assert.equal(checked.variant, "consistent", current.stdout);
  const checkedReport = requireReport(checked);
  assertBindingHasNoErrors(checkedReport, "passing status");
  assertVitestDiagnostics(checkedReport, 1, 5, 1);
  const diagnosticText = checkedReport.pluginDiagnostics
    .find(({ pluginId }) => pluginId === "dock:vitest")
    ?.text.join("\n");
  assert.match(diagnosticText ?? "", /native command exited with code 1/);
  assert.deepEqual(await readFile(baselinePath), baselineBytes);

  const textCheck = await runDock(
    dock,
    ["check", "--config", "happy.config.mts"],
    consumer,
  );
  assert.equal(textCheck.code, 0, `${textCheck.stdout}\n${textCheck.stderr}`);
  assert.equal(
    textCheck.stdout,
    "Scope: passing status\nAll checked bindings are consistent with baseline.\n",
  );
}

async function verifyGroupsSmoke(
  dock: string,
  consumer: string,
): Promise<void> {
  const maintenanceRoot = join(consumer, "maintenance-root");
  const baselinePath = join(maintenanceRoot, "groups.baseline.json");
  await rm(baselinePath, { force: true });

  const initial = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "groups.config.mts",
      "--output",
      "structured",
    ],
    consumer,
    { DOCK_VITEST_GROUP_VARIANT: "baseline" },
  );
  assert.equal(initial.code, 0, `${initial.stdout}\n${initial.stderr}`);
  assert.equal(parseEnvelope(initial.stdout).variant, "updated");
  const baselineBytes = await readFile(baselinePath);

  const changed = await runDock(
    dock,
    ["check", "--config", "groups.config.mts", "--output", "structured"],
    consumer,
    { DOCK_VITEST_GROUP_VARIANT: "changed" },
  );
  assert.equal(changed.code, 1, `${changed.stdout}\n${changed.stderr}`);
  assert.equal(parseEnvelope(changed.stdout).variant, "changed");

  const filteredUpdate = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "group-filter.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(filteredUpdate.code, 1, filteredUpdate.stderr);
  assert.equal(parseEnvelope(filteredUpdate.stdout).variant, "rejected");
  assertBindingError(
    requireReport(parseEnvelope(filteredUpdate.stdout)),
    "filtered group",
    "test-skipped",
  );
  assert.deepEqual(await readFile(baselinePath), baselineBytes);

  const invalidUpdate = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "group-failures.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(invalidUpdate.code, 1, invalidUpdate.stderr);
  assert.equal(parseEnvelope(invalidUpdate.stdout).variant, "rejected");
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
}

async function verifyGroupsFull(dock: string, consumer: string): Promise<void> {
  const maintenanceRoot = join(consumer, "maintenance-root");
  const baselinePath = join(maintenanceRoot, "groups.baseline.json");
  const primaryMemberId = JSON.stringify([
    "preview config",
    "inner > label",
    "primary",
  ]);
  const renamedMemberId = JSON.stringify([
    "preview config",
    "inner > label",
    "primary renamed",
  ]);
  const sameNamedNestedMemberId = JSON.stringify([
    "preview config",
    "other nested",
    "primary",
  ]);
  const variant = { DOCK_VITEST_GROUP_VARIANT: "baseline" };
  await rm(baselinePath, { force: true });

  const initial = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "groups.config.mts",
      "--output",
      "structured",
    ],
    consumer,
    variant,
  );
  assert.equal(initial.code, 0, `${initial.stdout}\n${initial.stderr}`);
  const initialReport = requireReport(parseEnvelope(initial.stdout));
  assertBindingHasNoErrors(initialReport, "preview group");
  assertBindingHasNoErrors(initialReport, "empty group");
  assertBindingHasNoErrors(initialReport, "all preview members");
  const allPreviewMembers = initialReport.bindings.find(
    (binding) => binding.bindingId === "all preview members",
  )?.current?.references["all-preview-members"]?.value;
  assert.ok(Array.isArray(allPreviewMembers));
  const allPreviewMemberIds = new Set(
    allPreviewMembers.map((member) => (member as { id: string }).id),
  );
  assert.equal(allPreviewMemberIds.has(primaryMemberId), true);
  assert.equal(allPreviewMemberIds.has(sameNamedNestedMemberId), true);
  assert.equal(allPreviewMemberIds.size, 4);
  let baselineBytes = await readFile(baselinePath);

  const stable = await runDock(
    dock,
    ["check", "--config", "groups.config.mts", "--output", "structured"],
    consumer,
    variant,
  );
  assert.equal(stable.code, 0, stable.stderr);
  assert.equal(parseEnvelope(stable.stdout).variant, "consistent");

  const renamed = await runDock(
    dock,
    ["check", "--config", "groups.config.mts", "--output", "structured"],
    consumer,
    { DOCK_VITEST_GROUP_VARIANT: "renamed" },
  );
  assert.equal(renamed.code, 1, renamed.stderr);
  const renamedFact = requireReport(parseEnvelope(renamed.stdout))
    .bindings.find((binding) => binding.bindingId === "preview group")
    ?.changes?.find(
      (change) =>
        change.kind === "fact" && change.referenceId === "preview-members",
    );
  assert.ok(
    renamedFact?.memberChanges?.some(
      (c) =>
        c.memberId === primaryMemberId && c.beforePresent && !c.afterPresent,
    ),
  );
  assert.ok(
    renamedFact?.memberChanges?.some(
      (c) =>
        c.memberId === renamedMemberId && !c.beforePresent && c.afterPresent,
    ),
  );
  assert.deepEqual(await readFile(baselinePath), baselineBytes);

  const sharedBaseline = join(maintenanceRoot, "groups-shared.baseline.json");
  const groupMarker = join(maintenanceRoot, "groups-extra.marker");
  await rm(sharedBaseline, { force: true });
  await rm(groupMarker, { force: true });
  const sharedUpdate = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "groups-shared.config.mts",
      "--output",
      "structured",
    ],
    consumer,
    {
      DOCK_VITEST_GROUP_MARKER: groupMarker,
      DOCK_VITEST_GROUP_POISON: "1",
    },
  );
  assert.equal(sharedUpdate.code, 0, sharedUpdate.stderr);
  assertVitestDiagnostics(
    requireReport(parseEnvelope(sharedUpdate.stdout)),
    1,
    2,
  );
  await assert.rejects(access(groupMarker), { code: "ENOENT" });

  const caseMarker = join(maintenanceRoot, "case-extra.marker");
  await rm(join(maintenanceRoot, "group-case.baseline.json"), { force: true });
  await rm(caseMarker, { force: true });
  const patternUpdate = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "group-case.config.mts",
      "--output",
      "structured",
    ],
    consumer,
    {
      DOCK_VITEST_CASE_PATTERN: "nonprefix",
      DOCK_VITEST_CASE_EXTRA_MARKER: caseMarker,
    },
  );
  assert.equal(patternUpdate.code, 0, patternUpdate.stderr);
  await assert.rejects(access(caseMarker), { code: "ENOENT" });

  await rm(join(maintenanceRoot, "group-collision.baseline.json"), {
    force: true,
  });
  const collisionUpdate = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "group-collision.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(collisionUpdate.code, 0, collisionUpdate.stderr);

  const ambiguousSingle = await runDock(
    dock,
    [
      "check",
      "--config",
      "group-collision-single.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(ambiguousSingle.code, 1, ambiguousSingle.stderr);
  assertBindingError(
    requireReport(parseEnvelope(ambiguousSingle.stdout)),
    "title matching multiple paths",
    "duplicate-test-identity",
  );

  const failureBytes = await readFile(baselinePath);
  const invalidUpdate = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "group-failures.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(invalidUpdate.code, 1, invalidUpdate.stderr);
  assert.equal(parseEnvelope(invalidUpdate.stdout).variant, "rejected");
  const invalidReport = requireReport(parseEnvelope(invalidUpdate.stdout));
  assertBindingError(
    invalidReport,
    "group with errors and valid single test",
    "test-skipped",
  );
  assertBindingError(
    invalidReport,
    "group with errors and valid single test",
    "test-todo",
  );
  assertBindingError(
    invalidReport,
    "group with errors and valid single test",
    "observation-missing",
  );
  assertBindingError(
    invalidReport,
    "group with errors and valid single test",
    "observation-duplicate",
  );
  assert.deepEqual(await readFile(baselinePath), failureBytes);

  const filteredUpdate = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "group-filter.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(filteredUpdate.code, 1, filteredUpdate.stderr);
  assertBindingError(
    requireReport(parseEnvelope(filteredUpdate.stdout)),
    "filtered group",
    "test-skipped",
  );
  assert.deepEqual(await readFile(baselinePath), failureBytes);

  const missingSuite = await runDock(
    dock,
    [
      "check",
      "--config",
      "group-missing-suite.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(missingSuite.code, 1, missingSuite.stderr);
  assertBindingError(
    requireReport(parseEnvelope(missingSuite.stdout)),
    "missing group",
    "test-group-not-found",
  );

  const collectionError = await runDock(
    dock,
    [
      "check",
      "--config",
      "group-collection-error.config.mts",
      "--output",
      "structured",
    ],
    consumer,
    { DOCK_VITEST_GROUP_SCENARIO: "collection-error" },
  );
  assert.equal(collectionError.code, 1, collectionError.stderr);
  assertBindingError(
    requireReport(parseEnvelope(collectionError.stdout)),
    "collection failed group",
    "run-lifecycle-failed",
  );
}

async function verifyStatusFailures(
  dock: string,
  consumer: string,
  baselinePath: string,
): Promise<void> {
  const initial = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "happy.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(initial.code, 0, initial.stderr);
  const baselineBytes = await readFile(baselinePath);

  const statuses = await runDock(
    dock,
    ["check", "--config", "statuses.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(statuses.code, 1, statuses.stderr);
  const statusReport = requireReport(parseEnvelope(statuses.stdout));
  assertBindingError(statusReport, "skipped status", "test-skipped");
  assertBindingError(statusReport, "todo status", "test-todo");
  assertBindingError(
    statusReport,
    "dynamically skipped status",
    "test-skipped",
  );
  assertBindingError(statusReport, "missing status", "test-not-executed");

  const failureUpdate = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "failure.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(failureUpdate.code, 1, failureUpdate.stderr);
  assert.equal(parseEnvelope(failureUpdate.stdout).variant, "rejected");
  assertBindingError(
    requireReport(parseEnvelope(failureUpdate.stdout)),
    "failure status",
    "test-failed",
  );
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
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
    [
      "check",
      "--config",
      "suite-close-failure.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(check.code, 1, `${check.stdout}\n${check.stderr}`);
  const checkReport = requireReport(parseEnvelope(check.stdout));
  assertBindingError(
    checkReport,
    "shared teardown status",
    "run-lifecycle-failed",
  );
  assertVitestDiagnostics(checkReport, 1, 3, 1);
  assert.equal(await readFile(markerPath, "utf8"), "teardown executed\n");

  const update = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "suite-close-failure.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(update.code, 1, `${update.stdout}\n${update.stderr}`);
  assert.equal(parseEnvelope(update.stdout).variant, "rejected");
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
    [
      "baseline",
      "update",
      "--config",
      "additional-tests.config.mjs",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(update.code, 0, `${update.stdout}\n${update.stderr}`);
  const report = requireReport(parseEnvelope(update.stdout));
  assertBindingHasNoErrors(report, "explicitly required status");
  assert.equal(
    await readFile(markerPath, "utf8"),
    "additional test executed\nadditional test executed\n",
  );
  assertVitestDiagnostics(report, 1, 3, 1);
}

async function verifyFilterAndIdentity(
  dock: string,
  consumer: string,
  baselinePath: string,
): Promise<void> {
  const initial = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "happy.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(initial.code, 0, initial.stderr);
  const baselineBytes = await readFile(baselinePath);

  const filtered = await runDock(
    dock,
    ["check", "--config", "filter.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(filtered.code, 1, filtered.stderr);
  const filteredReport = requireReport(parseEnvelope(filtered.stdout));
  assertBindingHasNoErrors(filteredReport, "retained status");
  assertBindingHasSomeError(filteredReport, "filtered status");

  const update = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "duplicate.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(update.code, 1, update.stderr);
  assert.equal(parseEnvelope(update.stdout).variant, "rejected");
  assertBindingError(
    requireReport(parseEnvelope(update.stdout)),
    "ambiguous status",
    "duplicate-test-identity",
  );
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
    [
      "baseline",
      "update",
      "--config",
      "happy.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(initial.code, 0, initial.stderr);
  const baselineBytes = await readFile(baselinePath);

  const update = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "conflict.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(update.code, 1, update.stderr);
  assert.equal(
    parseEnvelope(update.stderr).data?.code,
    "plugin-prepare-failed",
  );
  await assert.rejects(access(marker), { code: "ENOENT" });
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
}

async function verifyLifecycleFailures(
  dock: string,
  consumer: string,
  baselinePath: string,
  version: VitestVersion,
  includeExtended: boolean,
): Promise<void> {
  const initial = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "happy.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(initial.code, 0, initial.stderr);
  const baselineBytes = await readFile(baselinePath);

  const cases: readonly (readonly [string, string, number, number])[] =
    includeExtended
      ? [
          [
            "close-failure.config.mts",
            "teardown status",
            1,
            version === "5.0.3" ? 1 : 0,
          ],
          ["unhandled.config.mts", "unhandled error", 1, 1],
          ["interrupted.config.mts", "interrupted status", 0, 1],
          ["abnormal-exit.config.mts", "abnormal exit status", 0, 1],
        ]
      : [
          [
            "close-failure.config.mts",
            "teardown status",
            1,
            version === "5.0.3" ? 1 : 0,
          ],
          ["interrupted.config.mts", "interrupted status", 0, 1],
        ];

  for (const [config, bindingId, testExecutions, failedCommands] of cases) {
    if (config === "interrupted.config.mts") {
      await rm(
        join(consumer, "maintenance-root", "interrupted-started.marker"),
        { force: true },
      );
    }
    const check = await runDock(
      dock,
      ["check", "--config", config, "--output", "structured"],
      consumer,
    );
    assert.equal(check.code, 1, `${config}\n${check.stdout}\n${check.stderr}`);
    const envelope = parseEnvelope(check.stdout);
    assert.equal(envelope.variant, "errors");
    const report = requireReport(envelope);
    assertBindingError(report, bindingId, "run-lifecycle-failed");
    assertVitestDiagnostics(report, 1, testExecutions, failedCommands);
    if (config === "close-failure.config.mts" && version === "4.1.11") {
      assert.equal(
        vitestRuns(report)[0]?.command.code,
        0,
        "Vitest 4.1.11 global close failure still exits native process with code 0.",
      );
    }

    const update = await runDock(
      dock,
      ["baseline", "update", "--config", config, "--output", "structured"],
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
    assertVitestDiagnostics(updateReport, 1, testExecutions, failedCommands);
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
    `Consecutive check/update/check calls did not each run Vitest freshly:\n${result.stdout}\n${result.stderr}`,
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
  assert.equal(passing.code, 0, passing.stdout + passing.stderr);

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
  assert.equal(failing.code, 1, failing.stdout + failing.stderr);
}

async function verifyDependencyBoundaries(consumer: string): Promise<void> {
  await assertForbiddenDependencies(
    consumer,
    [],
    "Installed Vitest @boringparts/dock consumer",
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

function requireReport(envelope: CliEnvelope): MaintenanceReport {
  assert.ok(envelope.data?.report !== undefined);
  return envelope.data.report as MaintenanceReport;
}

function vitestRuns(report: MaintenanceReport): readonly VitestRunDiagnostic[] {
  const diagnostics = report.pluginDiagnostics.find(
    ({ pluginId }) => pluginId === "dock:vitest",
  );
  assert.ok(diagnostics, "Missing Vitest plugin diagnostics");
  assert.ok(
    Array.isArray(diagnostics.data.runs),
    "Vitest diagnostics are missing runs list",
  );
  return diagnostics.data.runs;
}

function assertVitestDiagnostics(
  report: MaintenanceReport,
  commandAttempts: number,
  testExecutions: number,
  failedCommands = 0,
): void {
  const runs = vitestRuns(report);
  assert.deepEqual(
    {
      commandAttempts: runs.filter(({ command }) => command.attempted).length,
      failedCommands: runs.filter(
        ({ command }) =>
          command.attempted && (command.code !== 0 || command.signal !== null),
      ).length,
      testExecutions: runs.reduce(
        (total, runItem) => total + runItem.testAttempts,
        0,
      ),
    },
    { commandAttempts, failedCommands, testExecutions },
  );
}

function assertReadDiagnostics(
  report: MaintenanceReport,
  expected: readonly ReadDiagnostic[],
): void {
  const reads = vitestRuns(report).flatMap(({ identity, reads }) =>
    reads.map(({ testIdentity, ...read }) => ({
      runId: identity,
      testId: testIdentity,
      ...read,
    })),
  );
  assert.deepEqual(reads, expected);
}

function assertBindingError(
  report: MaintenanceReport,
  bindingId: string,
  code: string,
): void {
  const binding = report.bindings.find((item) => item.bindingId === bindingId);
  assert.ok(binding, `Missing binding ${bindingId}`);
  assert.ok(
    binding.errors?.some((error) => error.code === code),
    `Binding ${bindingId} did not report ${code}: ${JSON.stringify(binding.errors)}`,
  );
}

function assertBindingHasSomeError(
  report: MaintenanceReport,
  bindingId: string,
): void {
  const binding = report.bindings.find((item) => item.bindingId === bindingId);
  assert.ok(binding, `Missing binding ${bindingId}`);
  assert.ok(
    binding.errors !== undefined,
    `Binding ${bindingId} did not report any error`,
  );
}

function assertBindingHasNoErrors(
  report: MaintenanceReport,
  bindingId: string,
): void {
  const binding = report.bindings.find((item) => item.bindingId === bindingId);
  assert.ok(binding, `Missing binding ${bindingId}`);
  assert.equal(
    binding.errors,
    undefined,
    `Binding ${bindingId} was affected by an unexpected error`,
  );
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `Installed Vitest verification failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
