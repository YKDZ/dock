import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type ProcessResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
};

type ProcessIdentity = {
  readonly uid: number;
  readonly gid: number;
};

type RecordValue = Record<string, unknown>;

type CliEnvelope = {
  readonly kind: string;
  readonly variant?: string;
  readonly data?: {
    readonly report?: unknown;
    readonly code?: string;
    readonly errors?: readonly {
      readonly code: string;
      readonly message: string;
    }[];
  };
};

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDirectory = join(
  packageDirectory,
  "fixtures",
  "installed-consumer",
  "file",
);
const compiler = join(
  packageDirectory,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc",
);

function dockBin(consumer: string): string {
  return join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "dock.cmd" : "dock",
  );
}

export async function verifyInstalledFile(tarball: string): Promise<void> {
  const consumer = await mkdtemp(join(tmpdir(), "dock-file-installed-"));
  try {
    await installConsumer(consumer, [tarball], "dock-file-installed-consumer");
    await runInstalledCli(consumer);
    await verifyInstalledTextRead(consumer);
    await verifyInstalledScope(consumer);
    await verifyInstalledCurrentConfig(consumer);
    await verifyInstalledPaths(consumer);
    await verifyMixedThirdPartyAndFileBaseline(consumer);
    process.stdout.write(
      "Clean consumer @ykdz/dock file, text-read, scope, paths, third-party co-registration, and CLI verification passed.\n",
    );
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}

async function installConsumer(
  consumer: string,
  tarballs: readonly string[],
  name: string,
): Promise<void> {
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name, private: true, type: "module" }),
  );
  const install = await run(
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
    install.code,
    0,
    `Clean tarball installation failed:\n${install.stdout}\n${install.stderr}`,
  );
}

async function runConsumerTypechecks(consumer: string): Promise<void> {
  for (const fixture of [
    "positive.mts",
    "negative.mts",
    "tsconfig.json",
    "composition.mts",
    "composition-consumer.mts",
    "external-plugin.mts",
    "reexported-declarations.mts",
    "paths-positive.mts",
    "paths-negative.mts",
  ]) {
    await copyFixture(consumer, fixture);
  }
  const result = await run(
    compiler,
    ["-p", join(consumer, "tsconfig.json"), "--pretty", "false"],
    consumer,
  );
  assert.equal(
    result.code,
    0,
    `Installed file public type checks failed:\n${result.stdout}\n${result.stderr}`,
  );
}

async function runInstalledCli(consumer: string): Promise<void> {
  await runConsumerTypechecks(consumer);
  await copyFixture(consumer, "inspect-runtime.mjs");
  await copyFixture(consumer, "public-api-consumer.mjs");

  for (const [fixture, label] of [
    ["composition-consumer.mts", "split declarations and plugin dispatch"],
    ["inspect-runtime.mjs", "unified inspect and core model replay"],
    ["public-api-consumer.mjs", "public maintenance round-trip"],
  ] as const) {
    const installedRuntime = await run(
      process.execPath,
      [join(consumer, fixture)],
      consumer,
    );
    assert.equal(
      installedRuntime.code,
      0,
      `Installed runtime verification failed (${label}):\n${installedRuntime.stdout}\n${installedRuntime.stderr}`,
    );
  }

  await copyFixture(consumer, "dock.config.mjs");
  await copyFixture(consumer, "dock.config.ts");
  await copyFixture(consumer, "declarations.mjs");
  await copyFixture(consumer, "handler-file-config.mjs");
  await copyFixture(consumer, "handler-other-config.mjs");
  await writeFile(join(consumer, "guide.md"), "First edition body\n", "utf8");
  await writeFile(join(consumer, "copy.md"), "First edition body\n", "utf8");

  const bin = dockBin(consumer);
  const installedHost = JSON.parse(
    await readFile(
      join(consumer, "node_modules", "@ykdz", "dock", "package.json"),
      "utf8",
    ),
  ) as { readonly version: string };
  const version = await run(bin, ["--version"], consumer);
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stdout.trim(), installedHost.version);

  const missingConfigOption = await run(bin, ["check"], consumer);
  assert.equal(missingConfigOption.code, 64, missingConfigOption.stderr);

  const missingConfigFile = await run(
    bin,
    ["check", "--config", "missing.mjs", "--json"],
    consumer,
  );
  assert.equal(missingConfigFile.code, 1, missingConfigFile.stderr);
  const loadFailure = parseEnvelope(missingConfigFile.stderr);
  assert.equal(loadFailure.kind, "failure");
  assert.match(loadFailure.data?.code ?? "", /config-load-failed/);

  const typescriptConfig = await run(
    bin,
    ["check", "--config", "dock.config.ts", "--json"],
    consumer,
  );
  assert.equal(typescriptConfig.code, 1, typescriptConfig.stderr);
  assert.equal(parseEnvelope(typescriptConfig.stdout).variant, "changed");

  const firstCheck = await run(
    bin,
    ["check", "--config", "dock.config.mjs", "--json"],
    consumer,
  );
  assert.equal(firstCheck.code, 1, firstCheck.stderr);
  const firstEnvelope = parseEnvelope(firstCheck.stdout);
  assert.equal(firstEnvelope.kind, "data");
  assert.equal(firstEnvelope.variant, "changed");
  assert.deepEqual(readReport(firstEnvelope).scope, ["guide-policy"]);
  await assert.rejects(access(join(consumer, "dock.baseline.json")), {
    code: "ENOENT",
  });

  const update = await run(
    bin,
    ["baseline", "update", "--config", "dock.config.mjs", "--json"],
    consumer,
  );
  assert.equal(update.code, 0, update.stderr);
  assert.equal(parseEnvelope(update.stdout).variant, "updated");
  const oldBaseline = await readFile(join(consumer, "dock.baseline.json"));
  await verifyBaselineFilesystemFailures(bin, consumer);

  const emptyConfigDirectory = join(consumer, "empty-config");
  await mkdir(emptyConfigDirectory);
  await writeFile(
    join(emptyConfigDirectory, "dock.config.mjs"),
    'import { defineConfig } from "@ykdz/dock";\nexport default defineConfig({ plugins: [], bindings: [] });\n',
  );
  const emptyUpdate = await run(
    bin,
    [
      "baseline",
      "update",
      "--config",
      "empty-config/dock.config.mjs",
      "--json",
    ],
    consumer,
  );
  assert.equal(emptyUpdate.code, 1, emptyUpdate.stderr);
  const emptyUpdateEnvelope = parseEnvelope(emptyUpdate.stdout);
  assert.equal(emptyUpdateEnvelope.kind, "data");
  assert.equal(emptyUpdateEnvelope.variant, "rejected");
  assert.equal(emptyUpdateEnvelope.data?.errors?.[0]?.code, "empty-selection");
  const emptyUpdateText = await run(
    bin,
    ["baseline", "update", "--config", "empty-config/dock.config.mjs"],
    consumer,
  );
  assert.equal(emptyUpdateText.code, 1, emptyUpdateText.stderr);
  assert.match(emptyUpdateText.stdout, /更新错误（empty-selection）/);

  const textCheck = await run(
    bin,
    ["check", "--config", "dock.config.mjs"],
    consumer,
  );
  assert.equal(textCheck.code, 0, textCheck.stderr);
  assert.match(textCheck.stdout, /范围：guide-policy/);
  assert.match(textCheck.stdout, /引用 guide，文件 .*guide\.md/);
  assert.match(textCheck.stdout, /当前事实："First edition body\\n"/);
  assert.match(
    textCheck.stdout,
    new RegExp(
      `位置 guide\\.md（文本偏移 0–${String("First edition body\n".length)}）`,
    ),
  );
  assert.doesNotMatch(textCheck.stdout, /"pluginId"|"fileInfo"/);

  const childDirectory = join(consumer, "scripts");
  await mkdir(childDirectory, { recursive: true });
  const childCheck = await run(
    bin,
    ["check", "--config", "../dock.config.mjs", "--json"],
    childDirectory,
  );
  assert.equal(childCheck.code, 0, childCheck.stderr);

  await writeFile(
    join(consumer, "declarations.mjs"),
    'export const target = "copy.md";\n',
  );
  const targetChange = await run(
    bin,
    ["check", "--config", "dock.config.mjs", "--json"],
    consumer,
  );
  assert.equal(targetChange.code, 1, targetChange.stderr);
  const targetChangeReport = readReport(parseEnvelope(targetChange.stdout));
  assert.equal(
    targetChangeReport.bindings[0]?.changes[0]?.kind,
    "reference-definition",
  );
  const targetChangeText = await run(
    bin,
    ["check", "--config", "dock.config.mjs"],
    consumer,
  );
  assert.equal(targetChangeText.code, 1, targetChangeText.stderr);
  assert.match(targetChangeText.stdout, /引用 guide 定义变化/);
  assert.match(targetChangeText.stdout, /旧目标文件 .*guide\.md/);
  assert.match(targetChangeText.stdout, /新目标文件 .*copy\.md/);
  assert.match(targetChangeText.stdout, /当前事实："First edition body\\n"/);
  assert.doesNotMatch(targetChangeText.stdout, /"pluginId"|"fileInfo"/);

  const acceptTarget = await run(
    bin,
    ["baseline", "update", "--config", "dock.config.mjs", "--json"],
    consumer,
  );
  assert.equal(acceptTarget.code, 0, acceptTarget.stderr);
  await writeFile(join(consumer, "copy.md"), "Second edition body\n", "utf8");
  const bodyChange = await run(
    bin,
    ["check", "--config", "dock.config.mjs", "--json"],
    consumer,
  );
  assert.equal(bodyChange.code, 1, bodyChange.stderr);
  assert.equal(
    readReport(parseEnvelope(bodyChange.stdout)).bindings[0]?.changes[0]?.kind,
    "fact",
  );
  const bodyChangeText = await run(
    bin,
    ["check", "--config", "dock.config.mjs"],
    consumer,
  );
  assert.equal(bodyChangeText.code, 1, bodyChangeText.stderr);
  assert.match(bodyChangeText.stdout, /旧值 "First edition body\\n"/);
  assert.match(bodyChangeText.stdout, /新值 "Second edition body\\n"/);

  await writeFile(join(consumer, "copy.md"), "Third edition body\n", "utf8");
  const acceptBody = await run(
    bin,
    ["baseline", "update", "--config", "dock.config.mjs", "--json"],
    consumer,
  );
  assert.equal(acceptBody.code, 0, acceptBody.stderr);

  const handlerBaseline = await run(
    bin,
    ["baseline", "update", "--config", "handler-file-config.mjs", "--json"],
    consumer,
  );
  assert.equal(handlerBaseline.code, 0, handlerBaseline.stderr);
  const changedHandler = await run(
    bin,
    ["check", "--config", "handler-other-config.mjs", "--json"],
    consumer,
  );
  assert.equal(changedHandler.code, 1, changedHandler.stderr);
  const changedHandlerReport = parseEnvelope(changedHandler.stdout).data
    ?.report as
    | {
        readonly bindings: readonly {
          readonly changes: readonly {
            readonly kind: string;
          }[];
        }[];
      }
    | undefined;
  assert.deepEqual(
    changedHandlerReport?.bindings[0]?.changes.map((change) => change.kind),
    ["reference-definition"],
    "Changing plugin handler with identical target and fact must report only reference-definition change.",
  );

  const currentBaseline = await readFile(join(consumer, "dock.baseline.json"));
  const acceptedFacts = JSON.parse(currentBaseline.toString("utf8")) as {
    readonly bindings: {
      readonly [bindingId: string]: {
        readonly references: {
          readonly [referenceId: string]: { readonly value: unknown };
        };
      };
    };
  };
  assert.equal(
    acceptedFacts.bindings["guide-policy"]?.references.guide?.value,
    "Third edition body\n",
    "update must re-collect facts created after check.",
  );

  await rm(join(consumer, "copy.md"));
  const missingTarget = await run(
    bin,
    ["check", "--config", "dock.config.mjs", "--json"],
    consumer,
  );
  assert.equal(missingTarget.code, 1, missingTarget.stderr);
  assert.equal(parseEnvelope(missingTarget.stdout).variant, "errors");
  const missingTargetText = await run(
    bin,
    ["check", "--config", "dock.config.mjs"],
    consumer,
  );
  assert.equal(missingTargetText.code, 1, missingTargetText.stderr);
  assert.match(missingTargetText.stdout, /关联 guide-policy/);
  assert.match(missingTargetText.stdout, /错误 guide/);
  const rejectedUpdate = await run(
    bin,
    ["baseline", "update", "--config", "dock.config.mjs", "--json"],
    consumer,
  );
  assert.equal(rejectedUpdate.code, 1, rejectedUpdate.stderr);
  assert.equal(parseEnvelope(rejectedUpdate.stdout).variant, "rejected");
  assert.deepEqual(
    await readFile(join(consumer, "dock.baseline.json")),
    currentBaseline,
  );
  assert.notDeepEqual(currentBaseline, oldBaseline);

  await runCliValidationFailures(bin, consumer, currentBaseline);

  await writeFile(join(consumer, "dock.baseline.json"), "{not json", "utf8");
  const corruptBaseline = await run(
    bin,
    ["check", "--config", "dock.config.mjs", "--json"],
    consumer,
  );
  assert.equal(corruptBaseline.code, 1, corruptBaseline.stderr);
  assert.match(corruptBaseline.stderr, /baseline-invalid/);
  assert.equal(
    await readFile(join(consumer, "dock.baseline.json"), "utf8"),
    "{not json",
  );
}

async function runCliValidationFailures(
  bin: string,
  consumer: string,
  currentBaseline: Buffer,
): Promise<void> {
  await writeFile(
    join(consumer, "invalid.mjs"),
    'export default { plugins: [{ id: "unused", validate() {}, collect() { throw new Error("must not collect"); } }] };\n',
  );
  const invalidConfig = await run(
    bin,
    ["baseline", "update", "--config", "invalid.mjs", "--json"],
    consumer,
  );
  assert.equal(invalidConfig.code, 1, invalidConfig.stderr);
  const invalidEnvelope = parseEnvelope(invalidConfig.stderr);
  assert.equal(invalidEnvelope.kind, "failure");
  assert.match(invalidEnvelope.data?.code ?? "", /maintenance-failed/);
  assert.match(invalidConfig.stderr, /Config must provide a bindings list/);
  assert.doesNotMatch(invalidConfig.stderr, /must not collect/);
  assert.deepEqual(
    await readFile(join(consumer, "dock.baseline.json")),
    currentBaseline,
  );

  await writeFile(
    join(consumer, "unsupported-selection.mjs"),
    [
      'import { file } from "@ykdz/dock";',
      'export default { plugins: [file], bindings: [{ id: "selected-policy", references: [{ id: "selected", pluginId: "@ykdz/dock-reference-file", target: "guide.md", selection: { start: 0 } }] }] };',
    ].join("\n"),
  );
  const unsupportedSelection = await run(
    bin,
    ["check", "--config", "unsupported-selection.mjs", "--json"],
    consumer,
  );
  assert.equal(unsupportedSelection.code, 1, unsupportedSelection.stderr);
  assert.match(
    unsupportedSelection.stderr,
    /Invalid selection for file reference selected/,
  );

  await writeFile(
    join(consumer, "invalid-builder-target.mjs"),
    [
      'import { binding, defineConfig, file } from "@ykdz/dock";',
      'const unused = { id: "unused", validate() {}, collect() { throw new Error("must not collect"); } };',
      'const invalid = file.from(42).reference("invalid-target");',
      'export default defineConfig({ plugins: [file, unused], bindings: [binding("invalid-target-policy", [invalid])] });',
    ].join("\n"),
  );
  const invalidBuilderTarget = await run(
    bin,
    ["check", "--config", "invalid-builder-target.mjs", "--json"],
    consumer,
  );
  assert.equal(invalidBuilderTarget.code, 1, invalidBuilderTarget.stderr);
  assert.match(invalidBuilderTarget.stderr, /config-load-failed/);
  assert.match(invalidBuilderTarget.stderr, /Plain file reference target must/);
  assert.doesNotMatch(invalidBuilderTarget.stderr, /must not collect/);

  await writeFile(
    join(consumer, "invalid-raw-target.mjs"),
    [
      'import { file } from "@ykdz/dock";',
      'const unused = { id: "unused", validate() {}, collect() { throw new Error("must not collect"); } };',
      'export default { plugins: [unused, file], bindings: [{ id: "invalid-target-policy", references: [{ id: "unused-reference", pluginId: "unused", target: "guide.md" }, { id: "invalid-target", pluginId: "@ykdz/dock-reference-file", target: 42 }] }] };',
    ].join("\n"),
  );
  const invalidRawTarget = await run(
    bin,
    ["check", "--config", "invalid-raw-target.mjs", "--json"],
    consumer,
  );
  assert.equal(invalidRawTarget.code, 1, invalidRawTarget.stderr);
  assert.match(
    invalidRawTarget.stderr,
    /Invalid target for file reference invalid-target/,
  );
  assert.match(invalidRawTarget.stderr, /Plain file reference target must/);
  assert.doesNotMatch(invalidRawTarget.stderr, /must not collect/);

  await writeFile(
    join(consumer, "invalid-raw-selection.mjs"),
    [
      'import { catalogPlugin } from "./external-plugin.mts";',
      'export default { plugins: [catalogPlugin], bindings: [{ id: "invalid-selection-policy", references: [{ id: "invalid-selection", pluginId: "@fixture/catalog", target: { kind: "catalog", path: "catalog.json" }, selection: { field: "summary" } }] }] };',
    ].join("\n"),
  );
  const invalidRawSelection = await run(
    bin,
    ["check", "--config", "invalid-raw-selection.mjs", "--json"],
    consumer,
  );
  assert.equal(invalidRawSelection.code, 1, invalidRawSelection.stderr);
  assert.match(
    invalidRawSelection.stderr,
    /rejected declaration of reference invalid-selection/,
  );
  assert.match(invalidRawSelection.stderr, /Invalid catalog reference/);

  await writeFile(
    join(consumer, "shared-unregistered.mjs"),
    [
      'const unused = { id: "unused", validate() {}, collect() { throw new Error("must not collect"); } };',
      'const first = { id: "shared", pluginId: "missing-plugin", target: "guide.md", declaredAt: "first-declaration.mjs" };',
      'const second = { id: "shared", pluginId: "missing-plugin", target: "guide.md", declaredAt: "second-declaration.mjs" };',
      'export default { plugins: [unused], bindings: [{ id: "first-policy", references: [first] }, { id: "second-policy", references: [second] }] };',
    ].join("\n"),
  );
  const sharedUnregistered = await run(
    bin,
    ["check", "--config", "shared-unregistered.mjs", "--json"],
    consumer,
  );
  assert.equal(sharedUnregistered.code, 1, sharedUnregistered.stderr);
  assert.match(
    sharedUnregistered.stderr,
    /unregistered plugin: missing-plugin/,
  );
  assert.match(sharedUnregistered.stderr, /first-declaration\.mjs/);
  assert.match(sharedUnregistered.stderr, /second-declaration\.mjs/);
  assert.doesNotMatch(sharedUnregistered.stderr, /must not collect/);

  await writeFile(
    join(consumer, "unregistered.mjs"),
    [
      'const unused = { id: "unused", validate() {}, collect() { throw new Error("must not collect"); } };',
      'export default { plugins: [unused], bindings: [{ id: "unregistered-policy", references: [{ id: "unregistered-reference", pluginId: "missing-plugin", target: "guide.md", declaredAt: "declarations.mjs" }] }] };',
    ].join("\n"),
  );
  const unregisteredPlugin = await run(
    bin,
    ["check", "--config", "unregistered.mjs", "--json"],
    consumer,
  );
  assert.equal(unregisteredPlugin.code, 1, unregisteredPlugin.stderr);
  assert.match(
    unregisteredPlugin.stderr,
    /unregistered plugin: missing-plugin/,
  );
  assert.match(
    unregisteredPlugin.stderr,
    /declaration sources: declarations\.mjs/,
  );
  assert.match(unregisteredPlugin.stderr, /config entry .*unregistered\.mjs/i);
  assert.doesNotMatch(unregisteredPlugin.stderr, /must not collect/);

  await writeFile(
    join(consumer, "duplicate.mjs"),
    [
      'const unused = { id: "unused", validate() {}, collect() { throw new Error("must not collect"); } };',
      'const reference = { id: "guide", pluginId: "unused", target: "guide.md" };',
      'export default { plugins: [unused], bindings: [{ id: "duplicate-policy", references: [reference] }, { id: "duplicate-policy", references: [reference] }] };',
    ].join("\n"),
  );
  const duplicateBinding = await run(
    bin,
    ["check", "--config", "duplicate.mjs", "--json"],
    consumer,
  );
  assert.equal(duplicateBinding.code, 1, duplicateBinding.stderr);
  assert.match(
    duplicateBinding.stderr,
    /Duplicate binding ID: duplicate-policy/,
  );
  assert.doesNotMatch(duplicateBinding.stderr, /must not collect/);

  await writeFile(
    join(consumer, "duplicate-binding-object.mjs"),
    [
      'const unused = { id: "unused", validate() {}, collect() { throw new Error("must not collect"); } };',
      'const reference = { id: "guide", pluginId: "unused", target: "guide.md" };',
      'const binding = { id: "duplicate-object-policy", references: [reference] };',
      "export default { plugins: [unused], bindings: [binding, binding] };",
    ].join("\n"),
  );
  const duplicateBindingObject = await run(
    bin,
    ["check", "--config", "duplicate-binding-object.mjs", "--json"],
    consumer,
  );
  assert.equal(duplicateBindingObject.code, 1, duplicateBindingObject.stderr);
  assert.match(
    duplicateBindingObject.stderr,
    /Duplicate binding ID: duplicate-object-policy/,
  );
  assert.doesNotMatch(duplicateBindingObject.stderr, /must not collect/);

  await writeFile(
    join(consumer, "duplicate-reference.mjs"),
    [
      'const unused = { id: "unused", validate() {}, collect() { throw new Error("must not collect"); } };',
      'const reference = { id: "guide", pluginId: "unused", target: "guide.md" };',
      'export default { plugins: [unused], bindings: [{ id: "duplicate-reference-policy", references: [reference, reference] }] };',
    ].join("\n"),
  );
  const duplicateReference = await run(
    bin,
    ["check", "--config", "duplicate-reference.mjs", "--json"],
    consumer,
  );
  assert.equal(duplicateReference.code, 1, duplicateReference.stderr);
  assert.match(duplicateReference.stderr, /duplicate ID: guide/);
  assert.doesNotMatch(duplicateReference.stderr, /must not collect/);

  await writeFile(
    join(consumer, "duplicate-plugin.mjs"),
    [
      'const unused = { id: "unused", validate() {}, collect() { throw new Error("must not collect"); } };',
      'export default { plugins: [unused, unused], bindings: [{ id: "duplicate-plugin-policy", references: [{ id: "guide", pluginId: "unused", target: "guide.md" }] }] };',
    ].join("\n"),
  );
  const duplicatePlugin = await run(
    bin,
    ["check", "--config", "duplicate-plugin.mjs", "--json"],
    consumer,
  );
  assert.equal(duplicatePlugin.code, 1, duplicatePlugin.stderr);
  assert.match(duplicatePlugin.stderr, /Duplicate reference plugin ID: unused/);
  assert.doesNotMatch(duplicatePlugin.stderr, /must not collect/);

  await writeFile(
    join(consumer, "conflicting-reference.mjs"),
    [
      'const unused = { id: "unused", validate() {}, collect() { throw new Error("must not collect"); } };',
      'export default { plugins: [unused], bindings: [{ id: "first-policy", references: [{ id: "shared-guide", pluginId: "unused", target: "guide.md", declaredAt: "first-conflict.mjs" }] }, { id: "second-policy", references: [{ id: "shared-guide", pluginId: "unused", target: "copy.md", declaredAt: "second-conflict.mjs" }] }] };',
    ].join("\n"),
  );
  const conflictingReference = await run(
    bin,
    ["check", "--config", "conflicting-reference.mjs", "--json"],
    consumer,
  );
  assert.equal(conflictingReference.code, 1, conflictingReference.stderr);
  assert.match(
    conflictingReference.stderr,
    /Reference ID shared-guide maps to multiple distinct definitions/,
  );
  assert.match(conflictingReference.stderr, /first-conflict\.mjs/);
  assert.match(conflictingReference.stderr, /second-conflict\.mjs/);
  assert.doesNotMatch(conflictingReference.stderr, /must not collect/);
}

async function verifyBaselineFilesystemFailures(
  bin: string,
  consumer: string,
): Promise<void> {
  const currentUid = process.getuid?.();
  assert.notEqual(
    currentUid,
    undefined,
    "Baseline permission verification requires a POSIX uid/gid environment.",
  );
  const identity = currentUid === 0 ? { uid: 65534, gid: 65534 } : undefined;
  const directory = join(consumer, "restricted-baseline");
  const config = join(directory, "dock.config.mjs");
  const target = join(directory, "guide.txt");
  const baseline = join(directory, "dock.baseline.json");

  await mkdir(directory);
  await writeFile(
    config,
    [
      'import { binding, defineConfig, file } from "@ykdz/dock";',
      'export default defineConfig({ plugins: [file], bindings: [binding("restricted-policy", [file.from("guide.txt").reference("restricted-guide")])] });',
    ].join("\n"),
  );
  await writeFile(target, "Original fact\n", "utf8");
  const initial = await run(
    bin,
    [
      "baseline",
      "update",
      "--config",
      "restricted-baseline/dock.config.mjs",
      "--json",
    ],
    consumer,
  );
  assert.equal(initial.code, 0, initial.stderr);
  const originalBytes = await readFile(baseline);

  await writeFile(target, "Updated fact\n", "utf8");
  await chmod(consumer, 0o755);
  await chmod(config, 0o444);
  await chmod(target, 0o444);
  await chmod(baseline, 0o444);
  await chmod(directory, currentUid === 0 ? 0o1777 : 0o555);

  try {
    const failedUpdate = await run(
      bin,
      [
        "baseline",
        "update",
        "--config",
        "restricted-baseline/dock.config.mjs",
        "--json",
      ],
      consumer,
      identity,
    );
    assert.equal(failedUpdate.code, 1, failedUpdate.stderr);
    const failedUpdateEnvelope = parseEnvelope(failedUpdate.stderr);
    assert.equal(failedUpdateEnvelope.kind, "failure");
    assert.match(
      failedUpdateEnvelope.data?.code ?? "",
      /baseline-write-failed/,
    );
    assert.deepEqual(await readFile(baseline), originalBytes);

    await chmod(baseline, 0);
    const unreadableBaseline = await run(
      bin,
      ["check", "--config", "restricted-baseline/dock.config.mjs", "--json"],
      consumer,
      identity,
    );
    assert.equal(unreadableBaseline.code, 1, unreadableBaseline.stderr);
    const unreadableEnvelope = parseEnvelope(unreadableBaseline.stderr);
    assert.equal(unreadableEnvelope.kind, "failure");
    assert.match(unreadableEnvelope.data?.code ?? "", /baseline-read-failed/);
    await chmod(baseline, 0o644);
    assert.deepEqual(await readFile(baseline), originalBytes);
  } finally {
    await chmod(directory, 0o755).catch(() => undefined);
    await chmod(config, 0o644).catch(() => undefined);
    await chmod(target, 0o644).catch(() => undefined);
    await chmod(baseline, 0o644).catch(() => undefined);
  }
}

async function verifyMixedThirdPartyAndFileBaseline(
  consumer: string,
): Promise<void> {
  const scenario = await mkdtemp(join(consumer, "mixed-plugin-"));
  const bin = dockBin(consumer);
  try {
    await writeFile(join(scenario, "guide.md"), "port=4173\n", "utf8");
    await writeFile(
      join(scenario, "dock.config.mjs"),
      [
        'import { binding, createReference, defineConfig, definePlugin, file, filePluginId } from "@ykdz/dock";',
        "const customPlugin = definePlugin({",
        '  id: "@fixture/third-party",',
        "  validate() {},",
        "  collect(request) {",
        "    return {",
        "      results: request.selectedReferences.map((reference) => ({",
        "        referenceId: reference.id,",
        '        kind: "value",',
        "        value: reference.target,",
        "      })),",
        "    };",
        "  },",
        "});",
        'if (filePluginId !== "@ykdz/dock-reference-file") throw new Error("Unexpected filePluginId");',
        "export default defineConfig({",
        "  plugins: [file, customPlugin],",
        "  bindings: [",
        '    binding("mixed-policy", [',
        '      file.from("guide.md").match("port=(\\\\d+)", 1).reference("port"),',
        '      createReference("@fixture/third-party", "expected-port", "4173"),',
        "    ]),",
        "  ],",
        "});",
      ].join("\n"),
      "utf8",
    );

    const updated = await run(
      bin,
      ["baseline", "update", "--config", "dock.config.mjs", "--json"],
      scenario,
    );
    assert.equal(updated.code, 0, updated.stderr);
    const baseline = JSON.parse(
      await readFile(join(scenario, "dock.baseline.json"), "utf8"),
    ) as {
      readonly bindings: Record<
        string,
        {
          readonly references: Record<
            string,
            {
              readonly definition: {
                readonly target: { readonly pluginId?: string };
              };
              readonly value: unknown;
            }
          >;
        }
      >;
    };
    const mixed = baseline.bindings["mixed-policy"];
    assert.ok(mixed);
    assert.equal(
      mixed.references.port?.definition.target.pluginId,
      "@ykdz/dock-reference-file",
    );
    assert.equal(mixed.references.port?.value, "4173");
    assert.equal(
      mixed.references["expected-port"]?.definition.target.pluginId,
      "@fixture/third-party",
    );
    assert.equal(mixed.references["expected-port"]?.value, "4173");

    await writeFile(join(scenario, "guide.md"), "port=5173\n", "utf8");
    const changed = await run(
      bin,
      ["check", "--config", "dock.config.mjs", "--json"],
      scenario,
    );
    assert.equal(changed.code, 1, changed.stderr);
    const report = readReport(parseEnvelope(changed.stdout));
    assert.equal(report.bindings[0]?.changes[0]?.kind, "fact");
  } finally {
    await rm(scenario, { recursive: true, force: true });
  }
}

async function verifyInstalledTextRead(consumer: string): Promise<void> {
  const directory = join(consumer, `text-read-consumer-${randomUUID()}`);
  const bin = dockBin(consumer);
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
    for (const name of [
      "text-read-positive.mts",
      "text-read-negative.mts",
      "text-read-tsconfig.json",
    ]) {
      await copyFile(join(fixtureDirectory, name), join(directory, name));
    }
    const typecheck = await run(
      compiler,
      ["-p", join(directory, "text-read-tsconfig.json"), "--pretty", "false"],
      directory,
    );
    assert.equal(
      typecheck.code,
      0,
      `Installed readReference type checks failed:\n${typecheck.stdout}\n${typecheck.stderr}`,
    );

    const initialSource =
      "😀说明\n<!-- 原文注释保留 -->\n#region runtime\nport=4173\n#endregion runtime\n";
    await writeFile(join(directory, "guide.md"), initialSource, "utf8");

    const initial = await run(
      bin,
      ["check", "--config", "dock.config.mjs", "--json"],
      directory,
    );
    assert.equal(initial.code, 1, initial.stderr);
    assert.equal(parseEnvelope(initial.stdout).variant, "changed");
    assertSelectedRangeValue(
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

    const update = await run(
      bin,
      ["baseline", "update", "--config", "dock.config.mjs", "--json"],
      directory,
    );
    assert.equal(update.code, 0, update.stderr);
    assert.equal(parseEnvelope(update.stdout).variant, "updated");

    const movedSource = `前置😀\n${initialSource}`;
    await writeFile(join(directory, "guide.md"), movedSource, "utf8");
    const moved = await run(
      bin,
      ["check", "--config", "dock.config.mjs", "--json"],
      directory,
    );
    assert.equal(moved.code, 0, moved.stderr);
    assertSelectedRangeValue(
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
    const movedText = await run(
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
    const changed = await run(
      bin,
      ["check", "--config", "dock.config.mjs", "--json"],
      directory,
    );
    assert.equal(changed.code, 1, changed.stderr);
    assert.equal(parseEnvelope(changed.stdout).variant, "changed");
    assertSelectedRangeValue(
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
        'import { binding, defineConfig, file } from "@ykdz/dock";',
        'const selected = file.from("guide.md").quote("missing current text").reference("runtime-port");',
        'export default defineConfig({ plugins: [file], bindings: [binding("runtime-policy", [selected])] });',
      ].join("\n"),
    );
    const invalidRead = await run(
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
    const invalidUpdate = await run(
      bin,
      ["baseline", "update", "--config", "dock.config.mjs", "--json"],
      directory,
    );
    assert.equal(invalidUpdate.code, 1, invalidUpdate.stderr);
    assert.equal(parseEnvelope(invalidUpdate.stdout).variant, "rejected");
    assert.deepEqual(await readFile(baselinePath), savedBaseline);

    await verifyInstalledExistence(bin, directory);
    await verifyInstalledAuthorSelection(bin, directory);
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
    process.execPath,
    [join(directory, "text-read-runtime.mjs"), value, String(start)],
    directory,
  );
  assert.equal(
    result.code,
    0,
    `Installed readReference scenario failed:\n${result.stdout}\n${result.stderr}`,
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
      'import { binding, defineConfig, file } from "@ykdz/dock";',
      'const reference = file.from("guide.md").exists().reference("guide-exists");',
      'export default defineConfig({ plugins: [file], bindings: [binding("existence-policy", [reference])], baseline: "exists.baseline.json" });',
    ].join("\n"),
  );
  const initial = await run(
    bin,
    ["check", "--config", "dock.config-exists.mjs", "--json"],
    directory,
  );
  assert.equal(initial.code, 1, initial.stderr);
  assertSelectedRangeValue(
    initial.stdout,
    true,
    "guide.md",
    undefined,
    "existence-policy",
    "guide-exists",
  );
  const update = await run(
    bin,
    ["baseline", "update", "--config", "dock.config-exists.mjs", "--json"],
    directory,
  );
  assert.equal(update.code, 0, update.stderr);
  const baselinePath = join(directory, "exists.baseline.json");
  const originalBaseline = await readFile(baselinePath);

  await rm(join(directory, "guide.md"));
  const missing = await run(
    bin,
    ["check", "--config", "dock.config-exists.mjs", "--json"],
    directory,
  );
  assert.equal(missing.code, 1, missing.stderr);
  assert.equal(parseEnvelope(missing.stdout).variant, "errors");
  assert.equal(findReferenceError(missing.stdout, "missing-file"), true);
  const rejected = await run(
    bin,
    ["baseline", "update", "--config", "dock.config-exists.mjs", "--json"],
    directory,
  );
  assert.equal(rejected.code, 1, rejected.stderr);
  assert.equal(parseEnvelope(rejected.stdout).variant, "rejected");
  assert.deepEqual(await readFile(baselinePath), originalBaseline);
}

async function verifyInstalledAuthorSelection(
  bin: string,
  directory: string,
): Promise<void> {
  const authorDirectory = join(directory, `author-options-${randomUUID()}`);
  await mkdir(authorDirectory);
  await writeFile(
    join(authorDirectory, "guide.md"),
    "previous content\n",
    "utf8",
  );
  await writeFile(
    join(authorDirectory, "baseline-config.mjs"),
    [
      'import { binding, defineConfig, file } from "@ykdz/dock";',
      'const reference = file.from("guide.md").reference("guide");',
      'export default defineConfig({ plugins: [file], bindings: [binding("author-policy", [reference])] });',
    ].join("\n"),
  );
  const initialUpdate = await run(
    bin,
    ["baseline", "update", "--config", "baseline-config.mjs", "--json"],
    authorDirectory,
  );
  assert.equal(initialUpdate.code, 0, initialUpdate.stderr);
  const baselinePath = join(authorDirectory, "dock.baseline.json");
  const savedBaseline = await readFile(baselinePath);

  await writeFile(join(authorDirectory, "guide.md"), "whole file\n", "utf8");
  await writeFile(
    join(authorDirectory, "invalid-selection.mjs"),
    [
      'import { binding, defineConfig, file } from "@ykdz/dock";',
      'const reference = file.from("guide.md").reference("guide", { selection: { kind: "unsupported" } });',
      'export default defineConfig({ plugins: [file], bindings: [binding("author-policy", [reference])] });',
    ].join("\n"),
  );
  const invalidCheck = await run(
    bin,
    ["check", "--config", "invalid-selection.mjs", "--json"],
    authorDirectory,
  );
  const invalidUpdate = await run(
    bin,
    ["baseline", "update", "--config", "invalid-selection.mjs", "--json"],
    authorDirectory,
  );
  const currentBaseline = await readFile(baselinePath);
  assert.match(
    invalidCheck.stderr,
    /selection/,
    `JS authoring API did not reject invalid selection: check stdout=${invalidCheck.stdout}; update exit=${invalidUpdate.code} stdout=${invalidUpdate.stdout} stderr=${invalidUpdate.stderr}`,
  );
  assert.equal(invalidUpdate.code, 1, invalidUpdate.stderr);
  assert.deepEqual(currentBaseline, savedBaseline);
}

async function verifyInstalledScope(consumer: string): Promise<void> {
  const isolatedConsumer = join(consumer, "scope-consumer");
  await mkdir(isolatedConsumer, { recursive: true });
  const runtime = join(isolatedConsumer, "scope-runtime.mjs");
  await copyFile(join(fixtureDirectory, "scope-runtime.mjs"), runtime);
  const result = await run(process.execPath, [runtime], isolatedConsumer);
  assert.equal(
    result.code,
    0,
    `Installed scope verification failed:\n${result.stdout}\n${result.stderr}`,
  );
}

async function verifyInstalledCurrentConfig(consumer: string): Promise<void> {
  const scenario = await mkdtemp(join(consumer, "current-config-consumer-"));
  const fixture = join(scenario, "fixture");
  try {
    await cp(join(fixtureDirectory, "current-config"), fixture, {
      recursive: true,
    });
    const dependencyDirectory = join(
      fixture,
      "node_modules",
      "current-config-declarations",
    );
    await mkdir(dirname(dependencyDirectory), { recursive: true });
    await cp(
      join(fixtureDirectory, "current-config-dependency"),
      dependencyDirectory,
      { recursive: true },
    );

    const result = await runWithTimeout(
      process.execPath,
      [join(fixture, "runner.mjs")],
      fixture,
      10_000,
    );
    assert.equal(
      result.timedOut,
      false,
      `Current-config consumer failed to exit cleanly:\n${result.stdout}\n${result.stderr}`,
    );
    assert.equal(
      result.code,
      0,
      `Installed current-config consumer failed:\n${result.stdout}\n${result.stderr}`,
    );
  } finally {
    await rm(scenario, { recursive: true, force: true });
  }
}

async function verifyInstalledPaths(consumer: string): Promise<void> {
  const scenario = await mkdtemp(join(consumer, "paths-consumer-"));
  const bin = dockBin(consumer);
  try {
    const original = join(scenario, "portable-original");
    const relocated = join(scenario, "nested", "portable-relocated");
    const external = join(scenario, "external.md");
    await mkdir(original);
    await writeFile(external, "Fixed file outside project");
    await writeFile(join(original, "guide.md"), "Portable project body");
    await writeFile(
      join(original, "dock.config.mjs"),
      configSource(
        "guide.md",
        "history/baseline.json",
        undefined,
        "guide-policy",
        "guide",
      ),
    );
    const initial = await run(
      bin,
      ["baseline", "update", "--config", "dock.config.mjs", "--json"],
      original,
    );
    assert.equal(initial.code, 0, initial.stdout + initial.stderr);
    const savedBaseline = await readFile(
      join(original, "history", "baseline.json"),
    );

    await writeFile(
      join(original, "external.config.mjs"),
      configSource(
        external,
        "history/external.baseline.json",
        undefined,
        "external-policy",
        "external",
      ),
    );
    const externalBaseline = await run(
      bin,
      ["baseline", "update", "--config", "external.config.mjs", "--json"],
      original,
    );
    assert.equal(
      externalBaseline.code,
      0,
      externalBaseline.stdout + externalBaseline.stderr,
    );

    await mkdir(join(original, "packages", "library"), { recursive: true });
    await mkdir(join(original, "docs"));
    await writeFile(join(original, "docs", "guide.md"), "Shared repo document");
    await writeFile(
      join(original, "shared.config.mjs"),
      configSource(
        "../../docs/guide.md",
        "../../shared.baseline.json",
        "packages/library",
        "shared-policy",
        "shared-guide",
      ),
    );
    const sharedBaseline = await run(
      bin,
      ["baseline", "update", "--config", "shared.config.mjs", "--json"],
      original,
    );
    assert.equal(
      sharedBaseline.code,
      0,
      sharedBaseline.stdout + sharedBaseline.stderr,
    );

    await cp(original, relocated, { recursive: true });
    await rm(original, { recursive: true });

    const externalUnchanged = await run(
      bin,
      [
        "check",
        "--config",
        "external.config.mjs",
        "--file",
        external,
        "--json",
      ],
      relocated,
    );
    assert.equal(
      externalUnchanged.code,
      0,
      externalUnchanged.stdout + externalUnchanged.stderr,
    );
    assert.equal(parseEnvelope(externalUnchanged.stdout).variant, "consistent");

    const sharedUnchanged = await run(
      bin,
      [
        "check",
        "--config",
        "shared.config.mjs",
        "--file",
        "../../docs/guide.md",
        "--json",
      ],
      relocated,
    );
    assert.equal(
      sharedUnchanged.code,
      0,
      sharedUnchanged.stdout + sharedUnchanged.stderr,
    );
    assert.equal(parseEnvelope(sharedUnchanged.stdout).variant, "consistent");

    await rename(
      join(relocated, "docs", "guide.md"),
      join(relocated, "docs", "renamed.md"),
    );
    await writeFile(
      join(relocated, "shared.config.mjs"),
      configSource(
        "../../docs/renamed.md",
        "../../shared.baseline.json",
        "packages/library",
        "shared-policy",
        "shared-guide",
      ),
    );
    const sharedHistorical = await run(
      bin,
      [
        "check",
        "--config",
        "shared.config.mjs",
        "--file",
        "../../docs/guide.md",
        "--json",
      ],
      relocated,
    );
    assert.equal(
      sharedHistorical.code,
      1,
      sharedHistorical.stdout + sharedHistorical.stderr,
    );
    assert.equal(parseEnvelope(sharedHistorical.stdout).variant, "changed");
    assert.deepEqual(readReport(parseEnvelope(sharedHistorical.stdout)).scope, [
      "shared-policy",
    ]);

    const unchanged = await run(
      bin,
      ["check", "--config", "dock.config.mjs", "--file", "guide.md", "--json"],
      relocated,
    );
    assert.equal(unchanged.code, 0, unchanged.stdout + unchanged.stderr);
    assert.equal(parseEnvelope(unchanged.stdout).variant, "consistent");
    assert.deepEqual(
      await readFile(join(relocated, "history", "baseline.json")),
      savedBaseline,
    );

    await rename(join(relocated, "guide.md"), join(relocated, "renamed.md"));
    await writeFile(
      join(relocated, "dock.config.mjs"),
      configSource(
        "renamed.md",
        "history/baseline.json",
        undefined,
        "guide-policy",
        "guide",
      ),
    );
    const historical = await run(
      bin,
      ["check", "--config", "dock.config.mjs", "--file", "guide.md", "--json"],
      relocated,
    );
    assert.equal(historical.code, 1, historical.stdout + historical.stderr);
    assert.equal(parseEnvelope(historical.stdout).variant, "changed");
    assert.equal(
      findChangeKind(historical.stdout, "reference-definition"),
      true,
    );
    assert.deepEqual(readReport(parseEnvelope(historical.stdout)).scope, [
      "guide-policy",
    ]);

    const updated = await run(
      bin,
      [
        "baseline",
        "update",
        "--config",
        "dock.config.mjs",
        "--file",
        "guide.md",
        "--json",
      ],
      relocated,
    );
    assert.equal(updated.code, 0, updated.stdout + updated.stderr);
    const accepted = await run(
      bin,
      [
        "check",
        "--config",
        "dock.config.mjs",
        "--file",
        "renamed.md",
        "--json",
      ],
      relocated,
    );
    assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
    assert.equal(parseEnvelope(accepted.stdout).variant, "consistent");

    for (const [name, alpha, beta] of [
      ["checkout-one", "First package body", "First tool body"],
      ["checkout-two", "Second package body", "Second tool body"],
    ] as const) {
      const checkout = join(scenario, name);
      await createCheckout(checkout, alpha, beta);
      await verifyCheckout(bin, checkout, alpha, beta);
    }
  } finally {
    await rm(scenario, { recursive: true, force: true });
  }
}

async function createCheckout(
  checkout: string,
  alphaContent: string,
  betaContent: string,
): Promise<void> {
  const workspace = join(checkout, "workspace");
  await Promise.all(
    [
      join(checkout, "config"),
      join(workspace, "config"),
      join(workspace, "history"),
      join(workspace, "packages", "alpha"),
      join(workspace, "packages", "beta"),
      join(workspace, "shared"),
      join(workspace, "other-root", "config"),
      join(workspace, "other-root", "packages", "alpha"),
    ].map((path) => mkdir(path, { recursive: true })),
  );
  await Promise.all([
    writeFile(join(workspace, "packages", "alpha", "guide.md"), alphaContent),
    writeFile(
      join(workspace, "packages", "alpha", "local.md"),
      "Module-adjacent body",
    ),
    writeFile(join(workspace, "packages", "alpha", "copy.md"), alphaContent),
    writeFile(join(workspace, "packages", "beta", "guide.md"), betaContent),
    writeFile(
      join(workspace, "packages", "beta", "local-copy.md"),
      "Module-adjacent body",
    ),
    writeFile(
      join(workspace, "packages", "alpha", "dock.config.mjs"),
      packageConfig(),
    ),
    writeFile(
      join(workspace, "packages", "beta", "dock.config.mjs"),
      packageConfig(),
    ),
    writeFile(
      join(workspace, "other-root", "packages", "alpha", "guide.md"),
      "Relative target overriding root",
    ),
    writeFile(
      join(workspace, "config", "default.md"),
      "Config directory default root body",
    ),
    writeFile(
      join(workspace, "other-root", "config", "default.md"),
      "Config directory default root body",
    ),
    writeFile(
      join(workspace, "config", "entry.mjs"),
      "throw new Error('root must not overwrite config entry');\n",
    ),
    writeFile(join(workspace, "default-config.mjs"), defaultRootConfig()),
    writeFile(join(checkout, "config", "entry.mjs"), mainConfig()),
    writeFile(
      join(checkout, "config", "independent-one.mjs"),
      configSource(
        "packages/alpha/guide.md",
        "history/one.json",
        "../workspace",
        "shared-policy",
        "shared-reference",
      ),
    ),
    writeFile(
      join(checkout, "config", "independent-two.mjs"),
      configSource(
        "packages/beta/guide.md",
        "history/two.json",
        "../workspace",
        "shared-policy",
        "shared-reference",
      ),
    ),
    writeFile(
      join(checkout, "config", "target-change.mjs"),
      configSource(
        "packages/alpha/guide.md",
        "history/target.json",
        "../workspace",
        "target-policy",
        "target-reference",
      ),
    ),
    writeFile(
      join(workspace, "shared", "declarations.mjs"),
      [
        'import { file } from "@ykdz/dock";',
        'export const guide = file.from("packages/alpha/guide.md").reference("guide", { declaredAt: "declared-before.mjs" });',
        'export const local = file.at(import.meta.url).from("../packages/alpha/local.md").reference("local");',
        'export const url = file.from(new URL("../packages/alpha/local.md", import.meta.url)).reference("url");',
      ].join("\n"),
    ),
  ]);
}

function defaultRootConfig(): string {
  return [
    'import { binding, defineConfig, file } from "@ykdz/dock";',
    'export default defineConfig({ plugins: [file], bindings: [binding("default-root-policy", [file.from("config/default.md").reference("default-root-reference")])] });',
  ].join("\n");
}

function packageConfig(): string {
  return configSource(
    "guide.md",
    undefined,
    undefined,
    "package-policy",
    "package-guide",
  );
}

function mainConfig(): string {
  return [
    'import { binding, defineConfig, file } from "@ykdz/dock";',
    'import { guide, local, url } from "../workspace/shared/declarations.mjs";',
    'export default defineConfig({ plugins: [file], root: "../workspace", baseline: "history/primary.json", bindings: [binding("documents", [guide, local, url])] });',
  ].join("\n");
}

function configSource(
  target: string,
  baseline: string | undefined,
  root: string | undefined,
  bindingId: string,
  referenceId: string,
  includeBinding = true,
): string {
  const bindingValue = includeBinding
    ? `[binding(${JSON.stringify(bindingId)}, [file.from(${JSON.stringify(target)}).reference(${JSON.stringify(referenceId)})])]`
    : "[]";
  return [
    'import { binding, defineConfig, file } from "@ykdz/dock";',
    `export default defineConfig({ plugins: [file],${root === undefined ? "" : ` root: ${JSON.stringify(root)},`}${baseline === undefined ? "" : ` baseline: ${JSON.stringify(baseline)},`} bindings: ${bindingValue} });`,
  ].join("\n");
}

async function verifyCheckout(
  bin: string,
  checkout: string,
  alphaContent: string,
  betaContent: string,
): Promise<void> {
  const workspace = join(checkout, "workspace");
  const firstCheck = await run(
    bin,
    ["check", "--config", "config/entry.mjs", "--json"],
    checkout,
  );
  assert.equal(firstCheck.code, 1, firstCheck.stderr);
  assert.equal(parseEnvelope(firstCheck.stdout).variant, "changed");
  assertSelectedRangeValue(
    firstCheck.stdout,
    alphaContent,
    "packages/alpha/guide.md",
    0,
    "documents",
    "guide",
  );
  assertSelectedRangeValue(
    firstCheck.stdout,
    "Module-adjacent body",
    "packages/alpha/local.md",
    0,
    "documents",
    "local",
  );
  assertSelectedRangeValue(
    firstCheck.stdout,
    "Module-adjacent body",
    "packages/alpha/local.md",
    0,
    "documents",
    "url",
  );

  const update = await run(
    bin,
    ["baseline", "update", "--config", "config/entry.mjs", "--json"],
    checkout,
  );
  assert.equal(update.code, 0, update.stderr);
  const primaryBaselinePath = join(workspace, "history", "primary.json");
  const primaryBaseline = await readFile(primaryBaselinePath);

  const nestedCwd = join(workspace, "packages", "beta");
  const unchanged = await run(
    bin,
    ["check", "--config", "../../../config/entry.mjs", "--json"],
    nestedCwd,
  );
  assert.equal(unchanged.code, 0, unchanged.stderr);
  assert.equal(parseEnvelope(unchanged.stdout).variant, "consistent");
  assert.deepEqual(await readFile(primaryBaselinePath), primaryBaseline);

  await verifyRootSwitchPathBases(bin, checkout);
  await verifyDefaultRoot(bin, checkout, workspace);
  await verifyPackageConfigs(
    bin,
    checkout,
    workspace,
    alphaContent,
    betaContent,
  );
  await verifyIndependentConfigs(bin, checkout, workspace, betaContent);
  await verifyChangedTarget(bin, checkout, workspace, alphaContent);
  await verifyMaintainedModuleMove(
    bin,
    checkout,
    workspace,
    primaryBaselinePath,
  );
  await verifyChangedBoundTarget(bin, checkout);
  await verifyFailedUpdateKeepsBaseline(
    bin,
    checkout,
    workspace,
    primaryBaselinePath,
  );
}

async function verifyRootSwitchPathBases(
  bin: string,
  checkout: string,
): Promise<void> {
  const configPath = join(checkout, "config", "entry.mjs");
  await writeFile(
    configPath,
    mainConfig()
      .replace('root: "../workspace"', 'root: "../workspace/other-root"')
      .replace(
        'baseline: "history/primary.json"',
        'baseline: "history/root-switch.json"',
      ),
  );
  const movedRoot = await run(
    bin,
    ["check", "--config", configPath, "--json"],
    checkout,
  );
  assert.equal(movedRoot.code, 1, movedRoot.stderr);
  assertSelectedRangeValue(
    movedRoot.stdout,
    "Relative target overriding root",
    "packages/alpha/guide.md",
    0,
    "documents",
    "guide",
  );
  assertSelectedRangeValue(
    movedRoot.stdout,
    "Module-adjacent body",
    "../packages/alpha/local.md",
    0,
    "documents",
    "local",
  );
  await writeFile(configPath, mainConfig());
}

async function verifyDefaultRoot(
  bin: string,
  checkout: string,
  workspace: string,
): Promise<void> {
  const configPath = "workspace/default-config.mjs";
  const initial = await run(
    bin,
    ["check", "--config", configPath, "--json"],
    checkout,
  );
  assert.equal(initial.code, 1, initial.stderr);
  assertSelectedRangeValue(
    initial.stdout,
    "Config directory default root body",
    "config/default.md",
    0,
    "default-root-policy",
    "default-root-reference",
  );
  const update = await run(
    bin,
    ["baseline", "update", "--config", configPath, "--json"],
    checkout,
  );
  assert.equal(update.code, 0, update.stderr);
  const oldBaselinePath = join(workspace, "dock.baseline.json");
  const oldBaseline = await readFile(oldBaselinePath);
  const movedRootConfig = join(workspace, "default-config.mjs");
  await writeFile(
    movedRootConfig,
    defaultRootConfig().replace(
      "plugins: [file], bindings:",
      'plugins: [file], root: "other-root", bindings:',
    ),
  );
  const movedRootCheck = await run(
    bin,
    ["check", "--config", movedRootConfig, "--json"],
    checkout,
  );
  assert.equal(movedRootCheck.code, 1, movedRootCheck.stderr);
  assert.equal(parseEnvelope(movedRootCheck.stdout).variant, "changed");
  assertSelectedRangeValue(
    movedRootCheck.stdout,
    "Config directory default root body",
    "config/default.md",
    0,
    "default-root-policy",
    "default-root-reference",
  );
  const movedRootUpdate = await run(
    bin,
    ["baseline", "update", "--config", movedRootConfig, "--json"],
    checkout,
  );
  assert.equal(movedRootUpdate.code, 0, movedRootUpdate.stderr);
  await readFile(join(workspace, "other-root", "dock.baseline.json"));
  assert.deepEqual(await readFile(oldBaselinePath), oldBaseline);
}

async function verifyPackageConfigs(
  bin: string,
  checkout: string,
  workspace: string,
  alphaContent: string,
  betaContent: string,
): Promise<void> {
  const alphaConfig = "workspace/packages/alpha/dock.config.mjs";
  const alphaCheck = await run(
    bin,
    ["check", "--config", alphaConfig, "--json"],
    checkout,
  );
  assert.equal(alphaCheck.code, 1, alphaCheck.stderr);
  assertSelectedRangeValue(
    alphaCheck.stdout,
    alphaContent,
    "guide.md",
    0,
    "package-policy",
    "package-guide",
  );
  const alphaUpdate = await run(
    bin,
    ["baseline", "update", "--config", alphaConfig, "--json"],
    checkout,
  );
  assert.equal(alphaUpdate.code, 0, alphaUpdate.stderr);
  await readFile(join(workspace, "packages", "alpha", "dock.baseline.json"));

  const fromBetaCwd = await run(
    bin,
    ["check", "--config", "../alpha/dock.config.mjs", "--json"],
    join(workspace, "packages", "beta"),
  );
  assert.equal(fromBetaCwd.code, 0, fromBetaCwd.stderr);
  assert.equal(parseEnvelope(fromBetaCwd.stdout).variant, "consistent");

  const betaConfig = "workspace/packages/beta/dock.config.mjs";
  const betaCheck = await run(
    bin,
    ["check", "--config", betaConfig, "--json"],
    checkout,
  );
  assert.equal(betaCheck.code, 1, betaCheck.stderr);
  assertSelectedRangeValue(
    betaCheck.stdout,
    betaContent,
    "guide.md",
    0,
    "package-policy",
    "package-guide",
  );
  const betaUpdate = await run(
    bin,
    ["baseline", "update", "--config", betaConfig, "--json"],
    checkout,
  );
  assert.equal(betaUpdate.code, 0, betaUpdate.stderr);
  await readFile(join(workspace, "packages", "beta", "dock.baseline.json"));
}

async function verifyIndependentConfigs(
  bin: string,
  checkout: string,
  workspace: string,
  betaContent: string,
): Promise<void> {
  for (const name of ["independent-one.mjs", "independent-two.mjs"]) {
    const update = await run(
      bin,
      ["baseline", "update", "--config", `config/${name}`, "--json"],
      checkout,
    );
    assert.equal(update.code, 0, update.stderr);
  }
  const secondBaseline = join(workspace, "history", "two.json");
  const secondBytes = await readFile(secondBaseline);
  const second = await run(
    bin,
    ["check", "--config", "config/independent-two.mjs", "--json"],
    checkout,
  );
  assert.equal(second.code, 0, second.stderr);
  assert.equal(parseEnvelope(second.stdout).variant, "consistent");
  assertSelectedRangeValue(
    second.stdout,
    betaContent,
    "packages/beta/guide.md",
    0,
    "shared-policy",
    "shared-reference",
  );

  await writeFile(
    join(checkout, "config", "independent-one.mjs"),
    configSource(
      "packages/alpha/guide.md",
      "history/one.json",
      "../workspace",
      "shared-policy",
      "shared-reference",
      false,
    ),
  );
  const removed = await run(
    bin,
    ["check", "--config", "config/independent-one.mjs", "--json"],
    checkout,
  );
  assert.equal(removed.code, 1, removed.stderr);
  assert.equal(parseEnvelope(removed.stdout).variant, "changed");
  const other = await run(
    bin,
    ["check", "--config", "config/independent-two.mjs", "--json"],
    checkout,
  );
  assert.equal(other.code, 0, other.stderr);
  assert.equal(parseEnvelope(other.stdout).variant, "consistent");
  assert.deepEqual(await readFile(secondBaseline), secondBytes);
}

async function verifyChangedTarget(
  bin: string,
  checkout: string,
  workspace: string,
  content: string,
): Promise<void> {
  await writeFile(
    join(workspace, "packages", "alpha", "same-content.md"),
    content,
  );
  const configPath = join(checkout, "config", "target-change.mjs");
  const update = await run(
    bin,
    ["baseline", "update", "--config", configPath, "--json"],
    checkout,
  );
  assert.equal(update.code, 0, update.stderr);
  await writeFile(
    configPath,
    configSource(
      "packages/alpha/same-content.md",
      "history/target.json",
      "../workspace",
      "target-policy",
      "target-reference",
    ),
  );
  const changed = await run(
    bin,
    ["check", "--config", configPath, "--json"],
    checkout,
  );
  assert.equal(changed.code, 1, changed.stderr);
  assert.equal(parseEnvelope(changed.stdout).variant, "changed");
  assert.equal(findChangeKind(changed.stdout, "reference-definition"), true);
}

async function verifyMaintainedModuleMove(
  bin: string,
  checkout: string,
  workspace: string,
  primaryBaselinePath: string,
): Promise<void> {
  const baselineBefore = await readFile(primaryBaselinePath);
  const movedDirectory = join(workspace, "new", "deep");
  await mkdir(movedDirectory, { recursive: true });
  await writeFile(
    join(movedDirectory, "declarations.mjs"),
    [
      'import { file } from "@ykdz/dock";',
      'export const guide = file.from("packages/alpha/guide.md").reference("guide", { declaredAt: "declared-after.mjs" });',
      'export const local = file.at(import.meta.url).from("../../packages/alpha/local.md").reference("local");',
      'export const url = file.from(new URL("../../packages/alpha/local.md", import.meta.url)).reference("url");',
    ].join("\n"),
  );
  await writeFile(
    join(checkout, "config", "entry.mjs"),
    mainConfig().replace(
      "../workspace/shared/declarations.mjs",
      "../workspace/new/deep/declarations.mjs",
    ),
  );
  const unchanged = await run(
    bin,
    ["check", "--config", "config/entry.mjs", "--json"],
    checkout,
  );
  assert.equal(unchanged.code, 0, unchanged.stderr);
  assert.equal(parseEnvelope(unchanged.stdout).variant, "consistent");
  assert.deepEqual(await readFile(primaryBaselinePath), baselineBefore);
}

async function verifyChangedBoundTarget(
  bin: string,
  checkout: string,
): Promise<void> {
  const declarations = join(
    checkout,
    "workspace",
    "new",
    "deep",
    "declarations.mjs",
  );
  const content = await readFile(declarations, "utf8");
  await writeFile(
    declarations,
    content.replace(
      "../../packages/alpha/local.md",
      "../../packages/beta/local-copy.md",
    ),
  );
  const changed = await run(
    bin,
    ["check", "--config", "config/entry.mjs", "--json"],
    checkout,
  );
  assert.equal(changed.code, 1, changed.stderr);
  assert.equal(parseEnvelope(changed.stdout).variant, "changed");
  assert.equal(findChangeKind(changed.stdout, "reference-definition"), true);
}

async function verifyFailedUpdateKeepsBaseline(
  bin: string,
  checkout: string,
  workspace: string,
  baselinePath: string,
): Promise<void> {
  const savedBaseline = await readFile(baselinePath);
  const target = join(workspace, "packages", "alpha", "guide.md");
  const savedTarget = await readFile(target);
  await rm(target);
  const failed = await run(
    bin,
    ["baseline", "update", "--config", "config/entry.mjs", "--json"],
    checkout,
  );
  assert.equal(failed.code, 1, failed.stderr);
  assert.equal(parseEnvelope(failed.stdout).variant, "rejected");
  assert.deepEqual(await readFile(baselinePath), savedBaseline);
  await writeFile(target, savedTarget);
}

function assertSelectedRangeValue(
  output: string,
  value: unknown,
  path: string,
  start: number | undefined,
  bindingId: string,
  referenceId: string,
): void {
  const report = readReportRecord(output);
  const bindings = report.bindings;
  assert.ok(Array.isArray(bindings));
  const bindingEntry = bindings.find(
    (candidate) => isRecord(candidate) && candidate.bindingId === bindingId,
  );
  assert.ok(isRecord(bindingEntry));
  assert.ok(isRecord(bindingEntry.current));
  assert.ok(isRecord(bindingEntry.current.references));
  const reference = bindingEntry.current.references[referenceId];
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
  const report = readReportRecord(output);
  assert.ok(Array.isArray(report.bindings));
  return report.bindings.some((candidate) => {
    if (!isRecord(candidate) || !Array.isArray(candidate.errors)) return false;
    return candidate.errors.some(
      (error) => isRecord(error) && error.code === code,
    );
  });
}

function findChangeKind(output: string, kind: string): boolean {
  const report = readReportRecord(output);
  return (
    Array.isArray(report.bindings) &&
    report.bindings.some(
      (bindingEntry) =>
        isRecord(bindingEntry) &&
        Array.isArray(bindingEntry.changes) &&
        bindingEntry.changes.some(
          (change) => isRecord(change) && change.kind === kind,
        ),
    )
  );
}

function readReportRecord(output: string): RecordValue {
  const envelope = JSON.parse(output) as unknown;
  assert.ok(isRecord(envelope));
  assert.ok(isRecord(envelope.data));
  assert.ok(isRecord(envelope.data.report));
  return envelope.data.report;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnvelope(output: string): CliEnvelope {
  return JSON.parse(output) as CliEnvelope;
}

function readReport(envelope: CliEnvelope): {
  readonly scope: string[];
  readonly bindings: readonly {
    readonly changes: readonly { readonly kind: string }[];
  }[];
} {
  assert.ok(envelope.data?.report !== undefined);
  return envelope.data.report as {
    readonly scope: string[];
    readonly bindings: readonly {
      readonly changes: readonly { readonly kind: string }[];
    }[];
  };
}

async function copyFixture(consumer: string, name: string): Promise<void> {
  await copyFile(join(fixtureDirectory, name), join(consumer, name));
}

function run(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  identity?: ProcessIdentity,
): Promise<ProcessResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(command, [...arguments_], {
      cwd,
      ...(identity === undefined ? {} : identity),
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

function runWithTimeout(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  timeoutMs: number,
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
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveResult({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}
