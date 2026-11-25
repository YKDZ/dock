import assert from "node:assert/strict";
import {
  access,
  copyFile,
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

import {
  assertForbiddenDependencies,
  dockBin,
  hostCompiler,
  installConsumer,
  isRecord,
  packageDirectory,
  parseEnvelope,
  run,
  type CliEnvelope,
  type ProcessResult,
} from "./verify-installed-shared.ts";

type MaintenanceReport = {
  readonly scope?: readonly string[];
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
    readonly consistency?: string;
    readonly untracked?: boolean;
    readonly current?: {
      readonly references: Record<
        string,
        {
          readonly value: unknown;
          readonly range?: {
            readonly path: string;
            readonly start: number;
            readonly end: number;
          };
        }
      >;
    };
    readonly errors?: readonly {
      readonly referenceId?: string;
      readonly memberId?: string;
      readonly code: string;
      readonly message?: string;
    }[];
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

type NodeRunDiagnostic = {
  readonly identity: string;
  readonly configuration: {
    readonly files: readonly string[];
  };
  readonly commandAttempts: number;
  readonly failedCommands: number;
  readonly testExecutions: number;
  readonly failures: readonly {
    readonly id: string;
    readonly status: string;
    readonly message?: string;
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

const fixturesRoot = join(packageDirectory, "fixtures", "installed-consumer");
const forbiddenBasePackages = [
  "typescript-7",
  "vitest",
  "@vitest/runner",
  "@dock/core",
  "@dock/host",
  "@dock/text-selection",
  "@dock/file",
  "@dock/markdown",
  "@dock/typescript",
  "@dock/vitest",
  "@dock/node-test",
  "@ykdz/dock-core",
  "@ykdz/dock-reference-file",
  "@ykdz/dock-reference-markdown",
  "@ykdz/dock-reference-typescript",
  "@ykdz/dock-reference-node-test",
  "@ykdz/dock-reference-vitest",
  "remark",
  "markdown-it",
] as const;

/**
 * Verifies all non-Vitest installed consumer behaviors in a single base environment
 * (Environment A: primary + secondary physical installations without Vitest).
 */
export async function verifyInstalledBase(dockTarball: string): Promise<void> {
  assert.equal(
    process.version,
    "v26.13.1",
    "Node test installed verification requires Node v26.13.1.",
  );
  const tarball = resolve(process.cwd(), dockTarball);
  await access(tarball);

  const temporary = await mkdtemp(join(tmpdir(), "dock-base-installed-"));
  const primary = join(temporary, "primary");
  const secondary = join(temporary, "secondary");
  try {
    await installConsumer(primary, [tarball], "dock-base-consumer");
    await installConsumer(secondary, [tarball], "dock-base-secondary-consumer");

    await verifyBaseEnvironmentMetadata(primary, secondary);

    const scenarios: readonly [string, (dir: string) => Promise<void>][] = [
      ["missing-optional-vitest-peer", verifyMissingVitestPeerBehavior],
      ["host-public-and-dual-install", verifyHostPublicAndDualInstall],
      ["file-public-and-current-config", verifyFilePublicAndCurrentConfig],
      ["cli-contract-and-static-plugins", verifyCliAndStaticPlugins],
      ["node-test-real-processes", verifyNodeTestRealProcesses],
      ["legacy-v2-hard-migration", verifyLegacyBaselineHardMigration],
      ["v3-baseline-diagnostics", verifyV3BaselineDiagnostics],
    ];

    for (const [index, [name, verify]] of scenarios.entries()) {
      const scenario = join(temporary, `scenario-${index}`);
      await mkdir(scenario, { recursive: true });
      await symlink(
        join(primary, "node_modules"),
        join(scenario, "node_modules"),
        "dir",
      );
      await mkdir(join(scenario, "secondary"), { recursive: true });
      await symlink(
        join(secondary, "node_modules"),
        join(scenario, "secondary", "node_modules"),
        "dir",
      );
      try {
        await verify(scenario);
      } catch (error) {
        throw new Error(
          `Base installed scenario "${name}" failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
          { cause: error },
        );
      } finally {
        await rm(scenario, { recursive: true, force: true });
      }
    }

    process.stdout.write(
      "Base installed consumer (host, core, file, markdown, typescript, node-test, CLI, missing vitest peer, dual installs, and v2 migration) passed.\n",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function verifyBaseEnvironmentMetadata(
  primary: string,
  secondary: string,
): Promise<void> {
  const [primaryHost, secondaryHost] = await Promise.all([
    realpath(join(primary, "node_modules", "@ykdz", "dock")),
    realpath(join(secondary, "node_modules", "@ykdz", "dock")),
  ]);
  assert.notEqual(
    primaryHost,
    secondaryHost,
    "Dual-install verification must resolve two separate physical @ykdz/dock copies.",
  );

  const [primaryPkg, secondaryPkg, bundledTs] = await Promise.all([
    readFile(join(primaryHost, "package.json"), "utf8"),
    readFile(join(secondaryHost, "package.json"), "utf8"),
    readFile(
      join(primary, "node_modules", "typescript", "package.json"),
      "utf8",
    ),
  ]);
  const primaryManifest = JSON.parse(primaryPkg) as {
    readonly version: string;
    readonly exports?: Record<string, unknown>;
  };
  const secondaryManifest = JSON.parse(secondaryPkg) as {
    readonly version: string;
  };
  assert.equal(primaryManifest.version, secondaryManifest.version);
  assert.equal(
    (JSON.parse(bundledTs) as { readonly version?: unknown }).version,
    "5.9.3",
  );
  const subpaths = Object.keys(primaryManifest.exports ?? {});
  for (const subpath of [
    ".",
    "./core",
    "./markdown",
    "./typescript",
    "./node-test",
    "./vitest",
  ]) {
    assert.ok(
      subpaths.includes(subpath),
      `Installed @ykdz/dock is missing expected subpath ${subpath}.`,
    );
  }

  await assert.rejects(access(join(primary, "node_modules", "vitest")), {
    code: "ENOENT",
  });
  await assertForbiddenDependencies(
    primary,
    forbiddenBasePackages,
    "Base installed @ykdz/dock consumer",
  );

  const versionResult = await run(dockBin(primary), ["--version"], primary);
  assert.equal(versionResult.code, 0, versionResult.stderr);
  assert.equal(versionResult.stdout.trim(), primaryManifest.version);
}

async function verifyMissingVitestPeerBehavior(
  scenario: string,
): Promise<void> {
  await writeFile(join(scenario, "sample.txt"), "status: ready\n", "utf8");
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
    `  assertBaseline,`,
    `  assertJsonValue,`,
    `  BaselineValidationError,`,
    `  canonicalJson,`,
    `  check as checkCore,`,
    `  cstToJsonValue,`,
    `  isJsonValue,`,
    `  JsonSyntaxError,`,
    `  parseBaselineJson,`,
    `  parseJsonDocument,`,
    `  updateBaseline as updateCoreBaseline,`,
    `  type Baseline,`,
    `  type CheckError,`,
    `  type CheckReport as CoreCheckReport,`,
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
    `const coreBaseline: Baseline = { version: 3, bindings: {} };`,
    `assertBaseline(coreBaseline);`,
    `assertJsonValue(coreResult);`,
    `const typedCoreReport: CoreCheckReport = coreResult;`,
    `const typedCoreError: CheckError = { code: "read-failed", message: "missing" };`,
    `void valueCheck; void typedConfig; void typedCoreReport; void typedCoreError;`,
    `void check; void inspect; void readReference; void updateBaseline;`,
    `void canonicalJson; void isJsonValue; void updateCoreBaseline;`,
    `void parseJsonDocument; void cstToJsonValue; void parseBaselineJson;`,
    `void JsonSyntaxError; void BaselineValidationError;`,
    `void markdownPluginId; void typescriptPluginId; void nodeTestPluginId;`,
    `export type { CheckReport };`,
  ];
  await writeFile(join(scenario, "no-vitest.mts"), typecheckLines.join("\n"));
  await writeFile(
    join(scenario, "tsconfig.json"),
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

  const typecheck = await run(
    hostCompiler,
    ["-p", join(scenario, "tsconfig.json"), "--pretty", "false"],
    scenario,
  );
  assert.equal(
    typecheck.code,
    0,
    `Consumer tsc without Vitest failed:\n${typecheck.stdout}\n${typecheck.stderr}`,
  );

  await writeFile(
    join(scenario, "runtime.mjs"),
    [
      `import assert from "node:assert/strict";`,
      `import { binding, check, defineConfig, file, inspect, readReference, updateBaseline } from "@ykdz/dock";`,
      `import { assertBaseline, assertJsonValue, canonicalJson, check as checkCore, isJsonValue, updateBaseline as updateCoreBaseline } from "@ykdz/dock/core";`,
      `import { markdown, markdownPluginId } from "@ykdz/dock/markdown";`,
      `import { typescript, typescriptPluginId } from "@ykdz/dock/typescript";`,
      `import { nodeTest, nodeTestPluginId } from "@ykdz/dock/node-test";`,
      `import { defineVitestRun, vitest, vitestPluginId, vitestStatus } from "@ykdz/dock/vitest";`,
      ``,
      `const doc = file.from("sample.txt").match("status: ([^\\\\n]+)", 1).reference("doc-status");`,
      `const nonVitestConfig = defineConfig({ plugins: [file, markdown, typescript, nodeTest], bindings: [binding("doc", [doc])] });`,
      `const read = await readReference(nonVitestConfig, doc);`,
      `assert.equal(read.value, "ready");`,
      `assert.equal((await inspect(nonVitestConfig)).plugins.length, 4);`,
      `assert.equal((await check(nonVitestConfig)).bindings[0]?.changes.length, 1);`,
      `assert.equal((await updateBaseline(nonVitestConfig)).status, "updated");`,
      `assert.equal((await check(nonVitestConfig)).bindings[0]?.changes.length, 0);`,
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
      `assert.equal(coreCheck.bindings[0]?.consistency, "consistent");`,
      `assert.equal(coreCheck.bindings[0]?.changes.length, 0);`,
      `const coreDrift = checkCore({`,
      `  baseline: coreUpdate.baseline,`,
      `  references: [{ id: "r", target: { path: "sample.txt" } }],`,
      `  bindings: [{ id: "b", references: ["r"] }],`,
      `  facts: [{ referenceId: "r", value: "drifted" }],`,
      `});`,
      `assert.equal(coreDrift.bindings[0]?.consistency, "inconsistent");`,
      `assert.equal(coreDrift.bindings[0]?.changes[0]?.kind, "fact");`,
      `const coreErrorCheck = checkCore({`,
      `  baseline: coreUpdate.baseline,`,
      `  references: [{ id: "r", target: { path: "sample.txt" } }],`,
      `  bindings: [{ id: "b", references: ["r"] }],`,
      `  facts: [{ referenceId: "r", error: { code: "read-failed", message: "missing source" } }],`,
      `});`,
      `assert.equal(Boolean(coreErrorCheck.bindings[0] && "errors" in coreErrorCheck.bindings[0]), true);`,
      `if (coreErrorCheck.bindings[0] && "errors" in coreErrorCheck.bindings[0]) {`,
      `  assert.equal(coreErrorCheck.bindings[0].errors[0]?.code, "read-failed");`,
      `}`,
      `const coreRejected = updateCoreBaseline({`,
      `  baseline: coreUpdate.baseline,`,
      `  references: [{ id: "r", target: { path: "sample.txt" } }],`,
      `  bindings: [{ id: "b", references: ["r"] }],`,
      `  facts: [{ referenceId: "r", error: { code: "read-failed", message: "missing source" } }],`,
      `});`,
      `assert.equal(coreRejected.status, "rejected");`,
      `const existingV3Baseline = {`,
      `  version: 3,`,
      `  bindings: {`,
      `    b: {`,
      `      definition: { id: "b", references: ["r"] },`,
      `      references: {`,
      `        r: { definition: { id: "r", target: { path: "sample.txt" } }, value: "ready" },`,
      `      },`,
      `    },`,
      `  },`,
      `};`,
      `assertBaseline(existingV3Baseline);`,
      `assertJsonValue(existingV3Baseline);`,
      `const v3CompatCheck = checkCore({`,
      `  baseline: existingV3Baseline,`,
      `  references: [{ id: "r", target: { path: "sample.txt" } }],`,
      `  bindings: [{ id: "b", references: ["r"] }],`,
      `  facts: [{ referenceId: "r", value: "ready" }],`,
      `});`,
      `assert.equal(v3CompatCheck.bindings[0]?.consistency, "consistent");`,
      `assert.equal(markdown.id, markdownPluginId);`,
      `assert.equal(typescript.id, typescriptPluginId);`,
      `assert.equal(nodeTest.id, nodeTestPluginId);`,
      `assert.equal(vitest.id, vitestPluginId);`,
      ``,
      `const vRun = defineVitestRun("missing-peer", { files: ["sample.test.ts"] });`,
      `const vConfig = defineConfig({`,
      `  baseline: "vitest-missing.baseline.json",`,
      `  plugins: [vitest],`,
      `  bindings: [binding("vitest-binding", [vitestStatus("v-status", vRun, { file: "sample.test.ts", name: "sample" })])],`,
      `});`,
      `const vInspected = await inspect(vConfig);`,
      `assert.equal(vInspected.plugins[0]?.id, vitestPluginId);`,
      `const vReport = await check(vConfig);`,
      `const vBinding = vReport.bindings.find((entry) => entry.bindingId === "vitest-binding");`,
      `assert.ok(vBinding && "errors" in vBinding && vBinding.errors?.[0], JSON.stringify(vReport));`,
      `assert.equal(vBinding.errors[0].code, "run-lifecycle-failed");`,
      `assert.match(vBinding.errors[0].message, /vitest/iu);`,
    ].join("\n"),
  );
  const runtime = await run(
    process.execPath,
    [join(scenario, "runtime.mjs")],
    scenario,
  );
  assert.equal(
    runtime.code,
    0,
    `Consumer runtime without Vitest failed:\n${runtime.stdout}\n${runtime.stderr}`,
  );
}

async function verifyHostPublicAndDualInstall(scenario: string): Promise<void> {
  const hostFixtures = join(fixturesRoot, "host");
  await cp(hostFixtures, scenario, {
    recursive: true,
    filter: (source) => !source.endsWith("node_modules"),
  });

  const typecheck = await run(
    hostCompiler,
    ["-p", join(scenario, "tsconfig.json"), "--pretty", "false"],
    scenario,
  );
  assert.equal(
    typecheck.code,
    0,
    `Host installed public type checks failed:\n${typecheck.stdout}\n${typecheck.stderr}`,
  );

  for (const fixture of [
    "batch-runtime.mjs",
    "core-independence.mjs",
    "external-plugin-consumer.mts",
    "physical-multiversion.mts",
  ]) {
    const runtime = await run(
      process.execPath,
      [join(scenario, fixture)],
      scenario,
    );
    assert.equal(
      runtime.code,
      0,
      `Host installed runtime verification failed for ${fixture}:\n${runtime.stdout}\n${runtime.stderr}`,
    );
  }
}

async function verifyFilePublicAndCurrentConfig(
  scenario: string,
): Promise<void> {
  const fileFixtures = join(fixturesRoot, "file");
  await cp(fileFixtures, scenario, {
    recursive: true,
    filter: (source) => !source.endsWith("node_modules"),
  });

  for (const configName of ["tsconfig.json", "text-read-tsconfig.json"]) {
    const typecheck = await run(
      hostCompiler,
      ["-p", join(scenario, configName), "--pretty", "false"],
      scenario,
    );
    assert.equal(
      typecheck.code,
      0,
      `File installed type checks (${configName}) failed:\n${typecheck.stdout}\n${typecheck.stderr}`,
    );
  }

  for (const [fixture, label] of [
    ["composition-consumer.mts", "split declarations and plugin dispatch"],
    ["inspect-runtime.mjs", "unified inspect and core model replay"],
    ["public-api-consumer.mjs", "public maintenance round-trip"],
  ] as const) {
    const runtime = await run(
      process.execPath,
      [join(scenario, fixture)],
      scenario,
    );
    assert.equal(
      runtime.code,
      0,
      `File installed runtime failed (${label}):\n${runtime.stdout}\n${runtime.stderr}`,
    );
  }

  await writeFile(
    join(scenario, "guide.md"),
    "😀说明\n<!-- 原文注释保留 -->\n#region runtime\nport=4173\n#endregion runtime\n",
    "utf8",
  );
  const textRead = await run(
    process.execPath,
    [
      join(scenario, "text-read-runtime.mjs"),
      "4173",
      String(
        "😀说明\n<!-- 原文注释保留 -->\n#region runtime\nport=4173\n#endregion runtime\n".indexOf(
          "4173",
        ),
      ),
    ],
    scenario,
  );
  assert.equal(
    textRead.code,
    0,
    `File text-read runtime failed:\n${textRead.stdout}\n${textRead.stderr}`,
  );

  // Worker fresh-module-graph resolution & clean exit for current-config consumer.
  const currentConfigFixture = join(scenario, "current-config");
  const dependencyDir = join(
    currentConfigFixture,
    "node_modules",
    "current-config-declarations",
  );
  await mkdir(join(currentConfigFixture, "node_modules"), { recursive: true });
  await cp(join(fileFixtures, "current-config-dependency"), dependencyDir, {
    recursive: true,
  });
  const currentConfigResult = await run(
    process.execPath,
    [join(currentConfigFixture, "runner.mjs")],
    currentConfigFixture,
    15_000,
  );
  assert.equal(
    currentConfigResult.timedOut,
    false,
    `Current-config consumer timed out:\n${currentConfigResult.stdout}\n${currentConfigResult.stderr}`,
  );
  assert.equal(
    currentConfigResult.code,
    0,
    `Current-config consumer failed:\n${currentConfigResult.stdout}\n${currentConfigResult.stderr}`,
  );
}

async function verifyCliAndStaticPlugins(scenario: string): Promise<void> {
  const bin = dockBin(scenario);
  await verifyCliContractSmoke(bin, join(scenario, "cli-contract"));
  await verifyInstalledErrorWithConfirmedChange(
    bin,
    join(scenario, "error-with-change"),
  );
  await verifyInstalledFileSmoke(bin, join(scenario, "file-smoke"));
  await verifyInstalledMarkdownSmoke(bin, join(scenario, "markdown-smoke"));
  await verifyInstalledTypeScriptSmoke(bin, join(scenario, "ts-smoke"));
}

async function verifyCliContractSmoke(bin: string, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });

  const help = await run(bin, ["--help"], dir);
  assert.equal(help.code, 0, help.stderr);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /\bUsage\b/);
  assert.match(help.stdout, /\bCommands\b/);
  assert.match(help.stdout, /\bOptions\b/);
  assert.doesNotMatch(help.stdout, /--json/);

  for (const argv of [
    ["check"],
    ["check", "--config", "dock.config.mjs", "--json"],
    ["check", "--config", "dock.config.mjs", "--output", "invalid"],
  ]) {
    const usageFailure = await run(bin, argv, dir);
    assert.equal(usageFailure.code, 64, usageFailure.stderr);
    assert.equal(usageFailure.stdout, "");
    const usageEnvelope = parseEnvelope(usageFailure.stderr);
    assert.equal(usageEnvelope.kind, "usageFailure");
  }

  const maintenanceFailure = await run(
    bin,
    ["check", "--config", "missing.config.mjs"],
    dir,
  );
  assert.equal(maintenanceFailure.code, 1);
  assert.equal(maintenanceFailure.stdout, "");
  assert.match(
    maintenanceFailure.stderr,
    /Maintenance failed \(config-load-failed\)/,
  );

  const maintenanceStructured = await run(
    bin,
    ["check", "--config", "missing.config.mjs", "--output", "structured"],
    dir,
  );
  assert.equal(maintenanceStructured.code, 1);
  assert.equal(maintenanceStructured.stdout, "");
  const failureEnvelope = parseEnvelope(maintenanceStructured.stderr);
  assert.equal(failureEnvelope.kind, "failure");
  assert.equal(failureEnvelope.variant, "maintenanceFailed");

  const configPath = join(dir, "dock.config.mjs");
  const factPath = join(dir, "fact.txt");
  await writeFile(factPath, "initial fact", "utf8");
  await writeFile(
    configPath,
    [
      'import { readFile } from "node:fs/promises";',
      'import { join } from "node:path";',
      'import { binding, createReference, defineConfig, definePlugin } from "@ykdz/dock";',
      "const plugin = definePlugin({",
      '  id: "fixture:cli-installed",',
      "  validate() {},",
      "  async collect(request, context) {",
      "    const results = [];",
      "    for (const reference of request.selectedReferences) {",
      "      try {",
      '        const value = await readFile(join(context.root, reference.target), "utf8");',
      '        results.push({ referenceId: reference.id, kind: "value", value, range: { path: reference.target, start: 0, end: value.length } });',
      "      } catch {",
      "        results.push({",
      "          referenceId: reference.id,",
      '          kind: "error",',
      '          error: { code: "missing-fact", message: "Missing line 1\\r\\nMissing line 2\\0" },',
      "        });",
      "      }",
      "    }",
      '    return { results, diagnostics: { data: { ok: true }, text: ["Routine collection"] } };',
      "  },",
      "});",
      "export default defineConfig({",
      "  plugins: [plugin],",
      "  bindings: [",
      '    binding("cli-policy", [',
      '      createReference("fixture:cli-installed", "fact-ref", "fact.txt"),',
      "    ]),",
      "  ],",
      "});",
    ].join("\n"),
    "utf8",
  );

  const inspectText = await run(
    bin,
    ["inspect", "--config", "dock.config.mjs"],
    dir,
  );
  assert.equal(inspectText.code, 0, inspectText.stderr);
  assert.match(inspectText.stdout, /Scope: cli-policy/);

  const inspectStructured = await run(
    bin,
    ["inspect", "--config", "dock.config.mjs", "--output", "structured"],
    dir,
  );
  assert.equal(inspectStructured.code, 0, inspectStructured.stderr);
  const inspectEnvelope = parseEnvelope(inspectStructured.stdout);
  assert.equal(inspectEnvelope.variant, "inspected");
  assert.ok(inspectEnvelope.data?.resolution);

  const changedText = await run(
    bin,
    ["check", "--config", "dock.config.mjs"],
    dir,
  );
  assert.equal(changedText.code, 1, changedText.stderr);
  assert.match(changedText.stdout, /Binding cli-policy/);
  assert.match(changedText.stdout, /fact-ref \(fact\.txt:1\)/);
  assert.match(changedText.stdout, /Change: binding added/);
  assert.doesNotMatch(changedText.stdout, /Current fact:/);
  assert.doesNotMatch(changedText.stdout, /text offset/);

  const changedStructured = await run(
    bin,
    ["check", "--config", "dock.config.mjs", "--output", "structured"],
    dir,
  );
  assert.equal(changedStructured.code, 1, changedStructured.stderr);
  assert.equal(parseEnvelope(changedStructured.stdout).variant, "changed");

  const updatedText = await run(
    bin,
    ["baseline", "update", "--config", "dock.config.mjs"],
    dir,
  );
  assert.equal(updatedText.code, 0, updatedText.stderr);
  assert.match(updatedText.stdout, /Scope: cli-policy/);
  assert.match(updatedText.stdout, /Baseline updated\./);
  assert.doesNotMatch(updatedText.stdout, /Current fact:/);

  let savedBaseline = await readFile(join(dir, "dock.baseline.json"));

  const consistentText = await run(
    bin,
    ["check", "--config", "dock.config.mjs"],
    dir,
  );
  assert.equal(consistentText.code, 0, consistentText.stderr);
  assert.equal(
    consistentText.stdout,
    "Scope: cli-policy\nAll checked bindings are consistent with baseline.\n",
  );

  const consistentStructured = await run(
    bin,
    ["check", "--config", "dock.config.mjs", "--output", "structured"],
    dir,
  );
  assert.equal(consistentStructured.code, 0, consistentStructured.stderr);
  const consistentEnvelope = parseEnvelope(consistentStructured.stdout);
  assert.equal(consistentEnvelope.variant, "consistent");
  const consistentReport = requireReport(consistentEnvelope);
  assert.equal(
    consistentReport.pluginDiagnostics[0]?.pluginId,
    "fixture:cli-installed",
  );
  assert.deepEqual(
    consistentReport.bindings[0]?.current?.references["fact-ref"]?.range,
    { path: "fact.txt", start: 0, end: "initial fact".length },
  );

  await writeFile(factPath, "updated fact", "utf8");
  const diffStructured = await run(
    bin,
    ["check", "--config", "dock.config.mjs", "--output", "structured"],
    dir,
  );
  assert.equal(diffStructured.code, 1, diffStructured.stderr);
  const diffEnvelope = parseEnvelope(diffStructured.stdout);
  assert.equal(diffEnvelope.variant, "changed");
  const diffReport = requireReport(diffEnvelope);
  assert.equal(diffReport.bindings[0]?.bindingId, "cli-policy");
  assert.equal(diffReport.bindings[0]?.changes?.[0]?.kind, "fact");
  assert.equal(diffReport.bindings[0]?.changes?.[0]?.referenceId, "fact-ref");

  const reupdatedText = await run(
    bin,
    ["baseline", "update", "--config", "dock.config.mjs"],
    dir,
  );
  assert.equal(reupdatedText.code, 0, reupdatedText.stderr);
  savedBaseline = await readFile(join(dir, "dock.baseline.json"));

  await rm(factPath);
  const errorCheck = await run(
    bin,
    ["check", "--config", "dock.config.mjs", "--output", "structured"],
    dir,
  );
  assert.equal(errorCheck.code, 1, errorCheck.stderr);
  assert.equal(parseEnvelope(errorCheck.stdout).variant, "errors");

  const rejectedUpdateText = await run(
    bin,
    ["baseline", "update", "--config", "dock.config.mjs"],
    dir,
  );
  assert.equal(rejectedUpdateText.code, 1, rejectedUpdateText.stderr);
  assert.equal(
    rejectedUpdateText.stdout.match(/Error fact-ref \(missing-fact\):/g)
      ?.length,
    1,
  );
  assert.doesNotMatch(rejectedUpdateText.stdout, /Update error/);
  assert.match(rejectedUpdateText.stdout, /Baseline was not updated\./);
  assert.deepEqual(
    await readFile(join(dir, "dock.baseline.json")),
    savedBaseline,
  );

  const rejectedStructured = await run(
    bin,
    [
      "baseline",
      "update",
      "--config",
      "dock.config.mjs",
      "--output",
      "structured",
    ],
    dir,
  );
  assert.equal(rejectedStructured.code, 1, rejectedStructured.stderr);
  const rejectedEnvelope = parseEnvelope(rejectedStructured.stdout);
  assert.equal(rejectedEnvelope.variant, "rejected");
  assert.deepEqual(rejectedEnvelope.data?.errors, []);
  assertBindingError(
    requireReport(rejectedEnvelope),
    "cli-policy",
    "missing-fact",
  );

  const emptyDir = join(dir, "empty-config");
  await mkdir(emptyDir, { recursive: true });
  const emptyConfig = join(emptyDir, "empty.config.mjs");
  await writeFile(
    emptyConfig,
    'import { defineConfig } from "@ykdz/dock";\nexport default defineConfig({ plugins: [], bindings: [] });\n',
    "utf8",
  );
  const emptyUpdateText = await run(
    bin,
    ["baseline", "update", "--config", "empty-config/empty.config.mjs"],
    dir,
  );
  assert.equal(emptyUpdateText.code, 1, emptyUpdateText.stderr);
  assert.match(emptyUpdateText.stdout, /Update error \(empty-selection\):/);
  assert.match(emptyUpdateText.stdout, /Baseline was not updated\./);

  const emptyUpdateStructured = await run(
    bin,
    [
      "baseline",
      "update",
      "--config",
      "empty-config/empty.config.mjs",
      "--output",
      "structured",
    ],
    dir,
  );
  assert.equal(emptyUpdateStructured.code, 1, emptyUpdateStructured.stderr);
  const emptyEnvelope = parseEnvelope(emptyUpdateStructured.stdout);
  assert.equal(emptyEnvelope.variant, "rejected");
  assert.equal(emptyEnvelope.data?.errors?.[0]?.code, "empty-selection");

  // Run a migrated consumer script following the upgrade guide across both JS updateBaseline() and CLI structured output.
  await writeFile(
    join(dir, "migrated-update-consumer.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { spawnSync } from "node:child_process";',
      'import { readFile } from "node:fs/promises";',
      'import { updateBaseline } from "@ykdz/dock";',
      'import { updateBaseline as updateCoreBaseline } from "@ykdz/dock/core";',
      "",
      "function summarizeUpdateOutcome(status, report, topLevelErrors) {",
      "  const bindingErrors = report.bindings.flatMap((entry) =>",
      '    "errors" in entry && Array.isArray(entry.errors)',
      "      ? entry.errors.map((error) => ({",
      "          bindingId: entry.bindingId,",
      "          referenceId: error.referenceId,",
      "          memberId: error.memberId,",
      "          code: error.code,",
      "        }))",
      "      : [],",
      "  );",
      "  return {",
      "    status,",
      "    bindingErrors,",
      "    operationErrors: topLevelErrors,",
      "  };",
      "}",
      "",
      'const baselineBytes = await readFile("dock.baseline.json");',
      'const jsMissing = await updateBaseline("dock.config.mjs");',
      'assert.equal(jsMissing.status, "rejected");',
      "const jsMissingSummary = summarizeUpdateOutcome(",
      "  jsMissing.status,",
      "  jsMissing.report,",
      "  jsMissing.errors,",
      ");",
      "assert.deepEqual(jsMissingSummary.bindingErrors, [",
      '  { bindingId: "cli-policy", referenceId: "fact-ref", memberId: undefined, code: "missing-fact" },',
      "]);",
      "assert.deepEqual(jsMissingSummary.operationErrors, []);",
      'assert.deepEqual(await readFile("dock.baseline.json"), baselineBytes);',
      "",
      `const cliMissing = spawnSync(${JSON.stringify(bin)},`,
      '  ["baseline", "update", "--config", "dock.config.mjs", "--output", "structured"],',
      '  { encoding: "utf8" },',
      ");",
      "assert.equal(cliMissing.error, undefined);",
      "assert.equal(cliMissing.status, 1, cliMissing.stderr);",
      "const cliMissingEnvelope = JSON.parse(cliMissing.stdout);",
      "const cliMissingSummary = summarizeUpdateOutcome(",
      "  cliMissingEnvelope.variant,",
      "  cliMissingEnvelope.data.report,",
      "  cliMissingEnvelope.data.errors,",
      ");",
      'assert.equal(cliMissingSummary.status, "rejected");',
      "assert.deepEqual(cliMissingSummary.bindingErrors, [",
      '  { bindingId: "cli-policy", referenceId: "fact-ref", memberId: undefined, code: "missing-fact" },',
      "]);",
      "assert.deepEqual(cliMissingSummary.operationErrors, []);",
      'assert.deepEqual(await readFile("dock.baseline.json"), baselineBytes);',
      "",
      `const cliEmpty = spawnSync(${JSON.stringify(bin)},`,
      '  ["baseline", "update", "--config", "empty-config/empty.config.mjs", "--output", "structured"],',
      '  { encoding: "utf8" },',
      ");",
      "assert.equal(cliEmpty.error, undefined);",
      "assert.equal(cliEmpty.status, 1, cliEmpty.stderr);",
      "const cliEmptyEnvelope = JSON.parse(cliEmpty.stdout);",
      "const cliEmptySummary = summarizeUpdateOutcome(",
      "  cliEmptyEnvelope.variant,",
      "  cliEmptyEnvelope.data.report,",
      "  cliEmptyEnvelope.data.errors,",
      ");",
      'assert.equal(cliEmptySummary.status, "rejected");',
      "assert.deepEqual(cliEmptySummary.bindingErrors, []);",
      "assert.equal(cliEmptySummary.operationErrors.length, 1);",
      'assert.equal(cliEmptySummary.operationErrors[0]?.code, "empty-selection");',
      'assert.deepEqual(await readFile("dock.baseline.json"), baselineBytes);',
      "",
      'const jsEmpty = await updateBaseline("empty-config/empty.config.mjs");',
      'assert.equal(jsEmpty.status, "rejected");',
      "const jsEmptySummary = summarizeUpdateOutcome(",
      "  jsEmpty.status,",
      "  jsEmpty.report,",
      "  jsEmpty.errors,",
      ");",
      "assert.deepEqual(jsEmptySummary.bindingErrors, []);",
      "assert.equal(jsEmptySummary.operationErrors.length, 1);",
      'assert.equal(jsEmptySummary.operationErrors[0]?.code, "empty-selection");',
      "",
      'const parsedSavedBaseline = JSON.parse(baselineBytes.toString("utf8"));',
      "const coreEmptyScope = updateCoreBaseline({",
      "  references: [],",
      "  bindings: [],",
      "  facts: [],",
      "  baseline: parsedSavedBaseline,",
      "  scope: [],",
      "});",
      'assert.equal(coreEmptyScope.status, "rejected");',
      "const coreEmptySummary = summarizeUpdateOutcome(",
      "  coreEmptyScope.status,",
      "  coreEmptyScope.report,",
      "  coreEmptyScope.errors,",
      ");",
      "assert.deepEqual(coreEmptySummary.bindingErrors, []);",
      "assert.equal(coreEmptySummary.operationErrors.length, 1);",
      'assert.equal(coreEmptySummary.operationErrors[0]?.code, "empty-selection");',
      'assert.deepEqual(await readFile("dock.baseline.json"), baselineBytes);',
    ].join("\n"),
    "utf8",
  );
  const migratedConsumer = await run(
    process.execPath,
    [join(dir, "migrated-update-consumer.mjs")],
    dir,
  );
  assert.equal(
    migratedConsumer.code,
    0,
    `Migrated update consumer failed:\n${migratedConsumer.stdout}\n${migratedConsumer.stderr}`,
  );
}

async function verifyInstalledErrorWithConfirmedChange(
  bin: string,
  dir: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const statePath = join(dir, "suite-state.json");
  const configPath = join(dir, "dock.config.mjs");
  const baselinePath = join(dir, "dock.baseline.json");

  await writeFile(
    statePath,
    JSON.stringify({ members: [{ id: "a", value: "ok" }] }),
    "utf8",
  );
  await writeFile(
    configPath,
    [
      'import { readFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'import { binding, createReference, defineConfig, definePlugin } from "@ykdz/dock";',
      "",
      "const suitePlugin = definePlugin({",
      '  id: "fixture:installed-suite",',
      "  validate() {},",
      "  collect(request, context) {",
      "    const state = JSON.parse(",
      '      readFileSync(join(context.root, "suite-state.json"), "utf8"),',
      "    );",
      "    return {",
      "      results: request.selectedReferences.map((reference) => ({",
      "        referenceId: reference.id,",
      '        kind: "collection",',
      "        collection: {",
      '          completeness: "complete",',
      "          members: state.members,",
      "        },",
      "      })),",
      "    };",
      "  },",
      "});",
      "",
      "export default defineConfig({",
      "  plugins: [suitePlugin],",
      "  bindings: [",
      '    binding("suite-binding", [',
      '      createReference("fixture:installed-suite", "suite-ref", "suite-state.json"),',
      "    ]),",
      "  ],",
      "});",
    ].join("\n"),
    "utf8",
  );

  const initialUpdate = await run(
    bin,
    ["baseline", "update", "--config", "dock.config.mjs"],
    dir,
  );
  assert.equal(initialUpdate.code, 0, initialUpdate.stderr);
  assert.match(initialUpdate.stdout, /Baseline updated\./);
  const savedBaseline = await readFile(baselinePath);

  await writeFile(
    statePath,
    JSON.stringify({
      members: [
        {
          id: "a",
          error: {
            code: "missing-observation",
            message: "Missing observation for A",
          },
        },
        { id: "b", value: "added-b" },
      ],
    }),
    "utf8",
  );

  const checkText = await run(
    bin,
    ["check", "--config", "dock.config.mjs"],
    dir,
  );
  assert.equal(checkText.code, 1, checkText.stderr);
  assert.equal(checkText.stderr, "");
  const checkErrorIndex = checkText.stdout.indexOf(
    "Error suite-ref / a (missing-observation): Missing observation for A",
  );
  const checkChangeIndex = checkText.stdout.indexOf(
    'Change: suite-ref member b added: "added-b"',
  );
  assert.ok(checkErrorIndex !== -1, checkText.stdout);
  assert.ok(checkChangeIndex !== -1, checkText.stdout);
  assert.ok(checkErrorIndex < checkChangeIndex, checkText.stdout);
  assert.deepEqual(await readFile(baselinePath), savedBaseline);

  const checkStructured = await run(
    bin,
    ["check", "--config", "dock.config.mjs", "--output", "structured"],
    dir,
  );
  assert.equal(checkStructured.code, 1, checkStructured.stderr);
  const checkEnvelope = parseEnvelope(checkStructured.stdout);
  assert.equal(checkEnvelope.variant, "errors");
  const checkReport = requireReport(checkEnvelope);
  assert.equal(checkReport.bindings[0]?.consistency, undefined);
  assert.equal(
    Object.hasOwn(checkReport.bindings[0] ?? {}, "consistency"),
    false,
  );
  assertBindingError(checkReport, "suite-binding", "missing-observation");
  assert.equal(checkReport.bindings[0]?.errors?.[0]?.memberId, "a");
  assert.equal(
    checkReport.bindings[0]?.changes?.[0]?.memberChanges?.[0]?.memberId,
    "b",
  );
  assert.equal(
    checkReport.bindings[0]?.changes?.[0]?.memberChanges?.[0]?.afterPresent,
    true,
  );
  assert.deepEqual(await readFile(baselinePath), savedBaseline);

  const updateText = await run(
    bin,
    ["baseline", "update", "--config", "dock.config.mjs"],
    dir,
  );
  assert.equal(updateText.code, 1, updateText.stderr);
  assert.equal(updateText.stderr, "");
  const updateErrorIndex = updateText.stdout.indexOf(
    "Error suite-ref / a (missing-observation): Missing observation for A",
  );
  const updateChangeIndex = updateText.stdout.indexOf(
    'Change: suite-ref member b added: "added-b"',
  );
  assert.ok(updateErrorIndex !== -1, updateText.stdout);
  assert.ok(updateChangeIndex !== -1, updateText.stdout);
  assert.ok(updateErrorIndex < updateChangeIndex, updateText.stdout);
  assert.equal(
    updateText.stdout.match(/Error suite-ref \/ a \(missing-observation\):/g)
      ?.length,
    1,
  );
  assert.doesNotMatch(updateText.stdout, /Update error/);
  assert.match(updateText.stdout, /Baseline was not updated\./);
  assert.deepEqual(await readFile(baselinePath), savedBaseline);

  const updateStructured = await run(
    bin,
    [
      "baseline",
      "update",
      "--config",
      "dock.config.mjs",
      "--output",
      "structured",
    ],
    dir,
  );
  assert.equal(updateStructured.code, 1, updateStructured.stderr);
  const updateEnvelope = parseEnvelope(updateStructured.stdout);
  assert.equal(updateEnvelope.variant, "rejected");
  assert.deepEqual(updateEnvelope.data?.errors, []);
  const updateReport = requireReport(updateEnvelope);
  assert.equal(updateReport.bindings[0]?.consistency, undefined);
  assert.equal(
    Object.hasOwn(updateReport.bindings[0] ?? {}, "consistency"),
    false,
  );
  assert.equal(updateReport.bindings[0]?.errors?.[0]?.memberId, "a");
  assert.equal(
    updateReport.bindings[0]?.errors?.[0]?.code,
    "missing-observation",
  );
  assert.equal(
    updateReport.bindings[0]?.changes?.[0]?.memberChanges?.[0]?.memberId,
    "b",
  );
  assert.deepEqual(await readFile(baselinePath), savedBaseline);

  await writeFile(
    join(dir, "js-error-with-change.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { readFile } from "node:fs/promises";',
      'import { check, updateBaseline } from "@ykdz/dock";',
      "",
      'const beforeBytes = await readFile("dock.baseline.json");',
      'const checked = await check("dock.config.mjs");',
      "const checkedBinding = checked.bindings[0];",
      "assert.ok(checkedBinding);",
      'assert.equal("consistency" in checkedBinding, false);',
      'assert.equal(checkedBinding.errors?.[0]?.referenceId, "suite-ref");',
      'assert.equal(checkedBinding.errors?.[0]?.memberId, "a");',
      'assert.equal(checkedBinding.errors?.[0]?.code, "missing-observation");',
      'assert.equal(checkedBinding.changes[0]?.memberChanges?.[0]?.memberId, "b");',
      "assert.equal(checkedBinding.changes[0]?.memberChanges?.[0]?.afterPresent, true);",
      "",
      'const updated = await updateBaseline("dock.config.mjs");',
      'assert.equal(updated.status, "rejected");',
      "assert.deepEqual(updated.errors, []);",
      "const updatedBinding = updated.report.bindings[0];",
      "assert.ok(updatedBinding);",
      'assert.equal("consistency" in updatedBinding, false);',
      'assert.equal(updatedBinding.errors?.[0]?.referenceId, "suite-ref");',
      'assert.equal(updatedBinding.errors?.[0]?.memberId, "a");',
      'assert.equal(updatedBinding.errors?.[0]?.code, "missing-observation");',
      'assert.equal(updatedBinding.changes[0]?.memberChanges?.[0]?.memberId, "b");',
      'assert.equal(updatedBinding.changes[0]?.memberChanges?.[0]?.after, "added-b");',
      'assert.deepEqual(await readFile("dock.baseline.json"), beforeBytes);',
    ].join("\n"),
    "utf8",
  );
  const jsErrorWithChange = await run(
    process.execPath,
    [join(dir, "js-error-with-change.mjs")],
    dir,
  );
  assert.equal(
    jsErrorWithChange.code,
    0,
    `JS error-with-change check failed:\n${jsErrorWithChange.stdout}\n${jsErrorWithChange.stderr}`,
  );
}

async function verifyInstalledFileSmoke(
  bin: string,
  dir: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await copyFile(
    join(fixturesRoot, "file", "dock.config.ts"),
    join(dir, "dock.config.ts"),
  );
  await copyFile(
    join(fixturesRoot, "file", "declarations.mjs"),
    join(dir, "declarations.mjs"),
  );
  await writeFile(join(dir, "guide.md"), "First edition body\n", "utf8");

  const initialTsCheck = await run(
    bin,
    ["check", "--config", "dock.config.ts", "--output", "structured"],
    dir,
  );
  assert.equal(initialTsCheck.code, 1, initialTsCheck.stderr);
  assert.equal(parseEnvelope(initialTsCheck.stdout).variant, "changed");

  const updated = await run(
    bin,
    [
      "baseline",
      "update",
      "--config",
      "dock.config.ts",
      "--output",
      "structured",
    ],
    dir,
  );
  assert.equal(updated.code, 0, updated.stderr);
  assert.equal(parseEnvelope(updated.stdout).variant, "updated");

  const consistent = await run(
    bin,
    ["check", "--config", "dock.config.ts"],
    dir,
  );
  assert.equal(consistent.code, 0, consistent.stderr);
  assert.equal(
    consistent.stdout,
    "Scope: guide-policy\nAll checked bindings are consistent with baseline.\n",
  );

  // Verify quote, match capture, region, processor ID, CLI source line numbers, and V3 baseline compatibility from @ykdz/dock root.
  const appEnvPath = join(dir, "app.env");
  await writeFile(
    appEnvPath,
    [
      "😀header",
      "#region runtime",
      "port=4173",
      "host=localhost",
      "#endregion runtime",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(dir, "v3-lines.config.mjs"),
    [
      'import { binding, defineConfig, file, filePluginId } from "@ykdz/dock";',
      'if (file.id !== "@ykdz/dock-reference-file" || filePluginId !== "@ykdz/dock-reference-file") {',
      "  throw new Error(`Unexpected file plugin ID: ${file.id}`);",
      "}",
      "export default defineConfig({",
      '  baseline: "v3-lines.baseline.json",',
      "  plugins: [file],",
      "  bindings: [",
      '    binding("env-policy", [',
      '      file.from("app.env").quote("host=localhost").reference("quoted-host"),',
      '      file.from("app.env").match("port=(\\\\d+)", 1).reference("matched-port"),',
      '      file.from("app.env").region("runtime").reference("runtime-region"),',
      "    ]),",
      "  ],",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(dir, "v3-lines.baseline.json"),
    JSON.stringify({
      version: 3,
      bindings: {
        "env-policy": {
          definition: {
            id: "env-policy",
            references: ["quoted-host", "matched-port", "runtime-region"],
          },
          references: {
            "quoted-host": {
              definition: {
                id: "quoted-host",
                target: {
                  pluginId: "@ykdz/dock-reference-file",
                  target: "app.env",
                  fileInfo: "app.env",
                },
                selection: {
                  kind: "text",
                  steps: [{ kind: "quote", text: "host=localhost" }],
                },
              },
              value: "host=localhost",
            },
            "matched-port": {
              definition: {
                id: "matched-port",
                target: {
                  pluginId: "@ykdz/dock-reference-file",
                  target: "app.env",
                  fileInfo: "app.env",
                },
                selection: {
                  kind: "text",
                  steps: [{ kind: "match", pattern: "port=(\\d+)", group: 1 }],
                },
              },
              value: "4173",
            },
            "runtime-region": {
              definition: {
                id: "runtime-region",
                target: {
                  pluginId: "@ykdz/dock-reference-file",
                  target: "app.env",
                  fileInfo: "app.env",
                },
                selection: {
                  kind: "text",
                  steps: [{ kind: "region", name: "runtime" }],
                },
              },
              value: "port=4173\nhost=localhost\n",
            },
          },
        },
      },
    }),
    "utf8",
  );
  const v3Consistent = await run(
    bin,
    ["check", "--config", "v3-lines.config.mjs"],
    dir,
  );
  assert.equal(v3Consistent.code, 0, v3Consistent.stdout + v3Consistent.stderr);
  assert.equal(
    v3Consistent.stdout,
    "Scope: env-policy\nAll checked bindings are consistent with baseline.\n",
  );

  await writeFile(
    appEnvPath,
    [
      "😀header",
      "#region runtime",
      "port=8080",
      "host=localhost",
      "#endregion runtime",
      "",
    ].join("\n"),
    "utf8",
  );
  const lineRangeCheck = await run(
    bin,
    ["check", "--config", "v3-lines.config.mjs"],
    dir,
  );
  assert.equal(lineRangeCheck.code, 1, lineRangeCheck.stderr);
  assert.match(lineRangeCheck.stdout, /quoted-host \(app\.env:4\)/);
  assert.match(
    lineRangeCheck.stdout,
    /Change: matched-port fact: before "4173"; after "8080" \(app\.env:3\)/,
  );
  assert.match(
    lineRangeCheck.stdout,
    /Change: runtime-region fact changed \(app\.env:3-4\)/,
  );
}

async function verifyInstalledMarkdownSmoke(
  bin: string,
  dir: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const markdownFixtures = join(fixturesRoot, "markdown");
  for (const name of [
    "dock.config.mjs",
    "guide.md",
    "inline-script-config.mjs",
    "inline-script-guide.md",
    "inline-script-runtime.mjs",
    "markers-guide.md",
    "negative.mts",
    "positive.mts",
    "runtime.mjs",
    "tsconfig.json",
  ]) {
    await copyFile(join(markdownFixtures, name), join(dir, name));
  }

  const typecheck = await run(
    hostCompiler,
    ["-p", join(dir, "tsconfig.json"), "--pretty", "false"],
    dir,
  );
  assert.equal(
    typecheck.code,
    0,
    `Installed Markdown public type checks failed:\n${typecheck.stdout}\n${typecheck.stderr}`,
  );

  for (const runtimeScript of ["runtime.mjs", "inline-script-runtime.mjs"]) {
    const runtime = await run(
      process.execPath,
      [join(dir, runtimeScript)],
      dir,
    );
    assert.equal(
      runtime.code,
      0,
      `Installed Markdown runtime (${runtimeScript}) failed:\n${runtime.stdout}\n${runtime.stderr}`,
    );
  }

  // Verify quote, match capture, named region, processor ID, and V3 baseline compatibility via @ykdz/dock/markdown.
  await writeFile(
    join(dir, "text-selection-verify.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { defineConfig, readReference } from "@ykdz/dock";',
      'import { markdown, markdownPluginId } from "@ykdz/dock/markdown";',
      'assert.equal(markdownPluginId, "@ykdz/dock-reference-markdown");',
      'assert.equal(markdown.id, "@ykdz/dock-reference-markdown");',
      "const config = defineConfig({ plugins: [markdown], bindings: [] });",
      'const quoted = await readReference(config, markdown.from("guide.md").section(["指南", "安装"]).quote("安装片段：版本一。").reference("md-quote"));',
      'assert.equal(quoted.value, "安装片段：版本一。");',
      'const regioned = await readReference(config, markdown.from("guide.md").section(["指南", "安装"]).region("runtime").reference("md-region"));',
      'assert.equal(regioned.value, "port=4173\\n");',
      'const matched = await readReference(config, markdown.from("guide.md").section(["指南", "安装"]).region("runtime").match("port=(\\\\d+)", 1).reference("md-match"));',
      'assert.equal(matched.value, "4173");',
    ].join("\n"),
    "utf8",
  );
  const mdTextSelection = await run(
    process.execPath,
    [join(dir, "text-selection-verify.mjs")],
    dir,
  );
  assert.equal(
    mdTextSelection.code,
    0,
    `Installed Markdown text-selection check failed:\n${mdTextSelection.stdout}\n${mdTextSelection.stderr}`,
  );

  await writeFile(
    join(dir, "v3-markdown.config.mjs"),
    [
      'import { binding, defineConfig } from "@ykdz/dock";',
      'import { markdown } from "@ykdz/dock/markdown";',
      "export default defineConfig({",
      '  baseline: "v3-markdown.baseline.json",',
      "  plugins: [markdown],",
      "  bindings: [",
      '    binding("v3-md-policy", [',
      '      markdown.from("guide.md").section("标记位置").marker("stable-port").reference("stable-port"),',
      '      markdown.from("guide.md").tableCell({ column: "说明", row: { column: "名称", value: "api" } }).reference("table-cell"),',
      "    ]),",
      "  ],",
      "});",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(dir, "v3-markdown.baseline.json"),
    JSON.stringify({
      version: 3,
      bindings: {
        "v3-md-policy": {
          definition: {
            id: "v3-md-policy",
            references: ["stable-port", "table-cell"],
          },
          references: {
            "stable-port": {
              definition: {
                id: "stable-port",
                target: {
                  pluginId: "@ykdz/dock-reference-markdown",
                  target: "guide.md",
                  fileInfo: "guide.md",
                },
                selection: {
                  kind: "markdown",
                  steps: [
                    { kind: "section", heading: "标记位置" },
                    { kind: "marker", id: "stable-port" },
                  ],
                },
              },
              value: "8080",
            },
            "table-cell": {
              definition: {
                id: "table-cell",
                target: {
                  pluginId: "@ykdz/dock-reference-markdown",
                  target: "guide.md",
                  fileInfo: "guide.md",
                },
                selection: {
                  kind: "markdown",
                  steps: [
                    {
                      kind: "tableCell",
                      selector: {
                        column: "说明",
                        row: { column: "名称", value: "api" },
                      },
                    },
                  ],
                },
              },
              value: "**当前值**",
            },
          },
        },
      },
    }),
    "utf8",
  );
  const v3MarkdownCheck = await run(
    bin,
    ["check", "--config", "v3-markdown.config.mjs"],
    dir,
  );
  assert.equal(
    v3MarkdownCheck.code,
    0,
    v3MarkdownCheck.stdout + v3MarkdownCheck.stderr,
  );
  assert.equal(
    v3MarkdownCheck.stdout,
    "Scope: v3-md-policy\nAll checked bindings are consistent with baseline.\n",
  );

  const updated = await run(
    bin,
    [
      "baseline",
      "update",
      "--config",
      "dock.config.mjs",
      "--output",
      "structured",
    ],
    dir,
  );
  assert.equal(updated.code, 0, updated.stderr);
  const baselinePath = join(dir, "markdown.baseline.json");
  const savedBaseline = await readFile(baselinePath);

  const consistentText = await run(
    bin,
    ["check", "--config", "dock.config.mjs", "--file", "guide.md"],
    dir,
  );
  assert.equal(consistentText.code, 0, consistentText.stderr);
  assert.equal(
    consistentText.stdout,
    "Scope: markdown-policy, ordinary-file-policy\nAll checked bindings are consistent with baseline.\n",
  );

  const guidePath = join(dir, "guide.md");
  const originalGuide = await readFile(guidePath, "utf8");
  await writeFile(
    guidePath,
    originalGuide.replace("<!-- dock:end stable-port -->", ""),
    "utf8",
  );
  const removedTargetCheck = await run(
    bin,
    ["check", "--config", "dock.config.mjs", "--binding", "markdown-policy"],
    dir,
  );
  assert.equal(removedTargetCheck.code, 1, removedTargetCheck.stderr);
  assert.match(
    removedTargetCheck.stdout,
    /Error stable-port \(missing-selection\) \(guide\.md:46-48\):/,
  );

  const missingMarker = await run(
    bin,
    [
      "baseline",
      "update",
      "--config",
      "dock.config.mjs",
      "--output",
      "structured",
    ],
    dir,
  );
  assert.equal(missingMarker.code, 1, missingMarker.stderr);
  assert.equal(parseEnvelope(missingMarker.stdout).variant, "rejected");
  assertBindingError(
    requireReport(parseEnvelope(missingMarker.stdout)),
    "markdown-policy",
    "missing-selection",
  );
  assert.deepEqual(await readFile(baselinePath), savedBaseline);

  await writeFile(
    guidePath,
    `${originalGuide}\n<!-- dock:start stable-port -->9090<!-- dock:end stable-port -->\n`,
    "utf8",
  );
  const ambiguousTargetCheck = await run(
    bin,
    ["check", "--config", "dock.config.mjs", "--binding", "markdown-policy"],
    dir,
  );
  assert.equal(ambiguousTargetCheck.code, 1, ambiguousTargetCheck.stderr);
  assert.match(
    ambiguousTargetCheck.stdout,
    /Error stable-port \(ambiguous-selection\) \(guide\.md:46-50\):/,
  );

  // Verify whole-document directive checking, code-example preservation, root-cause deduplication, and unreadable source protection.
  const guideWithCodeExamples = [
    originalGuide,
    "",
    "```md",
    "<!-- dock:start ignored-in-fence -->",
    "<!-- dock:strat ignored-typo-in-fence -->",
    "```",
    "",
    "    <!-- dock:start ignored-in-indented-code -->",
    "",
    "Inline example `<!-- dock:start ignored-in-inline -->`.",
    '<div data-example="<!-- dock:start ignored-in-attr -->"></div>',
    '<script>const example = "<!-- dock:start ignored-in-script -->";</script>',
    "",
    "<!-- dock:start standalone-only -->ok<!-- dock:end standalone-only -->",
    "",
  ].join("\n");
  await writeFile(guidePath, guideWithCodeExamples, "utf8");
  await writeFile(
    join(dir, "unrelated-broken.md"),
    "<!-- dock:start out-of-scope-unclosed -->\n<!-- dock:strat out-of-scope-typo -->\n",
    "utf8",
  );
  const cleanWithExamples = await run(
    bin,
    ["check", "--config", "dock.config.mjs", "--binding", "markdown-policy"],
    dir,
  );
  assert.equal(
    cleanWithExamples.code,
    0,
    cleanWithExamples.stdout + cleanWithExamples.stderr,
  );
  await writeFile(
    join(dir, "read-standalone-only.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { defineConfig, readReference } from "@ykdz/dock";',
      'import { markdown } from "@ykdz/dock/markdown";',
      "const cfg = defineConfig({ plugins: [markdown], bindings: [] });",
      'const read = await readReference(cfg, markdown.from("guide.md").marker("standalone-only").reference("standalone-only"));',
      'assert.equal(read.value, "ok");',
    ].join("\n"),
    "utf8",
  );
  const standaloneRead = await run(
    process.execPath,
    [join(dir, "read-standalone-only.mjs")],
    dir,
  );
  assert.equal(
    standaloneRead.code,
    0,
    standaloneRead.stdout + standaloneRead.stderr,
  );

  // Inject two independent broken directives outside selected sections/markers and verify multi-binding deduplication.
  await writeFile(
    join(dir, "multi-binding-markers.config.mjs"),
    [
      'import { binding, defineConfig } from "@ykdz/dock";',
      'import { markdown } from "@ykdz/dock/markdown";',
      "export default defineConfig({",
      '  baseline: "markdown.baseline.json",',
      "  plugins: [markdown],",
      "  bindings: [",
      '    binding("alpha-policy", [',
      '      markdown.from("guide.md").section(["指南", "安装"]).node({ type: "paragraph", contains: "安装片段" }).reference("alpha-chapter"),',
      '      markdown.from("guide.md").node({ type: "table" }).reference("alpha-table"),',
      "    ]),",
      '    binding("beta-policy", [',
      '      markdown.from("guide.md").section(["其他", "准备"]).reference("beta-prep"),',
      "    ]),",
      "  ],",
      "});",
    ].join("\n"),
    "utf8",
  );
  const brokenGuide = [
    guideWithCodeExamples,
    "<!-- dock:start unclosed-extra -->",
    "",
    "<!-- dock:strat bad-directive -->",
    "",
  ].join("\n");
  await writeFile(guidePath, brokenGuide, "utf8");
  const linesBeforeExtra = guideWithCodeExamples.split("\n").length;
  const unclosedLine = linesBeforeExtra + 1;
  const typoLine = linesBeforeExtra + 3;

  const multiMarkerCheck = await run(
    bin,
    ["check", "--config", "multi-binding-markers.config.mjs"],
    dir,
  );
  assert.equal(multiMarkerCheck.code, 1, multiMarkerCheck.stderr);
  assert.match(
    multiMarkerCheck.stdout,
    new RegExp(`guide\\.md:${unclosedLine}.*dock:start unclosed-extra`),
  );
  assert.match(
    multiMarkerCheck.stdout,
    new RegExp(`guide\\.md:${typoLine}.*dock:strat bad-directive`),
  );
  assert.equal(
    multiMarkerCheck.stdout.match(/Invalid Dock directives in guide\.md:/g)
      ?.length,
    1,
    multiMarkerCheck.stdout,
  );
  assert.match(
    multiMarkerCheck.stdout,
    /same root cause as alpha-chapter/,
    multiMarkerCheck.stdout,
  );

  const multiMarkerStructured = await run(
    bin,
    [
      "check",
      "--config",
      "multi-binding-markers.config.mjs",
      "--output",
      "structured",
    ],
    dir,
  );
  assert.equal(multiMarkerStructured.code, 1, multiMarkerStructured.stderr);
  const multiStructuredReport = requireReport(
    parseEnvelope(multiMarkerStructured.stdout),
  );
  assertBindingError(multiStructuredReport, "alpha-policy", "invalid-marker");
  assertBindingError(multiStructuredReport, "beta-policy", "invalid-marker");

  const multiMarkerUpdate = await run(
    bin,
    [
      "baseline",
      "update",
      "--config",
      "multi-binding-markers.config.mjs",
      "--output",
      "structured",
    ],
    dir,
  );
  assert.equal(multiMarkerUpdate.code, 1, multiMarkerUpdate.stderr);
  assert.equal(parseEnvelope(multiMarkerUpdate.stdout).variant, "rejected");
  assert.deepEqual(await readFile(baselinePath), savedBaseline);

  await writeFile(
    join(dir, "unreadable-source.config.mjs"),
    [
      'import { defineConfig } from "@ykdz/dock";',
      'import { markdown } from "@ykdz/dock/markdown";',
      "export default defineConfig({",
      '  baseline: "markdown.baseline.json",',
      "  plugins: [markdown],",
      '  sources: [markdown.source("missing-source.md")],',
      "});",
    ].join("\n"),
    "utf8",
  );
  const unreadableSourceUpdate = await run(
    bin,
    ["baseline", "update", "--config", "unreadable-source.config.mjs"],
    dir,
  );
  assert.equal(unreadableSourceUpdate.code, 1);
  assert.match(
    unreadableSourceUpdate.stderr,
    /Maintenance failed \(declaration-source-read-failed\)/,
  );
  assert.deepEqual(await readFile(baselinePath), savedBaseline);

  // Verify installed inline dock:bind workflow on an onboarded Markdown file (with spaces in reference ID, inspect, baseline update, reordering, and corruption protection).
  const inlineGuidePath = join(dir, "inline-guide.md");
  const inlineGuideV1 = [
    "# CLI Guide",
    "",
    "## Exit Codes",
    "",
    "Exit code is 1 when inconsistent.",
    "",
  ].join("\n");
  await writeFile(inlineGuidePath, inlineGuideV1, "utf8");
  await writeFile(join(dir, "exit-code.txt"), "1\n", "utf8");
  await writeFile(
    join(dir, "inline-bind.config.mjs"),
    [
      'import { binding, defineConfig, file } from "@ykdz/dock";',
      'import { markdown } from "@ykdz/dock/markdown";',
      "export default defineConfig({",
      '  baseline: "inline-bind.baseline.json",',
      "  plugins: [file, markdown],",
      "  bindings: [",
      '    binding("exit-docs", [',
      '      markdown.from("inline-guide.md").section("Exit Codes").reference("guide-exit-codes"),',
      '      file.from("exit-code.txt").reference("cli exit code"),',
      "    ]),",
      "  ],",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const initInlineBaseline = await run(
    bin,
    ["baseline", "update", "--config", "inline-bind.config.mjs"],
    dir,
  );
  assert.equal(
    initInlineBaseline.code,
    0,
    initInlineBaseline.stdout + initInlineBaseline.stderr,
  );

  const inlineGuideV2 = [
    "# CLI Guide",
    "",
    "## Summary",
    "",
    '<!-- dock:bind {"id":"cli-inline","with":["cli exit code","guide-exit-codes"]} -->',
    "",
    "Failures exit with status 1 as documented in Exit Codes.",
    "",
    "## Exit Codes",
    "",
    "Exit code is 1 when inconsistent.",
    "",
  ].join("\n");
  await writeFile(inlineGuidePath, inlineGuideV2, "utf8");

  const inlineInspect = await run(
    bin,
    ["inspect", "--config", "inline-bind.config.mjs", "--output", "structured"],
    dir,
  );
  assert.equal(
    inlineInspect.code,
    0,
    inlineInspect.stdout + inlineInspect.stderr,
  );
  const inspectedInlineData = JSON.parse(inlineInspect.stdout) as {
    data?: {
      resolution?: {
        context: { bindings: { id: string; references: string[] }[] };
        declarationSources: { bindings: Record<string, string[]> };
      };
    };
  };
  assert.deepEqual(
    inspectedInlineData.data?.resolution?.context.bindings.find(
      (entry) => entry.id === "cli-inline",
    ),
    {
      id: "cli-inline",
      references: ["dock:bind:cli-inline", "cli exit code", "guide-exit-codes"],
    },
  );
  assert.deepEqual(
    inspectedInlineData.data?.resolution?.declarationSources.bindings[
      "cli-inline"
    ],
    ["inline-guide.md:5"],
  );

  const inlineBaselineUpdate = await run(
    bin,
    ["baseline", "update", "--config", "inline-bind.config.mjs"],
    dir,
  );
  assert.equal(
    inlineBaselineUpdate.code,
    0,
    inlineBaselineUpdate.stdout + inlineBaselineUpdate.stderr,
  );

  await writeFile(join(dir, "exit-code.txt"), "2\n", "utf8");
  const inlineFactChanged = await run(
    bin,
    ["check", "--config", "inline-bind.config.mjs"],
    dir,
  );
  assert.equal(
    inlineFactChanged.code,
    1,
    inlineFactChanged.stdout + inlineFactChanged.stderr,
  );
  assert.match(inlineFactChanged.stdout, /Binding cli-inline/);
  assert.match(inlineFactChanged.stdout, /Change: cli exit code fact changed/);
  assert.ok(
    inlineFactChanged.stdout.includes(
      "dock:bind:cli-inline (inline-guide.md:7)",
    ),
    inlineFactChanged.stdout,
  );

  const inlineBaselineRefresh = await run(
    bin,
    ["baseline", "update", "--config", "inline-bind.config.mjs"],
    dir,
  );
  assert.equal(
    inlineBaselineRefresh.code,
    0,
    inlineBaselineRefresh.stdout + inlineBaselineRefresh.stderr,
  );
  const inlineConsistent = await run(
    bin,
    ["check", "--config", "inline-bind.config.mjs"],
    dir,
  );
  assert.equal(
    inlineConsistent.code,
    0,
    inlineConsistent.stdout + inlineConsistent.stderr,
  );

  // Reorder paragraphs and adjust blank lines; baseline remains consistent.
  const inlineGuideReordered = [
    "# CLI Guide",
    "",
    "## Summary",
    "",
    "Lead intro.",
    "",
    '<!-- dock:bind {"id":"cli-inline","with":["cli exit code","guide-exit-codes"]} -->',
    "",
    "",
    "Failures exit with status 1 as documented in Exit Codes.",
    "",
    "## Exit Codes",
    "",
    "Exit code is 1 when inconsistent.",
    "",
  ].join("\n");
  await writeFile(inlineGuidePath, inlineGuideReordered, "utf8");
  const inlineReorderedCheck = await run(
    bin,
    ["check", "--config", "inline-bind.config.mjs"],
    dir,
  );
  assert.equal(
    inlineReorderedCheck.code,
    0,
    inlineReorderedCheck.stdout + inlineReorderedCheck.stderr,
  );

  // Corrupt baselined dock:bind -> CLI and JS reject update, preserve baseline bytes, and never report untracked.
  const inlineBaselinePath = join(dir, "inline-bind.baseline.json");
  const savedInlineBaseline = await readFile(inlineBaselinePath);
  await writeFile(
    inlineGuidePath,
    inlineGuideReordered.replace(
      '<!-- dock:bind {"id":"cli-inline","with":["cli exit code","guide-exit-codes"]} -->',
      '<!-- dock:bind {"id":"cli-inline","with":["cli exit code"],"extra":1} -->',
    ),
    "utf8",
  );
  for (const args of [
    ["check", "--config", "inline-bind.config.mjs"],
    ["baseline", "update", "--config", "inline-bind.config.mjs"],
  ]) {
    const failed = await run(bin, args, dir);
    assert.equal(failed.code, 1, failed.stdout + failed.stderr);
    assert.match(failed.stderr, /Maintenance failed \(declaration-invalid\)/);
    assert.match(failed.stderr, /inline-guide\.md:7/);
    assert.match(failed.stderr, /Unknown field "extra"/);
    assert.deepEqual(await readFile(inlineBaselinePath), savedInlineBaseline);
  }
  await writeFile(
    join(dir, "inline-corrupt-js.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { readFile } from "node:fs/promises";',
      'import { check, MaintenanceError, updateBaseline } from "@ykdz/dock";',
      'const before = await readFile("inline-bind.baseline.json");',
      'for (const op of [() => check("inline-bind.config.mjs"), () => updateBaseline("inline-bind.config.mjs")]) {',
      "  await assert.rejects(op, (error) => {",
      "    assert.ok(error instanceof MaintenanceError);",
      '    assert.equal(error.code, "declaration-invalid");',
      "    assert.match(error.message, /inline-guide\\.md:7/);",
      "    return true;",
      "  });",
      '  assert.deepEqual(await readFile("inline-bind.baseline.json"), before);',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const inlineCorruptJs = await run(
    process.execPath,
    [join(dir, "inline-corrupt-js.mjs")],
    dir,
  );
  assert.equal(
    inlineCorruptJs.code,
    0,
    inlineCorruptJs.stdout + inlineCorruptJs.stderr,
  );

  await verifyInstalledExplicitMarkdownSources(
    bin,
    join(dir, "explicit-markdown-sources"),
  );
}

async function verifyInstalledExplicitMarkdownSources(
  bin: string,
  dir: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const guidePath = join(dir, "guide.md");
  const baselinePath = join(dir, "dock.baseline.json");
  const factPath = join(dir, "fact.txt");
  const keepPath = join(dir, "keep.txt");
  const testPath = join(dir, "guide.test.mjs");
  const unusedTestPath = join(dir, "unused.test.mjs");
  const unusedMarkerPath = join(dir, "unused-executed.txt");

  await writeFile(factPath, "exit=1\n", "utf8");
  await writeFile(keepPath, "stable\n", "utf8");
  await writeFile(
    testPath,
    [
      'import assert from "node:assert/strict";',
      'import { readFileSync } from "node:fs";',
      'import test from "node:test";',
      'test("guide status", () => {',
      '  assert.equal(readFileSync("fact.txt", "utf8").trim(), "exit=1");',
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    unusedTestPath,
    [
      'import { writeFileSync } from "node:fs";',
      'import test from "node:test";',
      'test("unused test", () => {',
      '  writeFileSync("unused-executed.txt", "ran", "utf8");',
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    guidePath,
    [
      "# Guide",
      "",
      '<!-- dock:bind {"id":"inline-one","with":["fact ref","guide test"]} -->',
      "",
      "Check exits 1 when fact.txt says exit=1.",
      "",
      '<!-- dock:bind {"id":"inline-two","with":["fact ref"]} -->',
      "",
      "Second inline statement.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(dir, "random.md"),
    [
      "<!-- dock:start unclosed-random -->",
      '<!-- dock:bind {"id":"inline-one","with":[]} -->',
      "<!-- dock:bind {broken json -->",
      "",
    ].join("\n"),
    "utf8",
  );

  // Runtime TypeError verification for invalid config shapes + AC 1/2/3/4 across JS and CLI.
  const sourceOnlyConfigPath = join(dir, "source-only.config.mjs");
  await writeFile(
    sourceOnlyConfigPath,
    [
      'import { defineConfig, file } from "@ykdz/dock";',
      'import { markdown } from "@ykdz/dock/markdown";',
      'import { defineNodeTestRun, nodeTest, nodeTestStatus } from "@ykdz/dock/node-test";',
      'const guideRun = defineNodeTestRun("guide-run", { files: ["guide.test.mjs"] });',
      'const unusedRun = defineNodeTestRun("unused-run", { files: ["unused.test.mjs"] });',
      "export default defineConfig({",
      "  plugins: [markdown, file, nodeTest],",
      '  sources: [markdown.source("guide.md")],',
      "  references: [",
      '    file.from("fact.txt").reference("fact ref"),',
      '    nodeTestStatus("guide test", guideRun, { file: "guide.test.mjs", name: "guide status" }),',
      '    nodeTestStatus("unused ref", unusedRun, { file: "unused.test.mjs", name: "unused test" }),',
      "  ],",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    join(dir, "runtime-ac1-ac2.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { readFile } from "node:fs/promises";',
      'import { check, defineConfig, file, inspect } from "@ykdz/dock";',
      'import { markdown } from "@ykdz/dock/markdown";',
      "",
      "assert.throws(",
      "  () => defineConfig({ plugins: [] }),",
      "  (error) => error instanceof TypeError && /bindings or sources/i.test(error.message),",
      ");",
      "assert.throws(",
      '  () => defineConfig({ plugins: [markdown], references: [file.from("fact.txt").reference("r")] }),',
      "  (error) => error instanceof TypeError && /bindings or sources/i.test(error.message),",
      ");",
      "",
      'const inspected = await inspect("source-only.config.mjs");',
      "assert.deepEqual(",
      "  inspected.context.bindings.map((b) => b.id),",
      '  ["inline-one", "inline-two"],',
      ");",
      "assert.ok(",
      '  inspected.files.some((entry) => entry.path.endsWith("/guide.md") && entry.references.includes("dock:bind:inline-one")),',
      ");",
      'const inspectedByFile = await inspect("source-only.config.mjs", { file: ["guide.md"] });',
      'assert.deepEqual(inspectedByFile.context.scope, ["inline-one", "inline-two"]);',
      'const checkedByRef = await check("source-only.config.mjs", { reference: ["dock:bind:inline-one"] });',
      'assert.deepEqual(checkedByRef.scope, ["inline-one"]);',
      'const checkedByStandaloneRef = await check("source-only.config.mjs", { reference: ["fact ref"] });',
      'assert.deepEqual(checkedByStandaloneRef.scope, ["inline-one", "inline-two"]);',
      "await assert.rejects(",
      `  () => readFile(${JSON.stringify(unusedMarkerPath)}, "utf8"),`,
      '  { code: "ENOENT" },',
      ");",
      "",
    ].join("\n"),
    "utf8",
  );
  const ac1Js = await run(
    process.execPath,
    [join(dir, "runtime-ac1-ac2.mjs")],
    dir,
  );
  assert.equal(ac1Js.code, 0, ac1Js.stdout + ac1Js.stderr);

  const cliInspect = await run(
    bin,
    ["inspect", "--config", "source-only.config.mjs"],
    dir,
  );
  assert.equal(cliInspect.code, 0, cliInspect.stderr);
  assert.match(
    cliInspect.stdout,
    /Target file .*guide\.md:.*dock:bind:inline-one/,
  );

  const cliFileCheck = await run(
    bin,
    [
      "check",
      "--config",
      "source-only.config.mjs",
      "--file",
      "guide.md",
      "--output",
      "structured",
    ],
    dir,
  );
  assert.equal(cliFileCheck.code, 1, cliFileCheck.stderr);
  const cliFileEnvelope = parseEnvelope(cliFileCheck.stdout);
  assert.equal(cliFileEnvelope.variant, "changed");
  assert.deepEqual(requireReport(cliFileEnvelope).scope, [
    "inline-one",
    "inline-two",
  ]);
  await assert.rejects(readFile(unusedMarkerPath, "utf8"), { code: "ENOENT" });

  // AC 2: Multi-path deduplication + keep-binding + out-of-scope random.md ignored.
  const combinedConfigPath = join(dir, "combined.config.mjs");
  await writeFile(
    combinedConfigPath,
    [
      'import { binding, defineConfig, file } from "@ykdz/dock";',
      'import { markdown } from "@ykdz/dock/markdown";',
      'import { defineNodeTestRun, nodeTest, nodeTestStatus } from "@ykdz/dock/node-test";',
      'const guideRun = defineNodeTestRun("guide-run", { files: ["guide.test.mjs"] });',
      'const factRef = file.from("fact.txt").reference("fact ref");',
      'const keepRef = file.from("keep.txt").reference("keep ref");',
      'const guideTestRef = nodeTestStatus("guide test", guideRun, { file: "guide.test.mjs", name: "guide status" });',
      "export default defineConfig({",
      "  plugins: [markdown, file, nodeTest],",
      '  sources: [markdown.source("guide.md"), markdown.source(new URL("./guide.md", import.meta.url))],',
      "  references: [",
      "    factRef,",
      "    guideTestRef,",
      '    markdown.from("guide.md").node({ type: "paragraph", contains: "Second inline" }).reference("second-para"),',
      "  ],",
      "  bindings: [",
      '    binding("keep-binding", [keepRef, markdown.from("guide.md").node({ type: "paragraph", contains: "Check exits 1" }).reference("first-para")]),',
      "  ],",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  const combinedUpdate = await run(
    bin,
    ["baseline", "update", "--config", "combined.config.mjs"],
    dir,
  );
  assert.equal(
    combinedUpdate.code,
    0,
    combinedUpdate.stdout + combinedUpdate.stderr,
  );
  const savedBaseline = await readFile(baselinePath);
  const consistentCombined = await run(
    bin,
    ["check", "--config", "combined.config.mjs"],
    dir,
  );
  assert.equal(
    consistentCombined.code,
    0,
    consistentCombined.stdout + consistentCombined.stderr,
  );

  // AC 3 (1): Unreadable source preserves baseline bytes and rejects update.
  const originalGuide = await readFile(guidePath, "utf8");
  await rm(guidePath);
  for (const args of [
    ["check", "--config", "combined.config.mjs"],
    ["baseline", "update", "--config", "combined.config.mjs"],
  ]) {
    const failed = await run(bin, args, dir);
    assert.equal(failed.code, 1, failed.stdout + failed.stderr);
    assert.match(
      failed.stderr,
      /Maintenance failed \(declaration-source-read-failed\)/,
    );
    assert.match(failed.stderr, /guide\.md/);
    assert.doesNotMatch(failed.stderr, /untracked/i);
    assert.deepEqual(await readFile(baselinePath), savedBaseline);
  }

  // AC 3 (2): Corrupted inline declaration preserves baseline bytes and rejects update.
  await writeFile(
    guidePath,
    originalGuide.replace(
      '<!-- dock:bind {"id":"inline-one","with":["fact ref","guide test"]} -->',
      '<!-- dock:bind {"id":"inline-one","with":[]} -->',
    ),
    "utf8",
  );
  for (const args of [
    ["check", "--config", "combined.config.mjs"],
    ["baseline", "update", "--config", "combined.config.mjs"],
  ]) {
    const failed = await run(bin, args, dir);
    assert.equal(failed.code, 1, failed.stdout + failed.stderr);
    assert.match(failed.stderr, /Maintenance failed \(declaration-invalid\)/);
    assert.match(failed.stderr, /guide\.md:3/);
    assert.doesNotMatch(failed.stderr, /untracked/i);
    assert.deepEqual(await readFile(baselinePath), savedBaseline);
  }

  // AC 3 (3): Broken referenced target (failing nodeTest + deleted fact.txt) isolates errors to affected bindings while unaffected sibling stays consistent.
  await writeFile(guidePath, originalGuide, "utf8");
  await rm(factPath);
  const brokenTargetCheck = await run(
    bin,
    ["check", "--config", "combined.config.mjs", "--output", "structured"],
    dir,
  );
  assert.equal(brokenTargetCheck.code, 1, brokenTargetCheck.stderr);
  const brokenReport = requireReport(parseEnvelope(brokenTargetCheck.stdout));
  assertBindingError(brokenReport, "inline-two", "missing-file");
  assert.equal(
    brokenReport.bindings.find((b) => b.bindingId === "keep-binding")
      ?.consistency,
    "consistent",
  );
  const brokenUpdate = await run(
    bin,
    [
      "baseline",
      "update",
      "--config",
      "combined.config.mjs",
      "--output",
      "structured",
    ],
    dir,
  );
  assert.equal(brokenUpdate.code, 1, brokenUpdate.stderr);
  assert.equal(parseEnvelope(brokenUpdate.stdout).variant, "rejected");
  assert.deepEqual(await readFile(baselinePath), savedBaseline);

  // Restore fact.txt with drifted content so nodeTest fails while keep-binding (when decoupled from fact.txt) stays consistent.
  await writeFile(factPath, "exit=2\n", "utf8");
  const failingTestCheck = await run(
    bin,
    ["check", "--config", "combined.config.mjs", "--output", "structured"],
    dir,
  );
  assert.equal(failingTestCheck.code, 1, failingTestCheck.stderr);
  const failingTestReport = requireReport(
    parseEnvelope(failingTestCheck.stdout),
  );
  assertBindingError(failingTestReport, "inline-one", "test-failed");
  assert.equal(
    failingTestReport.bindings.find((b) => b.bindingId === "keep-binding")
      ?.consistency,
    "consistent",
  );
  const failingTestUpdate = await run(
    bin,
    [
      "baseline",
      "update",
      "--config",
      "combined.config.mjs",
      "--output",
      "structured",
    ],
    dir,
  );
  assert.equal(failingTestUpdate.code, 1, failingTestUpdate.stderr);
  assert.equal(parseEnvelope(failingTestUpdate.stdout).variant, "rejected");
  assert.deepEqual(await readFile(baselinePath), savedBaseline);

  // Restore fact.txt and re-baseline with decoupled keep-binding for AC 4.
  await writeFile(factPath, "exit=1\n", "utf8");
  const ac4ConfigPath = join(dir, "ac4.config.mjs");
  await writeFile(
    ac4ConfigPath,
    [
      'import { binding, defineConfig, file } from "@ykdz/dock";',
      'import { markdown } from "@ykdz/dock/markdown";',
      'import { defineNodeTestRun, nodeTest, nodeTestStatus } from "@ykdz/dock/node-test";',
      'const guideRun = defineNodeTestRun("guide-run", { files: ["guide.test.mjs"] });',
      "export default defineConfig({",
      "  plugins: [markdown, file, nodeTest],",
      '  sources: [markdown.source("guide.md")],',
      "  references: [",
      '    file.from("fact.txt").reference("fact ref"),',
      '    nodeTestStatus("guide test", guideRun, { file: "guide.test.mjs", name: "guide status" }),',
      "  ],",
      '  bindings: [binding("keep-binding", [file.from("keep.txt").reference("keep ref")])],',
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const ac4Init = await run(
    bin,
    ["baseline", "update", "--config", "ac4.config.mjs"],
    dir,
  );
  assert.equal(ac4Init.code, 0, ac4Init.stdout + ac4Init.stderr);

  // AC 4: Remove inline-one and inline-two from guide.md -> partial check keeps them, full check reports untracked, scoped update removes only inline-one.
  await writeFile(guidePath, "# Guide\n\nNo inline bindings.\n", "utf8");
  const partialCheck = await run(
    bin,
    ["check", "--config", "ac4.config.mjs", "--binding", "keep-binding"],
    dir,
  );
  assert.equal(partialCheck.code, 0, partialCheck.stdout + partialCheck.stderr);
  assert.equal(
    partialCheck.stdout,
    "Scope: keep-binding\nAll checked bindings are consistent with baseline.\n",
  );

  const untrackedFull = await run(
    bin,
    ["check", "--config", "ac4.config.mjs", "--output", "structured"],
    dir,
  );
  assert.equal(untrackedFull.code, 1, untrackedFull.stderr);
  const untrackedReport = requireReport(parseEnvelope(untrackedFull.stdout));
  assert.equal(
    untrackedReport.bindings.find((b) => b.bindingId === "inline-one")
      ?.untracked,
    true,
  );
  assert.equal(
    untrackedReport.bindings.find((b) => b.bindingId === "inline-two")
      ?.untracked,
    true,
  );

  const scopedCleanup = await run(
    bin,
    [
      "baseline",
      "update",
      "--config",
      "ac4.config.mjs",
      "--binding",
      "inline-one",
    ],
    dir,
  );
  assert.equal(
    scopedCleanup.code,
    0,
    scopedCleanup.stdout + scopedCleanup.stderr,
  );
  const afterScopedJson = JSON.parse(await readFile(baselinePath, "utf8")) as {
    bindings: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(afterScopedJson.bindings).sort(), [
    "inline-two",
    "keep-binding",
  ]);

  // Also verify removing markdown.source("guide.md") and deleting guide.md removes inline-two on full update.
  await rm(guidePath);
  const finalConfigPath = join(dir, "ac4-final.config.mjs");
  await writeFile(
    finalConfigPath,
    [
      'import { binding, defineConfig, file } from "@ykdz/dock";',
      'export default defineConfig({ plugins: [file], bindings: [binding("keep-binding", [file.from("keep.txt").reference("keep ref")])] });',
      "",
    ].join("\n"),
    "utf8",
  );
  const finalCleanup = await run(
    bin,
    ["baseline", "update", "--config", "ac4-final.config.mjs"],
    dir,
  );
  assert.equal(finalCleanup.code, 0, finalCleanup.stdout + finalCleanup.stderr);
  const finalJson = JSON.parse(await readFile(baselinePath, "utf8")) as {
    bindings: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(finalJson.bindings), ["keep-binding"]);
  const finalCheck = await run(
    bin,
    ["check", "--config", "ac4-final.config.mjs"],
    dir,
  );
  assert.equal(finalCheck.code, 0, finalCheck.stdout + finalCheck.stderr);
}

async function verifyInstalledTypeScriptSmoke(
  bin: string,
  dir: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tsFixtures = join(fixturesRoot, "typescript");
  for (const name of [
    "dock.config.mjs",
    "invalid-runtime.mjs",
    "negative.mts",
    "positive.mts",
    "runtime.mjs",
    "symbol-source.ts",
    "tsconfig.json",
  ]) {
    await copyFile(join(tsFixtures, name), join(dir, name));
  }
  await writeFile(
    join(dir, "symbol-copy.ts"),
    await readFile(join(dir, "symbol-source.ts")),
  );

  const typecheck = await run(
    hostCompiler,
    ["-p", join(dir, "tsconfig.json"), "--pretty", "false"],
    dir,
  );
  assert.equal(
    typecheck.code,
    0,
    `Installed TypeScript public type checks failed:\n${typecheck.stdout}\n${typecheck.stderr}`,
  );

  for (const runtimeScript of ["invalid-runtime.mjs", "runtime.mjs"]) {
    const runtime = await run(
      process.execPath,
      [join(dir, runtimeScript)],
      dir,
    );
    assert.equal(
      runtime.code,
      0,
      `Installed TypeScript runtime (${runtimeScript}) failed:\n${runtime.stdout}\n${runtime.stderr}`,
    );
  }

  // Verify quote, match capture, named region, processor ID, and V3 baseline compatibility via @ykdz/dock/typescript.
  await writeFile(
    join(dir, "selection-source.ts"),
    [
      "export function configure(): string {",
      "  /*",
      "  #region runtime",
      "  const port = 4173;",
      "  #endregion runtime",
      "  */",
      '  return "ok";',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(dir, "text-selection-verify.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { defineConfig, readReference } from "@ykdz/dock";',
      'import { typescript, typescriptPluginId } from "@ykdz/dock/typescript";',
      'assert.equal(typescriptPluginId, "@ykdz/dock-reference-typescript");',
      'assert.equal(typescript.id, "@ykdz/dock-reference-typescript");',
      "const config = defineConfig({ plugins: [typescript], bindings: [] });",
      'const quoted = await readReference(config, typescript.from("selection-source.ts").symbol("configure", "function").quote(\'return "ok";\').reference("ts-quote"));',
      "assert.equal(quoted.value, 'return \"ok\";');",
      'const matched = await readReference(config, typescript.from("selection-source.ts").symbol("configure", "function").match("const port = (\\\\d+);", 1).reference("ts-match"));',
      'assert.equal(matched.value, "4173");',
      'const regioned = await readReference(config, typescript.from("selection-source.ts").symbol("configure", "function").region("runtime").reference("ts-region"));',
      'assert.equal(regioned.value.trim(), "const port = 4173;");',
    ].join("\n"),
    "utf8",
  );
  const tsTextSelection = await run(
    process.execPath,
    [join(dir, "text-selection-verify.mjs")],
    dir,
  );
  assert.equal(
    tsTextSelection.code,
    0,
    `Installed TypeScript text-selection check failed:\n${tsTextSelection.stdout}\n${tsTextSelection.stderr}`,
  );

  await writeFile(
    join(dir, "v3-typescript.config.mjs"),
    [
      'import { binding, defineConfig } from "@ykdz/dock";',
      'import { typescript } from "@ykdz/dock/typescript";',
      "export default defineConfig({",
      '  baseline: "v3-typescript.baseline.json",',
      "  plugins: [typescript],",
      "  bindings: [",
      '    binding("v3-ts-policy", [',
      '      typescript.from("symbol-source.ts").symbol("calculate", "function").match("return (input \\\\+ \\\\d+);", 1).reference("calculate-expression"),',
      "    ]),",
      "  ],",
      "});",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(dir, "v3-typescript.baseline.json"),
    JSON.stringify({
      version: 3,
      bindings: {
        "v3-ts-policy": {
          definition: {
            id: "v3-ts-policy",
            references: ["calculate-expression"],
          },
          references: {
            "calculate-expression": {
              definition: {
                id: "calculate-expression",
                target: {
                  pluginId: "@ykdz/dock-reference-typescript",
                  target: "symbol-source.ts",
                  fileInfo: "symbol-source.ts",
                },
                selection: {
                  kind: "typescript",
                  steps: [
                    {
                      kind: "symbol",
                      name: ["calculate"],
                      declaration: "function",
                    },
                    {
                      kind: "match",
                      pattern: "return (input \\+ \\d+);",
                      group: 1,
                    },
                  ],
                },
              },
              value: "input + 1",
            },
          },
        },
      },
    }),
    "utf8",
  );
  const v3TsCheck = await run(
    bin,
    ["check", "--config", "v3-typescript.config.mjs"],
    dir,
  );
  assert.equal(v3TsCheck.code, 0, v3TsCheck.stdout + v3TsCheck.stderr);
  assert.equal(
    v3TsCheck.stdout,
    "Scope: v3-ts-policy\nAll checked bindings are consistent with baseline.\n",
  );

  const updated = await run(
    bin,
    [
      "baseline",
      "update",
      "--config",
      "dock.config.mjs",
      "--output",
      "structured",
    ],
    dir,
  );
  assert.equal(updated.code, 0, updated.stderr);
  const baselinePath = join(dir, "typescript.baseline.json");
  const savedBaseline = await readFile(baselinePath);

  const consistentText = await run(
    bin,
    ["check", "--config", "dock.config.mjs"],
    dir,
  );
  assert.equal(consistentText.code, 0, consistentText.stderr);
  assert.equal(
    consistentText.stdout,
    "Scope: typescript-policy\nAll checked bindings are consistent with baseline.\n",
  );

  const symbolSourcePath = join(dir, "symbol-source.ts");
  const originalSymbolSource = await readFile(symbolSourcePath, "utf8");
  await writeFile(
    symbolSourcePath,
    originalSymbolSource.replace(
      "export function calculate(input: number): number {\n  return input + 1;\n}",
      "// calculate removed",
    ),
    "utf8",
  );
  const removedSymbolCheck = await run(
    bin,
    ["check", "--config", "dock.config.mjs"],
    dir,
  );
  assert.equal(removedSymbolCheck.code, 1, removedSymbolCheck.stderr);
  assert.match(
    removedSymbolCheck.stdout,
    /Error calculate-expression \(missing-symbol\) \(symbol-source\.ts:1-18\):/,
  );

  await writeFile(
    symbolSourcePath,
    `${originalSymbolSource}\nexport function calculate(input: number): number {\n  return input + 2;\n}\n`,
    "utf8",
  );
  const ambiguousSymbolCheck = await run(
    bin,
    ["check", "--config", "dock.config.mjs"],
    dir,
  );
  assert.equal(ambiguousSymbolCheck.code, 1, ambiguousSymbolCheck.stderr);
  assert.match(
    ambiguousSymbolCheck.stdout,
    /Error calculate-expression \(ambiguous-symbol\) \(symbol-source\.ts:1-24\):/,
  );

  await writeFile(symbolSourcePath, "function broken( {\n", "utf8");
  const syntaxFailure = await run(
    bin,
    [
      "baseline",
      "update",
      "--config",
      "dock.config.mjs",
      "--output",
      "structured",
    ],
    dir,
  );
  assert.equal(syntaxFailure.code, 1, syntaxFailure.stderr);
  assert.equal(parseEnvelope(syntaxFailure.stdout).variant, "rejected");
  assertBindingError(
    requireReport(parseEnvelope(syntaxFailure.stdout)),
    "typescript-policy",
    "typescript-syntax-error",
  );
  assert.deepEqual(await readFile(baselinePath), savedBaseline);
}

async function verifyNodeTestRealProcesses(scenario: string): Promise<void> {
  const nodeTestFixtures = join(fixturesRoot, "node-test");
  await cp(nodeTestFixtures, scenario, {
    recursive: true,
    filter: (source) => !source.endsWith("node_modules"),
  });

  const typecheck = await run(
    hostCompiler,
    ["-p", join(scenario, "tsconfig.json"), "--pretty", "false"],
    scenario,
  );
  assert.equal(
    typecheck.code,
    0,
    `Installed node-test public type checks failed:\n${typecheck.stdout}\n${typecheck.stderr}`,
  );

  for (const scriptName of [
    "runtime-inputs.mjs",
    "runtime-observations.mjs",
    "operation-local.mts",
  ]) {
    const result = await run(
      process.execPath,
      [join(scenario, scriptName)],
      scenario,
    );
    assert.equal(
      result.code,
      0,
      `Node-test runtime check (${scriptName}) failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
  await rm(join(scenario, "dock.baseline.json"), { force: true });

  const bin = dockBin(scenario);
  await verifyNodeHappyRoundTrip(bin, scenario);
  await verifyNodeObservationsAndReads(bin, scenario);
  await verifyNodeReadFailureDiagnostics(bin, scenario);
  await verifyNodeLoopObservedRegistrations(bin, scenario);
  await verifyNodeEffectiveRoot(bin, scenario);
  await verifyNodeFailureIsolation(bin, scenario);
  await verifyNodeRunLifecycle(bin, scenario);
  await verifyNodeAfterEndFailure(bin, scenario);
  await verifyNodeInterruptedProcess(bin, scenario);
  await verifyNodeStatusesAndIdentity(bin, scenario);
  await verifyNodeConflictPreflight(bin, scenario);
  await verifyOrdinaryNodeTest(scenario);
}

async function verifyNodeHappyRoundTrip(
  bin: string,
  consumer: string,
): Promise<void> {
  const firstCheck = await run(
    bin,
    ["check", "--config", "dock.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(firstCheck.code, 1, firstCheck.stderr);
  const initial = parseEnvelope(firstCheck.stdout);
  assert.equal(initial.variant, "changed", JSON.stringify(initial, null, 2));
  assertNodeExecutionSummary(requireReport(initial), 1, 2);

  const textCheck = await run(
    bin,
    ["check", "--config", "dock.config.mts"],
    consumer,
  );
  assert.equal(textCheck.code, 1, textCheck.stderr);
  assert.match(textCheck.stdout, /Binding business-acceptance/);
  assert.match(textCheck.stdout, /Change: binding added/);

  const update = await run(
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
  assert.equal(parseEnvelope(update.stdout).variant, "updated");
  await access(join(consumer, "dock.baseline.json"));

  const current = await run(
    bin,
    ["check", "--config", "dock.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(current.code, 0, current.stderr);
  assert.equal(parseEnvelope(current.stdout).variant, "consistent");
  assertNodeExecutionSummary(
    requireReport(parseEnvelope(current.stdout)),
    1,
    2,
  );

  const currentText = await run(
    bin,
    ["check", "--config", "dock.config.mts"],
    consumer,
  );
  assert.equal(currentText.code, 0, currentText.stderr);
  assert.equal(
    currentText.stdout,
    "Scope: business-acceptance\nAll checked bindings are consistent with baseline.\n",
  );
}

async function verifyNodeObservationsAndReads(
  bin: string,
  consumer: string,
): Promise<void> {
  const businessText = "😀—Reading: 温度 🧭：24\nAmount: 17\n";
  await writeFile(join(consumer, "read-business.txt"), businessText);
  await writeFile(
    join(consumer, "read-unassociated.txt"),
    "Unassociated: unassociated current content\n",
  );

  const update = await run(
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
  const updatedReport = requireReport(parseEnvelope(update.stdout));
  assertNodeExecutionSummary(updatedReport, 1, 1);
  assertNodeReadDiagnostic(
    updatedReport,
    "current-business-text",
    "温度 🧭：24",
    businessText.indexOf("温度 🧭：24"),
  );
  assertNodeReadDiagnostic(
    updatedReport,
    "current-business-amount",
    "17",
    businessText.indexOf("17"),
  );
  assertNodeReadDiagnostic(
    updatedReport,
    "unassociated-business-text",
    "unassociated current content",
  );

  const checkConsistent = await run(
    bin,
    ["check", "--config", "observations.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(checkConsistent.code, 0, checkConsistent.stderr);
  assert.equal(parseEnvelope(checkConsistent.stdout).variant, "consistent");
  const consistentReport = requireReport(parseEnvelope(checkConsistent.stdout));
  assertNodeReadDiagnostic(
    consistentReport,
    "current-business-text",
    "温度 🧭：24",
    businessText.indexOf("温度 🧭：24"),
  );

  const textConsistent = await run(
    bin,
    ["check", "--config", "observations.config.mts"],
    consumer,
  );
  assert.equal(textConsistent.code, 0, textConsistent.stderr);
  assert.match(
    textConsistent.stdout,
    /All checked bindings are consistent with baseline\./,
  );

  const changedBusinessText = businessText.replace("Amount: 17", "Amount: 19");
  await writeFile(join(consumer, "read-business.txt"), changedBusinessText);
  const changed = await run(
    bin,
    ["check", "--config", "observations.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(changed.code, 1, changed.stderr);
  assert.equal(parseEnvelope(changed.stdout).variant, "changed");

  const diagnostics = await run(
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
  assertNodeExecutionSummary(diagnosticReport, 1, 2);
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

  const diagnosticUpdate = await run(
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

async function verifyNodeLoopObservedRegistrations(
  bin: string,
  consumer: string,
): Promise<void> {
  const update = await run(
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
  assertNodeExecutionSummary(requireReport(updated), 1, 2);

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
}

async function verifyNodeReadFailureDiagnostics(
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
  const initialUpdate = await run(
    bin,
    ["baseline", "update", "--config", configuration, "--output", "structured"],
    consumer,
  );
  assert.equal(initialUpdate.code, 0, initialUpdate.stderr);
  const baselineBytes = await readFile(baselinePath);

  await writeFile(marker, "fail after current read\n");
  try {
    const check = await run(
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
    assertNodeReadDiagnostic(
      checkReport,
      "current-business-text",
      "温度 🧭：24",
      undefined,
      "business assertion fails after read",
    );

    const textCheck = await run(
      bin,
      ["check", "--config", configuration],
      consumer,
    );
    assert.equal(textCheck.code, 1, textCheck.stderr);
    assert.match(
      textCheck.stdout,
      /Error value-before-failure \(test-failed\)/,
    );

    const update = await run(
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

async function verifyNodeEffectiveRoot(
  bin: string,
  consumer: string,
): Promise<void> {
  const arguments_ = [
    "--config",
    "configurations/rooted.config.mts",
    "--output",
    "structured",
  ];
  const update = await run(
    bin,
    ["baseline", "update", ...arguments_],
    consumer,
  );
  assert.equal(update.code, 0, update.stderr);
  assert.equal(parseEnvelope(update.stdout).variant, "updated");
  await access(join(consumer, "effective-root", "rooted.baseline.json"));
}

async function verifyNodeFailureIsolation(
  bin: string,
  consumer: string,
): Promise<void> {
  const check = await run(
    bin,
    ["check", "--config", "isolation.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(check.code, 1, check.stderr);
  const report = requireReport(parseEnvelope(check.stdout));
  assertNodeExecutionSummary(report, 1, 2, 1);
  assertBindingError(report, "failing-business", "test-failed");
  assertBindingHasNoErrors(report, "independent-business");

  const update = await run(
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

async function verifyNodeRunLifecycle(
  bin: string,
  consumer: string,
): Promise<void> {
  for (const [config, bindingId, code] of [
    ["close-failure.config.mts", "close-status", "run-lifecycle-failed"],
    ["cancelled.config.mts", "entered", "test-cancelled"],
    ["cancelled.config.mts", "unentered", "test-not-executed"],
    ["startup-failure.config.mts", "startup-failure", "run-lifecycle-failed"],
  ] as const) {
    const check = await run(
      bin,
      ["check", "--config", config, "--output", "structured"],
      consumer,
    );
    assert.equal(check.code, 1, check.stderr);
    const envelope = parseEnvelope(check.stdout);
    assert.equal(envelope.variant, "errors");
    assertBindingError(requireReport(envelope), bindingId, code);
  }
}

async function verifyNodeAfterEndFailure(
  bin: string,
  consumer: string,
): Promise<void> {
  const configuration = "after-end.config.mts";
  const marker = join(consumer, "after-end.marker");
  const baselinePath = join(consumer, "after-end.baseline.json");
  const initialUpdate = await run(
    bin,
    ["baseline", "update", "--config", configuration, "--output", "structured"],
    consumer,
  );
  assert.equal(initialUpdate.code, 0, initialUpdate.stderr);
  const baselineBytes = await readFile(baselinePath);

  for (const failure of ["uncaught", "rejection", "exit"] as const) {
    await writeFile(marker, failure);
    try {
      const check = await run(
        bin,
        ["check", "--config", configuration, "--output", "structured"],
        consumer,
      );
      const update = await run(
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
      assert.equal(check.code, 1, check.stderr);
      assert.equal(parseEnvelope(check.stdout).variant, "errors");
      assertBindingError(
        requireReport(parseEnvelope(check.stdout)),
        "async-failure-binding",
        "run-lifecycle-failed",
      );
      assert.equal(update.code, 1, update.stderr);
      assert.equal(parseEnvelope(update.stdout).variant, "rejected");
      assertBindingError(
        requireReport(parseEnvelope(update.stdout)),
        "async-failure-binding",
        "run-lifecycle-failed",
      );
      assert.deepEqual(await readFile(baselinePath), baselineBytes);
    } finally {
      await rm(marker, { force: true });
    }
  }
}

async function verifyNodeInterruptedProcess(
  bin: string,
  consumer: string,
): Promise<void> {
  const baselinePath = join(consumer, "interrupted.baseline.json");
  const initial = await run(
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
  await writeFile(join(consumer, "interrupted.marker"), "interrupt\n");
  const baselineBytes = await readFile(baselinePath);

  const check = await run(
    bin,
    ["check", "--config", "interrupted.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(check.code, 1, check.stderr);
  assert.equal(check.signal, null);
  assert.equal(check.timedOut, false);
  assertBindingError(
    requireReport(parseEnvelope(check.stdout)),
    "interrupted-binding",
    "run-lifecycle-failed",
  );
  assert.deepEqual(await readFile(baselinePath), baselineBytes);

  const update = await run(
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
  assert.equal(parseEnvelope(update.stdout).variant, "rejected");
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
}

async function verifyNodeStatusesAndIdentity(
  bin: string,
  consumer: string,
): Promise<void> {
  const statuses = await run(
    bin,
    ["check", "--config", "statuses.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(statuses.code, 1, statuses.stderr);
  const statusReport = requireReport(parseEnvelope(statuses.stdout));
  assertBindingError(statusReport, "non-passing-binding", "test-skipped");
  assertBindingError(statusReport, "non-passing-binding", "test-todo");

  const filtered = await run(
    bin,
    ["check", "--config", "filtered.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(filtered.code, 1, filtered.stderr);
  const filteredReport = requireReport(parseEnvelope(filtered.stdout));
  assertBindingError(filteredReport, "filtered-binding", "test-filtered");
  assertBindingHasNoErrors(filteredReport, "kept-binding");

  const duplicate = await run(
    bin,
    ["check", "--config", "duplicate.config.mts", "--output", "structured"],
    consumer,
  );
  assert.equal(duplicate.code, 1, duplicate.stderr);
  assertBindingError(
    requireReport(parseEnvelope(duplicate.stdout)),
    "duplicate-binding",
    "duplicate-test-identity",
  );
}

async function verifyNodeConflictPreflight(
  bin: string,
  consumer: string,
): Promise<void> {
  const marker = join(consumer, "test-workspace", "conflict-started.marker");
  const check = await run(
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
  assert.equal(passing.code, 0, passing.stdout + passing.stderr);

  const failing = await run(
    process.execPath,
    ["--test", join(consumer, "test-workspace/test/ordinary-failure.test.mts")],
    consumer,
  );
  assert.equal(failing.code, 1, failing.stdout + failing.stderr);
}

async function verifyLegacyBaselineHardMigration(
  consumer: string,
): Promise<void> {
  const tsSource =
    "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}";
  await writeFile(join(consumer, "notes.txt"), "port=4173\n", "utf8");
  await writeFile(
    join(consumer, "guide.md"),
    "# Guide\n\nDefault port 4173.\n",
    "utf8",
  );
  await writeFile(join(consumer, "api.ts"), `${tsSource}\n`, "utf8");
  await mkdir(join(consumer, "test"), { recursive: true });
  await writeFile(
    join(consumer, "test", "app.test.mts"),
    [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      "",
      'void test("migration sample passes", () => {',
      "  assert.equal(1 + 1, 2);",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  // Genuine legacy version-2 baseline format (including embedded run in node-test target).
  const legacyBaseline = {
    version: 2,
    bindings: {
      "migration-policy": {
        definition: {
          id: "migration-policy",
          references: ["notes-port", "guide-section", "ts-greet", "node-pass"],
        },
        references: {
          "notes-port": {
            definition: {
              id: "notes-port",
              target: {
                pluginId: "@ykdz/dock-reference-file",
                target: "notes.txt",
                fileInfo: "notes.txt",
              },
              selection: {
                kind: "text",
                steps: [{ kind: "quote", text: "port=4173" }],
              },
            },
            value: "port=4173",
          },
          "guide-section": {
            definition: {
              id: "guide-section",
              target: {
                pluginId: "@ykdz/dock-reference-markdown",
                target: "guide.md",
                fileInfo: "guide.md",
              },
              selection: {
                kind: "markdown",
                steps: [{ kind: "section", heading: "Guide" }],
              },
            },
            value: "Default port 4173.",
          },
          "ts-greet": {
            definition: {
              id: "ts-greet",
              target: {
                pluginId: "@ykdz/dock-reference-typescript",
                target: "api.ts",
                fileInfo: "api.ts",
              },
              selection: {
                kind: "typescript",
                steps: [
                  { kind: "symbol", name: ["greet"], declaration: "function" },
                ],
              },
            },
            value: tsSource,
          },
          "node-pass": {
            definition: {
              id: "node-pass",
              target: {
                pluginId: "@ykdz/dock-reference-node-test",
                target: {
                  kind: "node-test-status",
                  run: {
                    identity: "migration-run",
                    files: ["test/app.test.mts"],
                    observationKeys: [],
                  },
                  file: "test/app.test.mts",
                  name: "migration sample passes",
                },
                fileInfo: "test/app.test.mts",
              },
            },
            value: { status: "passed" },
          },
        },
      },
    },
  };
  const baselinePath = join(consumer, "dock.baseline.json");
  const legacyBaselineBytes = `${JSON.stringify(legacyBaseline, null, 2)}\n`;
  await writeFile(baselinePath, legacyBaselineBytes, "utf8");

  await writeFile(
    join(consumer, "dock.config.mjs"),
    [
      'import { binding, defineConfig, file } from "@ykdz/dock";',
      'import { markdown } from "@ykdz/dock/markdown";',
      'import { typescript } from "@ykdz/dock/typescript";',
      'import { defineNodeTestRun, nodeTest, nodeTestStatus } from "@ykdz/dock/node-test";',
      "",
      'const testRun = defineNodeTestRun("migration-run", { files: ["test/app.test.mts"] });',
      "",
      "export default defineConfig({",
      "  plugins: [file, markdown, typescript, nodeTest],",
      "  bindings: [",
      '    binding("migration-policy", [',
      '      file.from("notes.txt").quote("port=4173").reference("notes-port"),',
      '      markdown.from("guide.md").section("Guide").reference("guide-section"),',
      '      typescript.from("api.ts").symbol("greet", "function").reference("ts-greet"),',
      '      nodeTestStatus("node-pass", testRun, { file: "test/app.test.mts", name: "migration sample passes" }),',
      "    ]),",
      "  ],",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  const bin = dockBin(consumer);
  for (const args of [
    ["check", "--config", "dock.config.mjs"],
    ["check", "--config", "dock.config.mjs", "--output", "structured"],
    ["baseline", "update", "--config", "dock.config.mjs"],
    [
      "baseline",
      "update",
      "--config",
      "dock.config.mjs",
      "--output",
      "structured",
    ],
  ]) {
    const failed: ProcessResult = await run(bin, args, consumer);
    assert.equal(failed.code, 1, failed.stdout + failed.stderr);
    assert.equal(failed.stdout, "");
    if (args.includes("structured")) {
      const envelope = parseEnvelope(failed.stderr);
      assert.equal(envelope.kind, "failure");
      assert.equal(envelope.variant, "maintenanceFailed");
      assert.equal(envelope.data?.code, "baseline-invalid");
      assert.match(
        envelope.data?.message ?? "",
        /Unsupported baseline version 2; expected version 3\./,
      );
      assert.match(
        envelope.data?.message ?? "",
        /dock baseline update --config/,
      );
    } else {
      assert.match(failed.stderr, /Maintenance failed \(baseline-invalid\)/);
      assert.match(
        failed.stderr,
        /Unsupported baseline version 2; expected version 3\./,
      );
      assert.match(failed.stderr, /dock baseline update --config/);
    }
    assert.equal(
      await readFile(baselinePath, "utf8"),
      legacyBaselineBytes,
      "Legacy version-2 baseline bytes must remain untouched on rejection.",
    );
  }

  // Follow explicit rebuild guidance: remove legacy baseline, rebuild v3, and re-check.
  await rm(baselinePath);
  const rebuilt = await run(
    bin,
    ["baseline", "update", "--config", "dock.config.mjs"],
    consumer,
  );
  assert.equal(rebuilt.code, 0, rebuilt.stdout + rebuilt.stderr);
  assert.match(rebuilt.stdout, /Baseline updated\./);

  const rebuiltJson = JSON.parse(await readFile(baselinePath, "utf8")) as {
    readonly version?: unknown;
    readonly bindings?: Record<
      string,
      {
        readonly references?: Record<
          string,
          {
            readonly definition?: {
              readonly target?: { readonly target?: unknown };
            };
          }
        >;
      }
    >;
  };
  assert.equal(rebuiltJson.version, 3);
  const nodePassTarget =
    rebuiltJson.bindings?.["migration-policy"]?.references?.["node-pass"]
      ?.definition?.target?.target;
  assert.ok(isRecord(nodePassTarget));
  assert.equal(Object.hasOwn(nodePassTarget, "run"), false);

  const recheckText = await run(
    bin,
    ["check", "--config", "dock.config.mjs"],
    consumer,
  );
  assert.equal(recheckText.code, 0, recheckText.stdout + recheckText.stderr);
  assert.equal(
    recheckText.stdout,
    "Scope: migration-policy\nAll checked bindings are consistent with baseline.\n",
  );

  const recheckStructured = await run(
    bin,
    ["check", "--config", "dock.config.mjs", "--output", "structured"],
    consumer,
  );
  assert.equal(recheckStructured.code, 0, recheckStructured.stderr);
  assert.equal(parseEnvelope(recheckStructured.stdout).variant, "consistent");
}

async function verifyV3BaselineDiagnostics(consumer: string): Promise<void> {
  await writeFile(join(consumer, "plain.txt"), "fact-v1\n", "utf8");
  await writeFile(
    join(consumer, "collection.json"),
    JSON.stringify({
      members: [
        {
          id: "member alpha",
          value: { status: "passed", customBusinessField: "keep-me", rank: 1 },
        },
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(consumer, "dock.config.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'import { binding, createReference, defineConfig, definePlugin } from "@ykdz/dock";',
      "",
      "const plugin = definePlugin({",
      '  id: "consumer:v3-diagnostics",',
      "  validate() {},",
      "  fileInfo(reference) {",
      '    return reference.target === "collection.json" ? "collection.json" : "plain.txt";',
      "  },",
      "  collect(request, context) {",
      "    return {",
      "      results: request.selectedReferences.map((reference) => {",
      '        if (reference.target === "collection.json") {',
      '          const data = JSON.parse(readFileSync(join(context.root, "collection.json"), "utf8"));',
      "          return {",
      "            referenceId: reference.id,",
      '            kind: "collection",',
      '            collection: { completeness: "complete", members: data.members },',
      "          };",
      "        }",
      '        const content = readFileSync(join(context.root, "plain.txt"), "utf8").trim();',
      "        return {",
      "          referenceId: reference.id,",
      '          kind: "value",',
      "          value: { text: content, customPlainField: { team: 'docs', ok: true } },",
      "        };",
      "      }),",
      "    };",
      "  },",
      "});",
      "",
      "export default defineConfig({",
      "  plugins: [plugin],",
      "  bindings: [",
      '    binding("docs policy.v1", [',
      '      createReference("consumer:v3-diagnostics", "plain fact", "plain.txt"),',
      '      createReference("consumer:v3-diagnostics", "suite.facts", "collection.json"),',
      "    ]),",
      "  ],",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  const bin = dockBin(consumer);
  const baselinePath = join(consumer, "dock.baseline.json");

  const initialUpdate = await run(
    bin,
    ["baseline", "update", "--config", "dock.config.mjs"],
    consumer,
  );
  assert.equal(
    initialUpdate.code,
    0,
    initialUpdate.stdout + initialUpdate.stderr,
  );
  const validBaselineRaw = await readFile(baselinePath, "utf8");

  // Positive case: custom business fields on plain value and member.value stay consistent, then report normal fact drift.
  const consistentCheck = await run(
    bin,
    ["check", "--config", "dock.config.mjs", "--output", "structured"],
    consumer,
  );
  assert.equal(consistentCheck.code, 0, consistentCheck.stderr);
  assert.equal(parseEnvelope(consistentCheck.stdout).variant, "consistent");

  await writeFile(join(consumer, "plain.txt"), "fact-v2\n", "utf8");
  const driftedCheck = await run(
    bin,
    ["check", "--config", "dock.config.mjs", "--output", "structured"],
    consumer,
  );
  assert.equal(driftedCheck.code, 1);
  assert.equal(driftedCheck.stderr, "");
  const driftedEnvelope = parseEnvelope(driftedCheck.stdout);
  assert.equal(driftedEnvelope.kind, "data");
  assert.equal(driftedEnvelope.variant, "changed");

  await writeFile(join(consumer, "plain.txt"), "fact-v1\n", "utf8");

  // Verify JS API check vs baseline-invalid error via child Node process importing installed @ykdz/dock.
  await writeFile(
    join(consumer, "verify-js.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { readFile } from "node:fs/promises";',
      'import { check, MaintenanceError, updateBaseline } from "@ykdz/dock";',
      "const mode = process.argv[2];",
      'if (mode === "consistent") {',
      '  const report = await check("./dock.config.mjs");',
      '  assert.equal(report.bindings[0]?.consistency, "consistent");',
      "} else {",
      '  const before = await readFile("./dock.baseline.json", "utf8");',
      '  await assert.rejects(() => check("./dock.config.mjs"), (err) => err instanceof MaintenanceError && err.code === "baseline-invalid");',
      '  await assert.rejects(() => updateBaseline("./dock.config.mjs"), (err) => err instanceof MaintenanceError && err.code === "baseline-invalid");',
      '  assert.equal(await readFile("./dock.baseline.json", "utf8"), before);',
      "}",
    ].join("\n"),
    "utf8",
  );
  const jsConsistent = await run(
    process.execPath,
    [join(consumer, "verify-js.mjs"), "consistent"],
    consumer,
  );
  assert.equal(jsConsistent.code, 0, jsConsistent.stdout + jsConsistent.stderr);

  // 1) Missing required reference fact vs extra reference fact.
  const missingObj = JSON.parse(validBaselineRaw) as {
    bindings: Record<string, { references: Record<string, unknown> }>;
  };
  delete missingObj.bindings["docs policy.v1"]!.references["suite.facts"];
  const missingRaw = `${JSON.stringify(missingObj, null, 2)}\n`;
  await writeFile(baselinePath, missingRaw, "utf8");

  for (const args of [
    ["check", "--config", "dock.config.mjs"],
    ["baseline", "update", "--config", "dock.config.mjs"],
  ]) {
    const failed = await run(bin, args, consumer);
    assert.equal(failed.code, 1);
    assert.equal(failed.stdout, "");
    assert.match(failed.stderr, /Maintenance failed \(baseline-invalid\)/);
    assert.match(failed.stderr, /dock\.baseline\.json/);
    assert.match(failed.stderr, /docs policy\.v1/);
    assert.match(failed.stderr, /suite\.facts/);
    assert.match(failed.stderr, /missing required reference fact/i);
    assert.equal(await readFile(baselinePath, "utf8"), missingRaw);
  }

  const extraObj = JSON.parse(validBaselineRaw) as {
    bindings: Record<string, { references: Record<string, unknown> }>;
  };
  extraObj.bindings["docs policy.v1"]!.references["extra.fact"] = {
    definition: {
      id: "extra.fact",
      target: {
        pluginId: "consumer:v3-diagnostics",
        target: "x",
        fileInfo: null,
      },
    },
    value: "extra",
  };
  const extraRaw = `${JSON.stringify(extraObj, null, 2)}\n`;
  await writeFile(baselinePath, extraRaw, "utf8");

  for (const args of [
    ["check", "--config", "dock.config.mjs", "--output", "structured"],
    [
      "baseline",
      "update",
      "--config",
      "dock.config.mjs",
      "--output",
      "structured",
    ],
  ]) {
    const failed = await run(bin, args, consumer);
    assert.equal(failed.code, 1);
    assert.equal(failed.stdout, "");
    const envelope = parseEnvelope(failed.stderr);
    assert.equal(envelope.kind, "failure");
    assert.equal(envelope.variant, "maintenanceFailed");
    assert.equal(envelope.data?.code, "baseline-invalid");
    assert.match(envelope.data?.message ?? "", /unexpected reference fact/i);
    assert.doesNotMatch(envelope.data?.message ?? "", /missing required/i);
    assert.match(envelope.data?.message ?? "", /docs policy\.v1/);
    assert.match(envelope.data?.message ?? "", /extra\.fact/);
    assert.equal(await readFile(baselinePath, "utf8"), extraRaw);
  }

  // 2) Duplicate keys + unknown fields on Dock-owned records and member-collection records + JS API rejection.
  const prettyRaw = `${JSON.stringify(JSON.parse(validBaselineRaw), null, 2)}\n`;
  const multiCorrupted = prettyRaw
    .replace('"version": 3', '"unknownRoot": true,\n  "version": 3')
    .replace('"value": {', '"vaule": "typo",\n          "value": {')
    .replace(
      '"id": "plain fact",',
      '"id": "plain fact",\n              "id": "plain fact",',
    )
    .replace(
      '"id": "member alpha",',
      '"id": "member alpha",\n                "memberExtra": "bad",',
    );
  assert.notEqual(multiCorrupted, prettyRaw);
  await writeFile(baselinePath, multiCorrupted, "utf8");

  const multiText = await run(
    bin,
    ["check", "--config", "dock.config.mjs"],
    consumer,
  );
  assert.equal(multiText.code, 1);
  assert.equal(multiText.stdout, "");
  assert.match(multiText.stderr, /Maintenance failed \(baseline-invalid\)/);
  assert.match(multiText.stderr, /\$\.unknownRoot/);
  assert.match(multiText.stderr, /references\["plain fact"\]\.vaule/);
  assert.match(multiText.stderr, /references\["plain fact"\]\.definition\.id/);
  assert.match(multiText.stderr, /value\[0\]\.memberExtra/);

  const multiUpdate = await run(
    bin,
    ["baseline", "update", "--config", "dock.config.mjs"],
    consumer,
  );
  assert.equal(multiUpdate.code, 1);
  assert.equal(await readFile(baselinePath, "utf8"), multiCorrupted);

  const jsCorrupted = await run(
    process.execPath,
    [join(consumer, "verify-js.mjs"), "corrupted"],
    consumer,
  );
  assert.equal(jsCorrupted.code, 0, jsCorrupted.stdout + jsCorrupted.stderr);
}

function requireReport(envelope: CliEnvelope): MaintenanceReport {
  assert.ok(envelope.data?.report !== undefined);
  return envelope.data.report as MaintenanceReport;
}

function requireNodeDiagnostic(report: MaintenanceReport): NodeDiagnosticData {
  const diagnostic = report.pluginDiagnostics.find(
    (item) => item.pluginId === "@ykdz/dock-reference-node-test",
  );
  assert.ok(diagnostic, "Report is missing Node test plugin diagnostics.");
  return diagnostic.data as NodeDiagnosticData;
}

function assertNodeExecutionSummary(
  report: MaintenanceReport,
  commandAttempts: number,
  testExecutions: number,
  failedCommands = 0,
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
  assert.equal(
    diagnostic.runs.reduce((sum, runItem) => sum + runItem.testExecutions, 0),
    testExecutions,
  );
}

function assertNodeReadDiagnostic(
  report: MaintenanceReport,
  referenceId: string,
  value: unknown,
  start?: number,
  testName = "read current value and record observations",
): void {
  const diagnostic = requireNodeDiagnostic(report);
  const read = diagnostic.runs
    .flatMap((runItem) => runItem.reads)
    .find((candidate) => candidate.referenceId === referenceId);
  assert.ok(
    read,
    `Execution report did not include read ${referenceId}: ${JSON.stringify(diagnostic)}`,
  );
  assert.equal(read.value, value);
  const identity = JSON.parse(read.testId) as unknown;
  assert.ok(isRecord(identity));
  assert.equal(identity.name, testName);
  if (start !== undefined) {
    assert.ok(read.range);
    assert.equal(read.range.start, start);
    assert.equal(read.range.end, start + String(value).length);
  }
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
