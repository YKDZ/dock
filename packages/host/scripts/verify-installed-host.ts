import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { collectInstalledPackageNames } from "./npm-ls.ts";

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
  "host",
);

export async function verifyInstalledHost(tarball: string): Promise<void> {
  const consumer = await mkdtemp(join(tmpdir(), "dock-host-installed-"));
  try {
    await installConsumer(consumer, [tarball], "dock-host-consumer");
    const secondary = join(consumer, "secondary");
    await mkdir(secondary);
    await installConsumer(secondary, [tarball], "dock-host-secondary-consumer");

    const primaryHost = await realpath(
      join(consumer, "node_modules", "@ykdz", "dock"),
    );
    const secondaryHost = await realpath(
      join(secondary, "node_modules", "@ykdz", "dock"),
    );
    assert.notEqual(
      primaryHost,
      secondaryHost,
      "Multi-instance verification must use two physical host installations.",
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
      "batch-runtime.mjs",
      "core-independence.mjs",
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
        `Installed runtime verification failed for ${fixture}:\n${runtime.stdout}\n${runtime.stderr}`,
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
    const dependencyNames = collectInstalledPackageNames(
      JSON.parse(installedPackages.stdout) as unknown,
    );
    for (const forbidden of [
      "typescript-7",
      "vitest",
      "@vitest/runner",
      "@ykdz/dock-core",
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
        `Installed @ykdz/dock should not depend on ${forbidden}`,
      );
    }

    process.stdout.write(
      "Host public types, dual physical installations, core export, and CLI check passed.\n",
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
    `Installed public type positive/negative checks failed:\n${result.stdout}\n${result.stderr}`,
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
