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
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ResolvedMaintenance } from "@ykdz/dock";

import { collectInstalledPackageNames } from "./npm-ls.ts";

type ProcessResult = {
  readonly code: number | null;
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

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDirectory = join(
  packageDirectory,
  "fixtures",
  "installed-consumer",
  "vitest",
);
const versions = ["4.1.11", "5.0.3"] as const;

async function main(): Promise<void> {
  const artifacts = process.argv.slice(2);
  assert.equal(
    artifacts.length,
    1,
    "Installed Vitest verification expects the @ykdz/dock tarball path.",
  );
  const dockTarball = resolve(process.cwd(), artifacts[0]!);
  await access(dockTarball);
  await verifyInstalledVitest(dockTarball);
}

/** Verifies @ykdz/dock/vitest under Vitest 4.1.11 and 5.0.3, plus a clean consumer without Vitest installed. */
export async function verifyInstalledVitest(
  dockTarball: string,
): Promise<void> {
  const resolvedTarball = resolve(process.cwd(), dockTarball);
  await access(resolvedTarball);

  for (const version of versions) {
    await verifyVersion(version, resolvedTarball);
  }

  await test("Clean consumer without Vitest: non-Vitest entrypoints and public types work", async () => {
    await verifyNoVitestConsumer(resolvedTarball);
  });

  await test("Node test and Vitest: same-named runs stay isolated and combined results stay stable", async () => {
    await verifyCrossFrameworkCombination(resolvedTarball);
  });
}

/** Verifies combined Node test and Vitest plugin co-registration from a single @ykdz/dock tarball. */
export async function verifyCrossFrameworkCombination(
  dockTarball: string,
): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "dock-test-frameworks-"));
  const consumer = join(temporary, "consumer");
  try {
    await cp(fixtureDirectory, consumer, { recursive: true });
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "dock-cross-framework-consumer",
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
        dockTarball,
        "vitest@4.1.11",
      ],
      consumer,
      360_000,
    );
    assert.equal(
      installation.code,
      0,
      `Clean cross-framework installation failed:\n${installation.stdout}\n${installation.stderr}`,
    );
    await verifyCrossFrameworkTypes(consumer);

    const maintenanceRoot = join(consumer, "maintenance-root");
    const marker = join(maintenanceRoot, "cross-framework-started.log");
    await mkdir(maintenanceRoot, { recursive: true });
    const dock = join(
      consumer,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "dock.cmd" : "dock",
    );
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
        ["@ykdz/dock-reference-node-test", "@ykdz/dock-reference-vitest"],
      );
      for (const diagnostic of report.pluginDiagnostics) {
        const data = diagnostic.data as {
          readonly runs: readonly { readonly identity: string }[];
        };
        assert.deepEqual(
          data.runs.map(({ identity }) => identity),
          ["shared run identity"],
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
    assert.match(textResult.stdout, /shared run identity.*1.*attempt/iu);
    assert.match(
      textResult.stdout,
      /Vitest run shared run identity: 1 test attempt/u,
    );
    assert.deepEqual(await markerLines(marker), ["node", "vitest"]);

    for (const selected of [
      {
        bindingId: "Node run",
        referenceId: "Node status",
        pluginId: "@ykdz/dock-reference-node-test",
        started: "node",
      },
      {
        bindingId: "Vitest run",
        referenceId: "Vitest status",
        pluginId: "@ykdz/dock-reference-vitest",
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
      const binding = report.bindings[0];
      assert.deepEqual(
        binding?.current?.references[selected.referenceId]?.value,
        { status: "passed" },
      );
      const data = report.pluginDiagnostics[0]!.data as {
        readonly runs: readonly { readonly identity: string }[];
      };
      assert.deepEqual(
        data.runs.map(({ identity }) => identity),
        ["shared run identity"],
      );
      assert.deepEqual(await markerLines(marker), [selected.started]);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function verifyNoVitestConsumer(dockTarball: string): Promise<void> {
  const consumer = await mkdtemp(join(tmpdir(), "dock-no-vitest-"));
  try {
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "dock-no-vitest-consumer",
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
        dockTarball,
      ],
      consumer,
      360_000,
    );
    assert.equal(
      installation.code,
      0,
      `Clean @ykdz/dock installation without Vitest failed:\n${installation.stdout}\n${installation.stderr}`,
    );

    await assert.rejects(access(join(consumer, "node_modules", "vitest")), {
      code: "ENOENT",
    });
    const listing = await run(
      "npm",
      ["ls", "--all", "--json", "--prefix", consumer],
      consumer,
    );
    assert.equal(listing.code, 0, listing.stderr);
    const installedNames = collectInstalledPackageNames(
      JSON.parse(listing.stdout) as unknown,
    );
    assert.equal(
      installedNames.has("vitest"),
      false,
      "Clean @ykdz/dock install must not install optional peer vitest.",
    );
    assert.equal(
      installedNames.has("@vitest/runner"),
      false,
      "Clean @ykdz/dock install must not install @vitest/runner.",
    );

    const manifest = JSON.parse(
      await readFile(
        join(consumer, "node_modules", "@ykdz", "dock", "package.json"),
        "utf8",
      ),
    ) as { readonly exports?: Record<string, unknown> };
    const availableSubpaths = Object.keys(manifest.exports ?? {});
    for (const subpath of [
      ".",
      "./core",
      "./markdown",
      "./typescript",
      "./node-test",
    ]) {
      assert.ok(
        availableSubpaths.includes(subpath),
        `Clean @ykdz/dock install is missing expected subpath ${subpath}.`,
      );
    }

    await writeFile(join(consumer, "sample.txt"), "status: ready\n");
    const typecheckLines = [
      `import {`,
      `  binding,`,
      `  check,`,
      `  defineConfig,`,
      `  file,`,
      `  inspect,`,
      `  readReference,`,
      `  updateBaseline,`,
      `  type CheckReport,`,
      `  type Config,`,
      `  type ReferenceValue,`,
      `} from "@ykdz/dock";`,
      `import {`,
      `  canonicalJson,`,
      `  check as checkCore,`,
      `  isJsonValue,`,
      `  updateBaseline as updateCoreBaseline,`,
      `  type Baseline,`,
      `} from "@ykdz/dock/core";`,
      `import { markdown, markdownPluginId } from "@ykdz/dock/markdown";`,
      `import { typescript, typescriptPluginId } from "@ykdz/dock/typescript";`,
      `import { nodeTest, nodeTestPluginId } from "@ykdz/dock/node-test";`,
      ``,
      `const doc = file.from("sample.txt").match("status: ([^\\\\n]+)", 1).reference("doc-status");`,
      `const valueCheck: ReferenceValue<typeof doc> = "ready";`,
      `const config = defineConfig({`,
      `  plugins: [file, markdown, typescript, nodeTest],`,
      `  bindings: [binding("doc", [doc])],`,
      `});`,
      `const typedConfig: Config<readonly [typeof file, typeof markdown, typeof typescript, typeof nodeTest]> = config;`,
      `const coreResult = checkCore({`,
      `  references: [{ id: "r", target: { path: "sample.txt" } }],`,
      `  bindings: [{ id: "b", references: ["r"] }],`,
      `  facts: [{ referenceId: "r", value: "ready" }],`,
      `});`,
      `const coreBaseline: Baseline = { version: 2, bindings: {} };`,
      `void valueCheck; void typedConfig; void coreResult; void coreBaseline;`,
      `void check; void inspect; void readReference; void updateBaseline;`,
      `void canonicalJson; void isJsonValue; void updateCoreBaseline;`,
      `void markdownPluginId; void typescriptPluginId; void nodeTestPluginId;`,
      `export type { CheckReport };`,
    ];
    await writeFile(join(consumer, "no-vitest.mts"), typecheckLines.join("\n"));
    await writeFile(
      join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2024",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          types: [],
        },
        include: ["no-vitest.mts"],
      }),
    );

    const compiler = join(
      packageDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsc.cmd" : "tsc",
    );
    const typecheck = await run(
      compiler,
      ["-p", join(consumer, "tsconfig.json"), "--pretty", "false"],
      consumer,
    );
    assert.equal(
      typecheck.code,
      0,
      `Consumer tsc without Vitest failed:\n${typecheck.stdout}\n${typecheck.stderr}`,
    );

    const runtimeScript = [
      `import assert from "node:assert/strict";`,
      `import { binding, check, defineConfig, file, inspect, readReference, updateBaseline } from "@ykdz/dock";`,
      `import { canonicalJson, check as checkCore, isJsonValue, updateBaseline as updateCoreBaseline } from "@ykdz/dock/core";`,
      `import { markdown, markdownPluginId } from "@ykdz/dock/markdown";`,
      `import { typescript, typescriptPluginId } from "@ykdz/dock/typescript";`,
      `import { nodeTest, nodeTestPluginId } from "@ykdz/dock/node-test";`,
      `const doc = file.from("sample.txt").match("status: ([^\\\\n]+)", 1).reference("doc-status");`,
      `const config = defineConfig({ plugins: [file, markdown, typescript, nodeTest], bindings: [binding("doc", [doc])] });`,
      `const read = await readReference(config, doc);`,
      `assert.equal(read.value, "ready");`,
      `const resolution = await inspect(config);`,
      `assert.equal(resolution.plugins.length, 4);`,
      `const firstCheck = await check(config);`,
      `assert.equal(firstCheck.bindings[0]?.changes.length, 1);`,
      `const updated = await updateBaseline(config);`,
      `assert.equal(updated.status, "updated");`,
      `const secondCheck = await check(config);`,
      `assert.equal(secondCheck.bindings[0]?.changes.length, 0);`,
      `assert.equal(isJsonValue({ ok: true }), true);`,
      `assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');`,
      `const coreUpdate = updateCoreBaseline({`,
      `  references: [{ id: "r", target: { path: "sample.txt" } }],`,
      `  bindings: [{ id: "b", references: ["r"] }],`,
      `  facts: [{ referenceId: "r", value: "ready" }],`,
      `});`,
      `assert.equal(coreUpdate.status, "updated");`,
      `const coreCheck = checkCore({`,
      `  baseline: coreUpdate.baseline,`,
      `  references: [{ id: "r", target: { path: "sample.txt" } }],`,
      `  bindings: [{ id: "b", references: ["r"] }],`,
      `  facts: [{ referenceId: "r", value: "ready" }],`,
      `});`,
      `assert.equal(coreCheck.bindings[0]?.changes.length, 0);`,
      `assert.equal(markdown.id, markdownPluginId);`,
      `assert.equal(typescript.id, typescriptPluginId);`,
      `assert.equal(nodeTest.id, nodeTestPluginId);`,
    ].join("\n");
    await writeFile(join(consumer, "runtime.mjs"), runtimeScript);
    const runtime = await run(
      process.execPath,
      [join(consumer, "runtime.mjs")],
      consumer,
    );
    assert.equal(
      runtime.code,
      0,
      `Consumer runtime without Vitest failed:\n${runtime.stdout}\n${runtime.stderr}`,
    );
  } finally {
    await rm(consumer, { recursive: true, force: true });
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
  const compiler = join(
    packageDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsc.cmd" : "tsc",
  );
  const result = await run(
    compiler,
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

async function verifyVersion(
  version: (typeof versions)[number],
  dockTarball: string,
): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), `dock-vitest-${version}-`));
  const consumer = join(temporary, "consumer");
  try {
    await cp(fixtureDirectory, consumer, { recursive: true });
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({
        name: `dock-vitest-${version}-consumer`,
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
        dockTarball,
        `vitest@${version}`,
      ],
      consumer,
      360_000,
    );
    assert.equal(
      installation.code,
      0,
      `Clean installation for Vitest ${version} failed (signal=${installation.signal}, timedOut=${installation.timedOut}):\n${installation.stdout}\n${installation.stderr}`,
    );

    await installReadConsumer(consumer, dockTarball, version);
    const scenarios: readonly [
      string,
      (dock: string, consumer: string) => Promise<void>,
    ][] = [
      [
        "public types and read types",
        async (_dock, scenarioConsumer) => {
          await verifyInstalledTypes(scenarioConsumer, version);
          await verifyReadTypes(scenarioConsumer, version);
        },
      ],
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
        "observations and readReferenceInTest",
        (dock, scenarioConsumer) =>
          verifyObservationAndReadRoundTrip(dock, scenarioConsumer, version),
      ],
      ["test suites", verifyGroups],
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
      ["scope filtering", verifyInstalledScope],
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
        "interrupted runs and close failures",
        (dock, scenarioConsumer) =>
          verifyLifecycleFailures(
            dock,
            scenarioConsumer,
            join(scenarioConsumer, "maintenance-root", "happy.baseline.json"),
            version,
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
    for (const [index, [name, verify]] of scenarios.entries()) {
      await test(`Vitest ${version}: ${name}`, async () => {
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
    "user config status",
  ];
  const viewed = await runDock(
    dock,
    ["inspect", ...arguments_, "--output", "structured"],
    consumer,
  );
  assert.equal(viewed.code, 0, viewed.stderr);
  const resolution = parseEnvelope(viewed.stdout).data?.resolution;
  assert.ok(resolution);
  const plugin = resolution.plugins.find(
    ({ id }) => id === "@ykdz/dock-reference-vitest",
  );
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

async function verifyInstalledScope(
  dock: string,
  consumer: string,
): Promise<void> {
  const config = "scope.config.mts";
  const oldFile = "../test-workspace/test/scope-old.test.mts";
  const newFile = "../test-workspace/test/scope-new.test.mts";
  const oldTarget = "test/scope-old.test.mts";
  const newTarget = "test/scope-new.test.mts";
  const arguments_ = ["--config", config, "--output", "structured"];

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
    ["check", "--config", config, "--file", oldFile, "--output", "structured"],
    consumer,
    { DOCK_VITEST_SCOPE_TARGET: newTarget },
  );
  assert.equal(historical.code, 1, historical.stderr);
  assert.equal(parseEnvelope(historical.stdout).variant, "changed");
  assertScopeDefinitionChange(historical.stdout, "scope-vitest-reference");

  const current = await runDock(
    dock,
    ["check", "--config", config, "--file", newFile, "--output", "structured"],
    consumer,
    { DOCK_VITEST_SCOPE_TARGET: newTarget },
  );
  assert.equal(current.code, 1, current.stderr);
  assert.equal(parseEnvelope(current.stdout).variant, "changed");
  assertScopeDefinitionChange(current.stdout, "scope-vitest-reference");

  const localUpdate = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      config,
      "--file",
      oldFile,
      "--output",
      "structured",
    ],
    consumer,
    { DOCK_VITEST_SCOPE_TARGET: newTarget },
  );
  assert.equal(localUpdate.code, 0, localUpdate.stderr);
  assert.deepEqual(requireReport(parseEnvelope(localUpdate.stdout)).scope, [
    "scope-vitest-policy",
  ]);

  const consistent = await runDock(
    dock,
    ["check", "--config", config, "--file", newFile, "--output", "structured"],
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
    `Vitest ${version} installed declaration positive/negative type checks failed:\n${result.stdout}\n${result.stderr}`,
  );
}

async function installReadConsumer(
  consumer: string,
  dockTarball: string,
  version: string,
): Promise<void> {
  const testRoot = join(consumer, "test-workspace");
  await writeFile(
    join(testRoot, "package.json"),
    JSON.stringify({
      name: `dock-vitest-read-workspace-${version}`,
      private: true,
      type: "module",
    }),
  );
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
      dockTarball,
      `vitest@${version}`,
    ],
    testRoot,
    360_000,
  );
  assert.equal(
    installation.code,
    0,
    `Vitest ${version} read consumer installation failed (signal=${installation.signal}, timedOut=${installation.timedOut}):\n${installation.stdout}\n${installation.stderr}`,
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
    `Vitest ${version} read positive/negative type checks failed:\n${result.stdout}\n${result.stderr}`,
  );
}

async function verifyObservationAndReadRoundTrip(
  dock: string,
  consumer: string,
  version: (typeof versions)[number],
): Promise<void> {
  const testRoot = join(consumer, "test-workspace");
  const maintenanceRoot = join(consumer, "maintenance-root");
  const outerDock = await realpath(
    join(consumer, "node_modules", "@ykdz", "dock"),
  );
  const testDock = await realpath(
    join(testRoot, "node_modules", "@ykdz", "dock"),
  );
  assert.notEqual(
    outerDock,
    testDock,
    "Test workspace must import Vitest helpers from a separate physical installation.",
  );
  const installedPackage = JSON.parse(
    await readFile(
      join(testRoot, "node_modules", "@ykdz", "dock", "package.json"),
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
    ["check", "--config", "attempts.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(
    multiFile.code,
    1,
    `Vitest ${version} multi-file observation check failed:\n${multiFile.stdout}\n${multiFile.stderr}`,
  );
  const multiFileEnvelope = parseEnvelope(multiFile.stdout);
  assert.equal(multiFileEnvelope.variant, "changed", multiFile.stdout);
  const multiFileReport = requireReport(multiFileEnvelope);
  assertBindingHasNoErrors(multiFileReport, "multi-file observation records");
  assertVitestDiagnostics(multiFileReport, 1, 2);

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
  assert.equal(parseEnvelope(multiFileUpdate.stdout).variant, "updated");
  const multiFileCurrent = await runDock(
    dock,
    ["check", "--config", "attempts.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(multiFileCurrent.code, 0, multiFileCurrent.stderr);
  assert.equal(parseEnvelope(multiFileCurrent.stdout).variant, "consistent");

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
  const firstEnvelope = parseEnvelope(firstCheck.stdout);
  assert.equal(firstEnvelope.variant, "changed", firstCheck.stdout);
  const firstReport = requireReport(firstEnvelope);
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
  assert.equal(parseEnvelope(update.stdout).variant, "updated");
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
  const changedEnvelope = parseEnvelope(changed.stdout);
  assert.equal(changedEnvelope.variant, "changed", changed.stdout);
  const changedReport = requireReport(changedEnvelope);
  assertBindingHasNoErrors(changedReport, "business text");
  assertReadDiagnostics(changedReport, [
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
  assert.equal(parseEnvelope(changedUpdate.stdout).variant, "updated");
  const changedCurrent = await runDock(
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
  assert.equal(changedCurrent.code, 0, changedCurrent.stderr);
  assert.equal(parseEnvelope(changedCurrent.stdout).variant, "consistent");

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
  const ambiguousReadEnvelope = parseEnvelope(ambiguousRead.stdout);
  assert.equal(ambiguousReadEnvelope.variant, "changed", ambiguousRead.stdout);
  const ambiguousReadReport = requireReport(ambiguousReadEnvelope);
  assertBindingHasNoErrors(ambiguousReadReport, "read selection ambiguity");
  assertReadDiagnostics(ambiguousReadReport, []);
  assert.equal(
    ambiguousReadReport.bindings.find(
      (binding) => binding.bindingId === "read selection ambiguity",
    )?.current?.references["read error outcome"]?.value,
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
  const missingEnvelope = parseEnvelope(missing.stdout);
  assert.equal(missingEnvelope.variant, "errors", missing.stdout);
  const missingReport = requireReport(missingEnvelope);
  assertBindingError(
    missingReport,
    "final attempt observation",
    "observation-missing",
  );
  assertVitestDiagnostics(missingReport, 1, 2);
  const retryTestId = JSON.stringify([
    "test/missing-final-observation.test.mts",
    "final pass missing observation",
  ]);
  const retryRead = {
    runId: "final attempt observation",
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
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(missingUpdate.code, 1, missingUpdate.stderr);
  assert.equal(parseEnvelope(missingUpdate.stdout).variant, "rejected");
  assertBindingError(
    requireReport(parseEnvelope(missingUpdate.stdout)),
    "final attempt observation",
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
    ["check", "--config", "final-failure.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(finalFailure.code, 1, finalFailure.stderr);
  const finalFailureEnvelope = parseEnvelope(finalFailure.stdout);
  assert.equal(finalFailureEnvelope.variant, "errors", finalFailure.stdout);
  const finalFailureReport = requireReport(finalFailureEnvelope);
  assertBindingError(
    finalFailureReport,
    "final failure observation",
    "test-failed",
  );
  assertVitestDiagnostics(finalFailureReport, 1, 2, 1);
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

  const duplicate = await runDock(
    dock,
    [
      "check",
      "--config",
      "duplicate-observation.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(duplicate.code, 1, duplicate.stderr);
  const duplicateEnvelope = parseEnvelope(duplicate.stdout);
  assert.equal(duplicateEnvelope.variant, "errors");
  assertBindingError(
    requireReport(duplicateEnvelope),
    "duplicate observation",
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
      "--output",
      "structured",
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
    "read reference business-text-source",
    "Vitest run file read business observation",
    "business text observation",
    "attempt 1",
    '"changed"',
    "read-target.txt:21-28",
  ]) {
    assert.ok(
      text.stdout.includes(fragment),
      `Text report is missing ${fragment}:\n${text.stdout}`,
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
  const firstRunDiagnostic = vitestRuns(firstReport)[0];
  assert.ok(firstRunDiagnostic);
  assert.equal(
    firstRunDiagnostic.identity,
    "passing and extra failure in same run",
  );
  assert.equal(firstRunDiagnostic.tests.length, 2);
  assert.equal(firstRunDiagnostic.tests[0]?.attemptCount, 2);
  assert.equal(firstRunDiagnostic.failures.length, 1);
  assert.equal(firstRunDiagnostic.failures[0]?.status, "failed");
  assert.match(
    firstRunDiagnostic.failures[0]?.message ?? "",
    /same-named undeclared additional test failed/,
  );
  const firstDiagnosticText = firstReport.pluginDiagnostics
    .find(({ pluginId }) => pluginId === "@ykdz/dock-reference-vitest")
    ?.text.join("\n");
  assert.match(firstDiagnosticText ?? "", /native command exited with code 1/);
  assert.match(
    firstDiagnosticText ?? "",
    /same-named undeclared additional test failed/,
  );

  const update = await runDock(
    dock,
    ["baseline", "update", ...arguments_],
    consumer,
  );
  assert.equal(update.code, 0, update.stderr);
  const updated = parseEnvelope(update.stdout);
  assert.equal(updated.variant, "updated", update.stdout);
  const updateReport = requireReport(updated);
  assertBindingHasNoErrors(updateReport, "passing status");
  assertVitestDiagnostics(updateReport, 1, 5, 1);
  const baselineBytes = await readFile(baselinePath);
  await assert.rejects(access(join(consumer, "happy.baseline.json")), {
    code: "ENOENT",
  });

  const current = await runDock(dock, ["check", ...arguments_], consumer);
  assert.equal(current.code, 0, current.stderr);
  const checked = parseEnvelope(current.stdout);
  assert.equal(checked.variant, "consistent", current.stdout);
  assertBindingHasNoErrors(requireReport(checked), "passing status");
  assertVitestDiagnostics(requireReport(checked), 1, 5, 1);
  assert.deepEqual(await readFile(baselinePath), baselineBytes);

  const textCheck = await runDock(
    dock,
    ["check", "--config", "happy.config.mts"],
    consumer,
  );
  assert.equal(textCheck.code, 0, `${textCheck.stdout}\n${textCheck.stderr}`);
  assert.match(textCheck.stdout, /native command exited with code 1/);
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
  assert.equal(parseEnvelope(initial.stdout).variant, "updated");
  const initialReport = requireReport(parseEnvelope(initial.stdout));
  assertBindingHasNoErrors(initialReport, "preview group");
  assertBindingHasNoErrors(initialReport, "empty group");
  assertBindingHasNoErrors(initialReport, "all preview members");
  const allPreviewMembers = initialReport.bindings.find(
    (binding) => binding.bindingId === "all preview members",
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
  assertVitestDiagnostics(initialReport, 1, 4);
  let baselineBytes = await readFile(baselinePath);

  const stable = await runDock(
    dock,
    ["check", "--config", "groups.config.mts", "--output", "structured"],
    consumer,
    variant,
  );
  assert.equal(stable.code, 0, `${stable.stdout}\n${stable.stderr}`);
  assert.equal(parseEnvelope(stable.stdout).variant, "consistent");
  assertVitestDiagnostics(requireReport(parseEnvelope(stable.stdout)), 1, 4);

  const changed = await runDock(
    dock,
    ["check", "--config", "groups.config.mts", "--output", "structured"],
    consumer,
    { DOCK_VITEST_GROUP_VARIANT: "changed" },
  );
  assert.equal(changed.code, 1, `${changed.stdout}\n${changed.stderr}`);
  assert.equal(parseEnvelope(changed.stdout).variant, "changed");
  const changedReport = requireReport(parseEnvelope(changed.stdout));
  assertBindingHasNoErrors(changedReport, "preview group");
  assertVitestDiagnostics(changedReport, 1, 4);
  const changedFact = changedReport.bindings
    .find((binding) => binding.bindingId === "preview group")
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
    [
      "baseline",
      "update",
      "--config",
      "groups.config.mts",
      "--output",
      "structured",
    ],
    consumer,
    { DOCK_VITEST_GROUP_VARIANT: "changed" },
  );
  assert.equal(changedUpdate.code, 0, changedUpdate.stderr);
  assert.equal(parseEnvelope(changedUpdate.stdout).variant, "updated");
  assertVitestDiagnostics(
    requireReport(parseEnvelope(changedUpdate.stdout)),
    1,
    4,
  );
  baselineBytes = await readFile(baselinePath);

  const renamed = await runDock(
    dock,
    ["check", "--config", "groups.config.mts", "--output", "structured"],
    consumer,
    { DOCK_VITEST_GROUP_VARIANT: "renamed" },
  );
  assert.equal(renamed.code, 1, `${renamed.stdout}\n${renamed.stderr}`);
  assert.equal(parseEnvelope(renamed.stdout).variant, "changed");
  const renamedReport = requireReport(parseEnvelope(renamed.stdout));
  assertBindingHasNoErrors(renamedReport, "preview group");
  assertVitestDiagnostics(renamedReport, 1, 4);
  const renamedFact = renamedReport.bindings
    .find((binding) => binding.bindingId === "preview group")
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
    [
      "baseline",
      "update",
      "--config",
      "groups.config.mts",
      "--output",
      "structured",
    ],
    consumer,
    { DOCK_VITEST_GROUP_VARIANT: "renamed" },
  );
  assert.equal(renamedUpdate.code, 0, renamedUpdate.stderr);
  assert.equal(parseEnvelope(renamedUpdate.stdout).variant, "updated");
  const renamedCheck = await runDock(
    dock,
    ["check", "--config", "groups.config.mts", "--output", "structured"],
    consumer,
    { DOCK_VITEST_GROUP_VARIANT: "renamed" },
  );
  assert.equal(
    renamedCheck.code,
    0,
    `${renamedCheck.stdout}\n${renamedCheck.stderr}`,
  );
  assert.equal(parseEnvelope(renamedCheck.stdout).variant, "consistent");
  assertVitestDiagnostics(
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
  assert.equal(
    sharedUpdate.code,
    0,
    `${sharedUpdate.stdout}\n${sharedUpdate.stderr}`,
  );
  assert.equal(parseEnvelope(sharedUpdate.stdout).variant, "updated");
  const sharedReport = requireReport(parseEnvelope(sharedUpdate.stdout));
  assertBindingHasNoErrors(sharedReport, "group and single test shared");
  assertVitestDiagnostics(sharedReport, 1, 2);
  await assert.rejects(access(groupMarker), { code: "ENOENT" });
  await rm(groupMarker, { force: true });
  const sharedCheck = await runDock(
    dock,
    ["check", "--config", "groups-shared.config.mts", "--output", "structured"],
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
  assertVitestDiagnostics(
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
    [
      "baseline",
      "update",
      "--config",
      "groups-shared.config.mts",
      "--output",
      "structured",
    ],
    consumer,
    additionalEnvironment,
  );
  assert.equal(
    additionalUpdate.code,
    0,
    `${additionalUpdate.stdout}\n${additionalUpdate.stderr}`,
  );
  assert.equal(parseEnvelope(additionalUpdate.stdout).variant, "updated");
  assertVitestDiagnostics(
    requireReport(parseEnvelope(additionalUpdate.stdout)),
    1,
    3,
  );
  await access(groupMarker);
  await rm(groupMarker, { force: true });
  const additionalCheck = await runDock(
    dock,
    ["check", "--config", "groups-shared.config.mts", "--output", "structured"],
    consumer,
    additionalEnvironment,
  );
  assert.equal(additionalCheck.code, 0, additionalCheck.stderr);
  assert.equal(parseEnvelope(additionalCheck.stdout).variant, "consistent");
  assertVitestDiagnostics(
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
    [
      "baseline",
      "update",
      "--config",
      "group-case.config.mts",
      "--output",
      "structured",
    ],
    consumer,
    nonprefixPattern,
  );
  assert.equal(patternUpdate.code, 0, patternUpdate.stderr);
  assert.equal(parseEnvelope(patternUpdate.stdout).variant, "updated");
  assertBindingHasNoErrors(
    requireReport(parseEnvelope(patternUpdate.stdout)),
    "configured pattern",
  );
  assertVitestDiagnostics(
    requireReport(parseEnvelope(patternUpdate.stdout)),
    1,
    1,
  );
  await assert.rejects(access(caseMarker), { code: "ENOENT" });

  const nonprefixCheck = await runDock(
    dock,
    ["check", "--config", "group-case.config.mts", "--output", "structured"],
    consumer,
    nonprefixPattern,
  );
  assert.equal(nonprefixCheck.code, 0, nonprefixCheck.stderr);
  assert.equal(parseEnvelope(nonprefixCheck.stdout).variant, "consistent");
  assertVitestDiagnostics(
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
    ["check", "--config", "group-case.config.mts", "--output", "structured"],
    consumer,
    flaggedPattern,
  );
  assert.equal(flaggedCheck.code, 0, flaggedCheck.stderr);
  assert.equal(parseEnvelope(flaggedCheck.stdout).variant, "consistent");
  assertVitestDiagnostics(
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
  assert.equal(
    collisionUpdate.code,
    0,
    `${collisionUpdate.stdout}\n${collisionUpdate.stderr}`,
  );
  assert.equal(parseEnvelope(collisionUpdate.stdout).variant, "updated");
  const collisionReport = requireReport(parseEnvelope(collisionUpdate.stdout));
  assertBindingHasNoErrors(collisionReport, "same flattened title groups");
  assertVitestDiagnostics(collisionReport, 1, 2);
  const collisionBinding = collisionReport.bindings.find(
    (binding) => binding.bindingId === "same flattened title groups",
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
    [
      "check",
      "--config",
      "group-collision.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(collisionCheck.code, 0, collisionCheck.stderr);
  assert.equal(parseEnvelope(collisionCheck.stdout).variant, "consistent");
  assertVitestDiagnostics(
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
  assert.equal(parseEnvelope(ambiguousSingle.stdout).variant, "errors");
  assertBindingError(
    requireReport(parseEnvelope(ambiguousSingle.stdout)),
    "title matching multiple paths",
    "duplicate-test-identity",
  );
  assertVitestDiagnostics(
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
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(ambiguousUpdate.code, 1, ambiguousUpdate.stderr);
  assert.equal(parseEnvelope(ambiguousUpdate.stdout).variant, "rejected");
  assertBindingError(
    requireReport(parseEnvelope(ambiguousUpdate.stdout)),
    "title matching multiple paths",
    "duplicate-test-identity",
  );
  await assert.rejects(access(ambiguousBaseline), { code: "ENOENT" });

  const failureBytes = await readFile(baselinePath);
  const invalid = await runDock(
    dock,
    [
      "check",
      "--config",
      "group-failures.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(invalid.code, 1, `${invalid.stdout}\n${invalid.stderr}`);
  const invalidEnvelope = parseEnvelope(invalid.stdout);
  assert.equal(invalidEnvelope.variant, "errors");
  const invalidReport = requireReport(invalidEnvelope);
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
  assertVitestDiagnostics(invalidReport, 1, 3);

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
  assert.equal(
    invalidUpdate.code,
    1,
    `${invalidUpdate.stdout}\n${invalidUpdate.stderr}`,
  );
  assert.equal(parseEnvelope(invalidUpdate.stdout).variant, "rejected");
  assertBindingError(
    requireReport(parseEnvelope(invalidUpdate.stdout)),
    "group with errors and valid single test",
    "observation-missing",
  );
  assertBindingError(
    requireReport(parseEnvelope(invalidUpdate.stdout)),
    "group with errors and valid single test",
    "observation-duplicate",
  );
  assert.deepEqual(await readFile(baselinePath), failureBytes);

  const filtered = await runDock(
    dock,
    ["check", "--config", "group-filter.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(filtered.code, 1, `${filtered.stdout}\n${filtered.stderr}`);
  const filteredReport = requireReport(parseEnvelope(filtered.stdout));
  assertBindingError(filteredReport, "filtered group", "test-skipped");
  assertVitestDiagnostics(filteredReport, 1, 1);
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
  const missingSuiteUpdate = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "group-missing-suite.config.mts",
      "--output",
      "structured",
    ],
    consumer,
  );
  assert.equal(missingSuiteUpdate.code, 1, missingSuiteUpdate.stderr);
  assert.equal(parseEnvelope(missingSuiteUpdate.stdout).variant, "rejected");
  assert.deepEqual(await readFile(baselinePath), failureBytes);

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
  assert.equal(
    collectionError.code,
    1,
    `${collectionError.stdout}\n${collectionError.stderr}`,
  );
  assertBindingError(
    requireReport(parseEnvelope(collectionError.stdout)),
    "collection failed group",
    "run-lifecycle-failed",
  );
  const collectionErrorUpdate = await runDock(
    dock,
    [
      "baseline",
      "update",
      "--config",
      "group-collection-error.config.mts",
      "--output",
      "structured",
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
  assert.equal(parseEnvelope(initial.stdout).variant, "updated");
  const baselineBytes = await readFile(baselinePath);
  const statuses = await runDock(
    dock,
    ["check", "--config", "statuses.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(statuses.code, 1, statuses.stderr);
  const statusEnvelope = parseEnvelope(statuses.stdout);
  assert.equal(statusEnvelope.variant, "errors");
  const statusReport = requireReport(statusEnvelope);
  assertBindingError(statusReport, "skipped status", "test-skipped");
  assertBindingError(statusReport, "todo status", "test-todo");
  assertBindingError(
    statusReport,
    "dynamically skipped status",
    "test-skipped",
  );
  assertBindingError(statusReport, "missing status", "test-not-executed");
  assertVitestDiagnostics(statusReport, 1, 1);

  const failure = await runDock(
    dock,
    ["check", "--config", "failure.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(failure.code, 1, failure.stderr);
  const failureEnvelope = parseEnvelope(failure.stdout);
  assert.equal(failureEnvelope.variant, "errors");
  const failureReport = requireReport(failureEnvelope);
  assertBindingError(failureReport, "failure status", "test-failed");
  assertVitestDiagnostics(failureReport, 1, 2, 1);

  for (const [config, bindingId, code] of [
    ["statuses.config.mts", "skipped status", "test-skipped"],
    ["failure.config.mts", "failure status", "test-failed"],
  ] as const) {
    const update = await runDock(
      dock,
      ["baseline", "update", "--config", config, "--output", "structured"],
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
  const checkEnvelope = parseEnvelope(check.stdout);
  assert.equal(checkEnvelope.variant, "errors", check.stdout);
  const checkReport = requireReport(checkEnvelope);
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
  const updateEnvelope = parseEnvelope(update.stdout);
  assert.equal(updateEnvelope.variant, "rejected", update.stdout);
  assertBindingError(
    requireReport(updateEnvelope),
    "shared teardown status",
    "run-lifecycle-failed",
  );
  assertVitestDiagnostics(requireReport(updateEnvelope), 1, 3, 1);
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
  const envelope = parseEnvelope(update.stdout);
  assert.equal(envelope.variant, "updated", update.stdout);
  const report = requireReport(envelope);
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
  assert.equal(parseEnvelope(initial.stdout).variant, "updated");
  const baselineBytes = await readFile(baselinePath);
  const filtered = await runDock(
    dock,
    ["check", "--config", "filter.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(filtered.code, 1, filtered.stderr);
  const filteredEnvelope = parseEnvelope(filtered.stdout);
  assert.equal(filteredEnvelope.variant, "errors");
  const filteredReport = requireReport(filteredEnvelope);
  assertBindingHasNoErrors(filteredReport, "retained status");
  assertBindingHasSomeError(filteredReport, "filtered status");
  assertVitestDiagnostics(filteredReport, 1, 1);

  const duplicate = await runDock(
    dock,
    ["check", "--config", "duplicate.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(duplicate.code, 1, duplicate.stderr);
  const duplicateEnvelope = parseEnvelope(duplicate.stdout);
  assert.equal(duplicateEnvelope.variant, "errors");
  const duplicateReport = requireReport(duplicateEnvelope);
  assertBindingError(
    duplicateReport,
    "ambiguous status",
    "duplicate-test-identity",
  );
  assertVitestDiagnostics(duplicateReport, 1, 2);

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
  assert.equal(parseEnvelope(initial.stdout).variant, "updated");
  const baselineBytes = await readFile(baselinePath);
  const check = await runDock(
    dock,
    ["check", "--config", "conflict.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(check.code, 1, check.stderr);
  assert.equal(parseEnvelope(check.stderr).data?.code, "plugin-prepare-failed");
  await assert.rejects(access(marker), { code: "ENOENT" });

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
  version: (typeof versions)[number],
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
  assert.equal(parseEnvelope(initial.stdout).variant, "updated");
  const baselineBytes = await readFile(baselinePath);
  for (const [config, bindingId, testExecutions, failedCommands] of [
    [
      "close-failure.config.mts",
      "teardown status",
      1,
      version === "5.0.3" ? 1 : 0,
    ],
    ["unhandled.config.mts", "unhandled error", 1, 1],
    ["interrupted.config.mts", "interrupted status", 0, 1],
    ["abnormal-exit.config.mts", "abnormal exit status", 0, 1],
  ] as const) {
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
    assert.equal(
      envelope.variant,
      "errors",
      `${config}\n${check.stdout}\n${check.stderr}`,
    );
    const report = requireReport(envelope);
    assertBindingError(report, bindingId, "run-lifecycle-failed");
    assertVitestDiagnostics(report, 1, testExecutions, failedCommands);
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
  assert.equal(
    passing.code,
    0,
    `Ordinary Vitest CLI pass semantics changed:\n${passing.stdout}\n${passing.stderr}`,
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
    `Ordinary Vitest CLI fail semantics changed:\n${failing.stdout}\n${failing.stderr}`,
  );
}

async function verifyDependencyBoundaries(consumer: string): Promise<void> {
  const listing = await run(
    "npm",
    ["ls", "--all", "--json", "--prefix", consumer],
    consumer,
  );
  assert.equal(listing.code, 0, listing.stderr);
  const names = collectInstalledPackageNames(
    JSON.parse(listing.stdout) as unknown,
  );
  for (const legacy of [
    "@ykdz/dock-core",
    "@ykdz/dock-reference-file",
    "@ykdz/dock-reference-markdown",
    "@ykdz/dock-reference-typescript",
    "@ykdz/dock-reference-node-test",
    "@ykdz/dock-reference-vitest",
  ]) {
    assert.equal(
      names.has(legacy),
      false,
      `Installed @ykdz/dock must not depend on legacy package ${legacy}.`,
    );
  }
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
  const envelope = JSON.parse(output) as CliEnvelope;
  assert.equal(envelope.schemaVersion, "3", output);
  assert.equal(envelope.outputMode, "structured", output);
  return envelope;
}

function requireReport(envelope: CliEnvelope): MaintenanceReport {
  assert.ok(envelope.data?.report !== undefined);
  return envelope.data.report as MaintenanceReport;
}

function vitestRuns(report: MaintenanceReport): readonly VitestRunDiagnostic[] {
  const diagnostics = report.pluginDiagnostics.find(
    ({ pluginId }) => pluginId === "@ykdz/dock-reference-vitest",
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
      testExecutions: runs.reduce((total, run) => total + run.testAttempts, 0),
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

function assertScopeDefinitionChange(
  output: string,
  referenceId: string,
): void {
  const report = requireReport(parseEnvelope(output));
  assert.deepEqual(report.scope, ["scope-vitest-policy"]);
  const binding = report.bindings.find(
    (candidate) => candidate.bindingId === "scope-vitest-policy",
  );
  assert.ok(binding, "Missing Vitest scope binding");
  assert.ok(
    binding.changes?.some(
      (change) =>
        change.kind === "reference-definition" &&
        change.referenceId === referenceId,
    ),
    `Target file reassignment did not report reference-definition change: ${JSON.stringify(binding.changes)}`,
  );
  assertBindingHasNoErrors(report, "scope-vitest-policy");
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
