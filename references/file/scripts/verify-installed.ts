import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
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

type ProcessIdentity = {
  readonly uid: number;
  readonly gid: number;
};

type CliEnvelope = {
  readonly schemaVersion: string;
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
);

async function main(): Promise<void> {
  const artifacts = process.argv.slice(2);
  assert.equal(
    artifacts.length,
    3,
    "根 Turbo 验收必须传入同批 core、SDK 与 file 包制品路径。",
  );
  const tarballs = artifacts.map((artifact) =>
    resolve(process.cwd(), artifact),
  );
  await Promise.all(tarballs.map((artifact) => access(artifact)));

  const consumer = await mkdtemp(join(tmpdir(), "dock-installed-consumer-"));
  try {
    await runInstalledCli(consumer, tarballs);
    process.stdout.write("干净消费者安装、公开声明与 dock CLI 验收通过。\n");
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}

async function runConsumerTypechecks(consumer: string): Promise<void> {
  await copyFixture(consumer, "positive.mts");
  await copyFixture(consumer, "negative.mts");
  await copyFixture(consumer, "tsconfig.json");
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
    `安装制品公开类型正负例未通过：\n${result.stdout}\n${result.stderr}`,
  );
}

async function runInstalledCli(
  consumer: string,
  tarballs: readonly string[],
): Promise<void> {
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "dock-installed-consumer",
      private: true,
      type: "module",
    }),
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
    `正式 tarball 干净安装失败：\n${install.stdout}\n${install.stderr}`,
  );
  await runConsumerTypechecks(consumer);

  await copyFixture(consumer, "sdk-consumer.mjs");
  const sdkConsumer = await run(
    "node",
    [join(consumer, "sdk-consumer.mjs")],
    consumer,
  );
  assert.equal(
    sdkConsumer.code,
    0,
    `安装制品 SDK 业务结果往返失败：\n${sdkConsumer.stdout}\n${sdkConsumer.stderr}`,
  );

  const installedPackages = await run(
    "npm",
    ["ls", "--all", "--json", "--prefix", consumer],
    consumer,
  );
  assert.equal(installedPackages.code, 0, installedPackages.stderr);
  const dependencyNames = new Set<string>();
  collectPackageNames(
    JSON.parse(installedPackages.stdout) as unknown,
    dependencyNames,
  );
  for (const forbidden of [
    "typescript",
    "typescript-7",
    "vitest",
    "@vitest/runner",
    "@dock/reference-markdown",
    "@dock/reference-typescript",
    "@dock/reference-node-test",
    "@dock/reference-vitest",
    "remark",
    "markdown-it",
  ]) {
    assert.equal(
      dependencyNames.has(forbidden),
      false,
      `运行制品不应依赖 ${forbidden}`,
    );
  }

  await copyFixture(consumer, "dock.config.mjs");
  await copyFixture(consumer, "dock.config.ts");
  await copyFixture(consumer, "declarations.mjs");
  await writeFile(join(consumer, "guide.md"), "第一版正文\n", "utf8");
  await writeFile(join(consumer, "copy.md"), "第一版正文\n", "utf8");

  const bin = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "dock.cmd" : "dock",
  );
  const missingConfigOption = await runDock(bin, ["check"], consumer);
  assert.equal(missingConfigOption.code, 64, missingConfigOption.stderr);
  const missingConfigFile = await runDock(
    bin,
    ["check", "--config", "missing.mjs", "--json"],
    consumer,
  );
  assert.equal(missingConfigFile.code, 1, missingConfigFile.stderr);
  const loadFailure = parseEnvelope(missingConfigFile.stderr);
  assert.equal(loadFailure.kind, "failure");
  assert.match(loadFailure.data?.code ?? "", /config-load-failed/);

  const typescriptConfig = await runDock(
    bin,
    ["check", "--config", "dock.config.ts", "--json"],
    consumer,
  );
  assert.equal(typescriptConfig.code, 1, typescriptConfig.stderr);
  assert.equal(parseEnvelope(typescriptConfig.stdout).variant, "changed");

  const firstCheck = await runDock(
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

  const update = await runDock(
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
    'import { defineConfig } from "@dock/sdk";\nexport default defineConfig({ plugins: [], bindings: [] });\n',
  );
  const emptyUpdate = await runDock(
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
  const emptyUpdateText = await runDock(
    bin,
    ["baseline", "update", "--config", "empty-config/dock.config.mjs"],
    consumer,
  );
  assert.equal(emptyUpdateText.code, 1, emptyUpdateText.stderr);
  assert.match(emptyUpdateText.stdout, /更新错误（empty-selection）/);

  const textCheck = await runDock(
    bin,
    ["check", "--config", "dock.config.mjs"],
    consumer,
  );
  assert.equal(textCheck.code, 0, textCheck.stderr);
  assert.match(textCheck.stdout, /范围：guide-policy/);
  assert.match(textCheck.stdout, /当前事实："第一版正文\\n"/);
  assert.match(textCheck.stdout, /位置 guide\.md（文本偏移 0–6）/);

  const childDirectory = join(consumer, "scripts");
  await mkdir(childDirectory, { recursive: true });
  const childCheck = await runDock(
    bin,
    ["check", "--config", "../dock.config.mjs", "--json"],
    childDirectory,
  );
  assert.equal(childCheck.code, 0, childCheck.stderr);

  await writeFile(
    join(consumer, "declarations.mjs"),
    'export const target = "copy.md";\n',
  );
  const targetChange = await runDock(
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

  const acceptTarget = await runDock(
    bin,
    ["baseline", "update", "--config", "dock.config.mjs", "--json"],
    consumer,
  );
  assert.equal(acceptTarget.code, 0, acceptTarget.stderr);
  await writeFile(join(consumer, "copy.md"), "第二版正文\n", "utf8");
  const bodyChange = await runDock(
    bin,
    ["check", "--config", "dock.config.mjs", "--json"],
    consumer,
  );
  assert.equal(bodyChange.code, 1, bodyChange.stderr);
  assert.equal(
    readReport(parseEnvelope(bodyChange.stdout)).bindings[0]?.changes[0]?.kind,
    "fact",
  );
  const bodyChangeText = await runDock(
    bin,
    ["check", "--config", "dock.config.mjs"],
    consumer,
  );
  assert.equal(bodyChangeText.code, 1, bodyChangeText.stderr);
  assert.match(bodyChangeText.stdout, /旧值 "第一版正文\\n"/);
  assert.match(bodyChangeText.stdout, /新值 "第二版正文\\n"/);

  await writeFile(join(consumer, "copy.md"), "第三版正文\n", "utf8");
  const acceptBody = await runDock(
    bin,
    ["baseline", "update", "--config", "dock.config.mjs", "--json"],
    consumer,
  );
  assert.equal(acceptBody.code, 0, acceptBody.stderr);
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
    "第三版正文\n",
    "update 必须重新采集 check 之后出现的新事实。",
  );
  await rm(join(consumer, "copy.md"));
  const missingTarget = await runDock(
    bin,
    ["check", "--config", "dock.config.mjs", "--json"],
    consumer,
  );
  assert.equal(missingTarget.code, 1, missingTarget.stderr);
  assert.equal(parseEnvelope(missingTarget.stdout).variant, "errors");
  const rejectedUpdate = await runDock(
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

  await writeFile(
    join(consumer, "invalid.mjs"),
    'export default { plugins: [{ id: "unused", collect() { throw new Error("不得采集"); } }] };\n',
  );
  const invalidConfig = await runDock(
    bin,
    ["baseline", "update", "--config", "invalid.mjs", "--json"],
    consumer,
  );
  assert.equal(invalidConfig.code, 1, invalidConfig.stderr);
  const invalidEnvelope = parseEnvelope(invalidConfig.stderr);
  assert.equal(invalidEnvelope.kind, "failure");
  assert.match(invalidEnvelope.data?.code ?? "", /maintenance-failed/);
  assert.match(invalidConfig.stderr, /bindings 关联列表/);
  assert.doesNotMatch(invalidConfig.stderr, /不得采集/);
  assert.deepEqual(
    await readFile(join(consumer, "dock.baseline.json")),
    currentBaseline,
  );

  await writeFile(
    join(consumer, "unsupported-selection.mjs"),
    [
      'import { file } from "@dock/reference-file";',
      'import { binding, defineConfig } from "@dock/sdk";',
      'const selected = file.from("guide.md").reference("selected", { selection: { start: 0 } });',
      'export default defineConfig({ plugins: [file], bindings: [binding("selected-policy", [selected])] });',
    ].join("\n"),
  );
  const unsupportedSelection = await runDock(
    bin,
    ["check", "--config", "unsupported-selection.mjs", "--json"],
    consumer,
  );
  assert.equal(unsupportedSelection.code, 1, unsupportedSelection.stderr);
  assert.match(unsupportedSelection.stderr, /全文，不能传入 selection/);

  await writeFile(
    join(consumer, "invalid-builder-target.mjs"),
    [
      'import { file } from "@dock/reference-file";',
      'import { binding, defineConfig } from "@dock/sdk";',
      'const unused = { id: "unused", collect() { throw new Error("不得采集"); } };',
      'const invalid = file.from(42).reference("invalid-target");',
      'export default defineConfig({ plugins: [file, unused], bindings: [binding("invalid-target-policy", [invalid])] });',
    ].join("\n"),
  );
  const invalidBuilderTarget = await runDock(
    bin,
    ["check", "--config", "invalid-builder-target.mjs", "--json"],
    consumer,
  );
  assert.equal(invalidBuilderTarget.code, 1, invalidBuilderTarget.stderr);
  assert.match(invalidBuilderTarget.stderr, /config-load-failed/);
  assert.match(invalidBuilderTarget.stderr, /普通文件引用目标必须/);
  assert.doesNotMatch(invalidBuilderTarget.stderr, /不得采集/);

  await writeFile(
    join(consumer, "invalid-raw-target.mjs"),
    [
      'import { file } from "@dock/reference-file";',
      'const unused = { id: "unused", collect() { throw new Error("不得采集"); } };',
      'export default { plugins: [file, unused], bindings: [{ id: "invalid-target-policy", references: [{ id: "invalid-target", pluginId: "@dock/reference-file", target: 42 }, { id: "unused-reference", pluginId: "unused", target: "guide.md" }] }] };',
    ].join("\n"),
  );
  const invalidRawTarget = await runDock(
    bin,
    ["check", "--config", "invalid-raw-target.mjs", "--json"],
    consumer,
  );
  assert.equal(invalidRawTarget.code, 1, invalidRawTarget.stderr);
  assert.match(invalidRawTarget.stderr, /文件引用 invalid-target 的目标无效/);
  assert.match(invalidRawTarget.stderr, /普通文件引用目标必须/);
  assert.doesNotMatch(invalidRawTarget.stderr, /不得采集/);

  await writeFile(
    join(consumer, "unregistered.mjs"),
    [
      'const unused = { id: "unused", collect() { throw new Error("不得采集"); } };',
      'export default { plugins: [unused], bindings: [{ id: "unregistered-policy", references: [{ id: "unregistered-reference", pluginId: "missing-plugin", target: "guide.md", declaredAt: "declarations.mjs" }] }] };',
    ].join("\n"),
  );
  const unregisteredPlugin = await runDock(
    bin,
    ["check", "--config", "unregistered.mjs", "--json"],
    consumer,
  );
  assert.equal(unregisteredPlugin.code, 1, unregisteredPlugin.stderr);
  assert.match(unregisteredPlugin.stderr, /未登记插件：missing-plugin/);
  assert.match(unregisteredPlugin.stderr, /声明来源：declarations\.mjs/);
  assert.match(unregisteredPlugin.stderr, /配置入口 .*unregistered\.mjs/);
  assert.doesNotMatch(unregisteredPlugin.stderr, /不得采集/);

  await writeFile(
    join(consumer, "duplicate.mjs"),
    [
      'const unused = { id: "unused", collect() { throw new Error("不得采集"); } };',
      'const reference = { id: "guide", pluginId: "unused", target: "guide.md" };',
      'export default { plugins: [unused], bindings: [{ id: "duplicate-policy", references: [reference] }, { id: "duplicate-policy", references: [reference] }] };',
    ].join("\n"),
  );
  const duplicateBinding = await runDock(
    bin,
    ["check", "--config", "duplicate.mjs", "--json"],
    consumer,
  );
  assert.equal(duplicateBinding.code, 1, duplicateBinding.stderr);
  assert.match(duplicateBinding.stderr, /关联身份重复：duplicate-policy/);
  assert.doesNotMatch(duplicateBinding.stderr, /不得采集/);

  await writeFile(
    join(consumer, "conflicting-reference.mjs"),
    [
      'const unused = { id: "unused", collect() { throw new Error("不得采集"); } };',
      'export default { plugins: [unused], bindings: [{ id: "first-policy", references: [{ id: "shared-guide", pluginId: "unused", target: "guide.md" }] }, { id: "second-policy", references: [{ id: "shared-guide", pluginId: "unused", target: "copy.md" }] }] };',
    ].join("\n"),
  );
  const conflictingReference = await runDock(
    bin,
    ["check", "--config", "conflicting-reference.mjs", "--json"],
    consumer,
  );
  assert.equal(conflictingReference.code, 1, conflictingReference.stderr);
  assert.match(
    conflictingReference.stderr,
    /引用身份 shared-guide 对应多个不同定义/,
  );
  assert.doesNotMatch(conflictingReference.stderr, /不得采集/);

  await writeFile(join(consumer, "dock.baseline.json"), "{not json", "utf8");
  const corruptBaseline = await runDock(
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

async function copyFixture(consumer: string, name: string): Promise<void> {
  await copyFile(join(fixtureDirectory, name), join(consumer, name));
}

async function verifyBaselineFilesystemFailures(
  bin: string,
  consumer: string,
): Promise<void> {
  const currentUid = process.getuid?.();
  assert.notEqual(
    currentUid,
    undefined,
    "基线权限验收需要支持 POSIX uid/gid 的运行环境。",
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
      'import { file } from "@dock/reference-file";',
      'import { binding, defineConfig } from "@dock/sdk";',
      'export default defineConfig({ plugins: [file], bindings: [binding("restricted-policy", [file.from("guide.txt").reference("restricted-guide")])] });',
    ].join("\n"),
  );
  await writeFile(target, "原始事实\n", "utf8");
  const initial = await runDock(
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

  await writeFile(target, "更新事实\n", "utf8");
  await chmod(consumer, 0o755);
  await chmod(config, 0o444);
  await chmod(target, 0o444);
  await chmod(baseline, 0o444);
  await chmod(directory, currentUid === 0 ? 0o1777 : 0o555);

  try {
    const failedUpdate = await runDock(
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
    const unreadableBaseline = await runDock(
      bin,
      ["check", "--config", "restricted-baseline/dock.config.mjs", "--json"],
      consumer,
      identity,
    );
    assert.equal(unreadableBaseline.code, 1, unreadableBaseline.stderr);
    const unreadableEnvelope = parseEnvelope(unreadableBaseline.stderr);
    assert.equal(unreadableEnvelope.kind, "failure");
    assert.match(unreadableEnvelope.data?.code ?? "", /baseline-read-failed/);
    assert.deepEqual(await readFile(baseline), originalBytes);
  } finally {
    await chmod(directory, 0o755).catch(() => undefined);
    await chmod(config, 0o644).catch(() => undefined);
    await chmod(target, 0o644).catch(() => undefined);
    await chmod(baseline, 0o644).catch(() => undefined);
  }
}

async function runDock(
  bin: string,
  arguments_: readonly string[],
  cwd: string,
  identity?: ProcessIdentity,
): Promise<ProcessResult> {
  return await run(bin, arguments_, cwd, identity);
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

function collectPackageNames(value: unknown, names: Set<string>): void {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return;
  const packageValue = value as { name?: unknown; dependencies?: unknown };
  if (typeof packageValue.name === "string") names.add(packageValue.name);
  collectDependencies(packageValue.dependencies, names);
}

function collectDependencies(value: unknown, names: Set<string>): void {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return;
  for (const [name, dependency] of Object.entries(value)) {
    names.add(name);
    collectPackageNames(dependency, names);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `安装验收失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
