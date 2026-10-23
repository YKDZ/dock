import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
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
    2,
    "根正式验收必须传入同批 core 与 host 包制品路径。",
  );
  const tarballs = artifacts.map((artifact) =>
    resolve(process.cwd(), artifact),
  );
  await Promise.all(tarballs.map((artifact) => access(artifact)));

  const consumer = await mkdtemp(join(tmpdir(), "dock-host-installed-"));
  try {
    await installConsumer(consumer, tarballs, "dock-host-consumer");
    const secondary = join(consumer, "secondary");
    await mkdir(secondary);
    await installConsumer(secondary, tarballs, "dock-host-secondary-consumer");

    const primaryHost = await realpath(
      join(consumer, "node_modules", "@ykdz", "dock"),
    );
    const secondaryHost = await realpath(
      join(secondary, "node_modules", "@ykdz", "dock"),
    );
    assert.notEqual(
      primaryHost,
      secondaryHost,
      "多实例验收必须来自两份物理宿主安装。",
    );
    const primaryPackage = JSON.parse(
      await readFile(join(primaryHost, "package.json"), "utf8"),
    ) as { readonly version: string };
    const secondaryPackage = JSON.parse(
      await readFile(join(secondaryHost, "package.json"), "utf8"),
    ) as { readonly version: string };
    assert.equal(primaryPackage.version, secondaryPackage.version);

    await runConsumerTypechecks(consumer);
    for (const fixture of [
      "execution-runtime.mjs",
      "external-plugin-consumer.mts",
      "physical-multiversion.mts",
    ]) {
      await copyFixture(consumer, fixture);
      const runtime = await run(
        process.execPath,
        [join(consumer, fixture)],
        consumer,
      );
      assert.equal(
        runtime.code,
        0,
        `安装制品 ${fixture} 运行验收失败：\n${runtime.stdout}\n${runtime.stderr}`,
      );
    }

    const installedHost = JSON.parse(
      await readFile(
        join(consumer, "node_modules", "@ykdz", "dock", "package.json"),
        "utf8",
      ),
    ) as { readonly version: string };
    const dock = join(
      consumer,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "dock.cmd" : "dock",
    );
    const version = await run(dock, ["--version"], consumer);
    assert.equal(version.code, 0, version.stderr);
    assert.equal(version.stdout.trim(), installedHost.version);

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
      "@ykdz/dock-reference-file",
      "@ykdz/dock-reference-markdown",
      "@ykdz/dock-reference-typescript",
      "@ykdz/dock-reference-node-test",
      "@ykdz/dock-reference-vitest",
      "remark",
      "markdown-it",
    ]) {
      assert.equal(
        dependencyNames.has(forbidden),
        false,
        `纯宿主安装不应依赖 ${forbidden}`,
      );
    }

    process.stdout.write("宿主公开类型、两份物理安装与命令验收通过。\n");
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
    `正式 tarball 干净安装失败：\n${install.stdout}\n${install.stderr}`,
  );
}

async function runConsumerTypechecks(consumer: string): Promise<void> {
  for (const fixture of [
    "tsconfig.json",
    "external-plugin.mts",
    "external-plugin-consumer.mts",
    "physical-multiversion.mts",
    "scope-positive.mts",
    "scope-negative.mts",
    "inspect-positive.mts",
    "inspect-negative.mts",
  ]) {
    await copyFixture(consumer, fixture);
  }
  await mkdir(join(consumer, "secondary"), { recursive: true });
  await copyFile(
    join(fixtureDirectory, "secondary", "physical-author.mts"),
    join(consumer, "secondary", "physical-author.mts"),
  );

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

async function copyFixture(consumer: string, name: string): Promise<void> {
  await copyFile(join(fixtureDirectory, name), join(consumer, name));
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

function collectPackageNames(value: unknown, names: Set<string>): void {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return;
  const packageValue = value as { name?: unknown; dependencies?: unknown };
  if (typeof packageValue.name === "string") names.add(packageValue.name);
  const dependencies = packageValue.dependencies;
  if (
    typeof dependencies !== "object" ||
    dependencies === null ||
    Array.isArray(dependencies)
  )
    return;
  for (const [name, dependency] of Object.entries(dependencies)) {
    names.add(name);
    collectPackageNames(dependency, names);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `宿主安装验收失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
