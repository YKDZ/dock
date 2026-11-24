import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ProcessResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

type StructuredEnvelope = {
  readonly schemaVersion: string;
  readonly command: string;
  readonly outputMode?: string;
  readonly kind: string;
  readonly variant?: string;
  readonly data?: Record<string, unknown>;
  readonly issues?: readonly {
    readonly code: string;
    readonly option?: string;
  }[];
};

async function main(): Promise<void> {
  const artifacts = process.argv.slice(2);
  assert.ok(
    artifacts.length >= 1,
    "Installed CLI verification requires at least the @ykdz/dock tarball path.",
  );
  const tarballs = artifacts.map((artifact) =>
    resolve(process.cwd(), artifact),
  );
  await Promise.all(tarballs.map((artifact) => access(artifact)));
  await verifyInstalledCliTarballs(tarballs);
}

export async function verifyInstalledCli(tarball: string): Promise<void> {
  await verifyInstalledCliTarballs([resolve(process.cwd(), tarball)]);
}

async function verifyInstalledCliTarballs(
  tarballs: readonly string[],
): Promise<void> {
  const consumer = await mkdtemp(join(tmpdir(), "dock-cli-installed-"));
  try {
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "dock-cli-installed-consumer",
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
    assert.equal(install.code, 0, install.stdout + install.stderr);

    const installedPackage = JSON.parse(
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

    const help = await run(dock, ["--help"], consumer);
    assert.equal(help.code, 0, help.stderr);
    assert.equal(help.stderr, "");
    assert.match(help.stdout, /\bUsage\b/);
    assert.match(help.stdout, /\bCommands\b/);
    assert.match(help.stdout, /\bOptions\b/);
    assert.doesNotMatch(help.stdout, /--json/);

    const version = await run(dock, ["--version"], consumer);
    assert.equal(version.code, 0, version.stderr);
    assert.equal(version.stderr, "");
    assert.equal(version.stdout.trim(), installedPackage.version);

    const configPath = join(consumer, "dock.config.mjs");
    const factPath = join(consumer, "fact.txt");
    await writeFile(factPath, "initial fact");
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
        "        results.push({ referenceId: reference.id, kind: 'value', value });",
        "      } catch {",
        "        results.push({",
        "          referenceId: reference.id,",
        '          kind: "error",',
        '          error: { code: "missing-fact", message: "Missing line 1\\r\\nMissing line 2\\0" },',
        "        });",
        "      }",
        "    }",
        "    return { results };",
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
    );

    const inspectText = await run(
      dock,
      ["inspect", "--config", "dock.config.mjs"],
      consumer,
    );
    assert.equal(inspectText.code, 0, inspectText.stderr);
    assert.equal(inspectText.stderr, "");
    assert.match(inspectText.stdout, /Scope: cli-policy/);

    const inspectStructured = await run(
      dock,
      ["inspect", "--config", "dock.config.mjs", "--output", "structured"],
      consumer,
    );
    assert.equal(inspectStructured.code, 0, inspectStructured.stderr);
    assert.equal(inspectStructured.stderr, "");
    const inspectEnvelope = parseEnvelope(inspectStructured.stdout);
    assert.equal(inspectEnvelope.schemaVersion, "3");
    assert.equal(inspectEnvelope.command, "inspect");
    assert.equal(inspectEnvelope.outputMode, "structured");
    assert.equal(inspectEnvelope.kind, "data");
    assert.equal(inspectEnvelope.variant, "inspected");
    assert.ok(inspectEnvelope.data?.resolution);

    const changedCheck = await run(
      dock,
      ["check", "--config", "dock.config.mjs", "--output", "structured"],
      consumer,
    );
    assert.equal(changedCheck.code, 1, changedCheck.stderr);
    assert.equal(changedCheck.stderr, "");
    const changedEnvelope = parseEnvelope(changedCheck.stdout);
    assert.equal(changedEnvelope.schemaVersion, "3");
    assert.equal(changedEnvelope.command, "check");
    assert.equal(changedEnvelope.outputMode, "structured");
    assert.equal(changedEnvelope.kind, "data");
    assert.equal(changedEnvelope.variant, "changed");

    const updated = await run(
      dock,
      [
        "baseline",
        "update",
        "--config",
        "dock.config.mjs",
        "--output",
        "structured",
      ],
      consumer,
    );
    assert.equal(updated.code, 0, updated.stderr);
    assert.equal(updated.stderr, "");
    const updatedEnvelope = parseEnvelope(updated.stdout);
    assert.equal(updatedEnvelope.schemaVersion, "3");
    assert.equal(updatedEnvelope.command, "update");
    assert.equal(updatedEnvelope.outputMode, "structured");
    assert.equal(updatedEnvelope.kind, "data");
    assert.equal(updatedEnvelope.variant, "updated");

    const consistentText = await run(
      dock,
      ["check", "--config", "dock.config.mjs"],
      consumer,
    );
    assert.equal(consistentText.code, 0, consistentText.stderr);
    assert.equal(consistentText.stderr, "");
    assert.match(consistentText.stdout, /Consistent with baseline\./);

    const consistentStructured = await run(
      dock,
      ["check", "--config", "dock.config.mjs", "--output", "structured"],
      consumer,
    );
    assert.equal(consistentStructured.code, 0, consistentStructured.stderr);
    assert.equal(consistentStructured.stderr, "");
    const consistentEnvelope = parseEnvelope(consistentStructured.stdout);
    assert.equal(consistentEnvelope.schemaVersion, "3");
    assert.equal(consistentEnvelope.command, "check");
    assert.equal(consistentEnvelope.outputMode, "structured");
    assert.equal(consistentEnvelope.kind, "data");
    assert.equal(consistentEnvelope.variant, "consistent");

    await rm(factPath);
    const errorCheck = await run(
      dock,
      ["check", "--config", "dock.config.mjs", "--output", "structured"],
      consumer,
    );
    assert.equal(errorCheck.code, 1, errorCheck.stderr);
    assert.equal(errorCheck.stderr, "");
    const errorEnvelope = parseEnvelope(errorCheck.stdout);
    assert.equal(errorEnvelope.schemaVersion, "3");
    assert.equal(errorEnvelope.command, "check");
    assert.equal(errorEnvelope.outputMode, "structured");
    assert.equal(errorEnvelope.kind, "data");
    assert.equal(errorEnvelope.variant, "errors");

    const rejectedUpdate = await run(
      dock,
      [
        "baseline",
        "update",
        "--config",
        "dock.config.mjs",
        "--output",
        "structured",
      ],
      consumer,
    );
    assert.equal(rejectedUpdate.code, 1, rejectedUpdate.stderr);
    assert.equal(rejectedUpdate.stderr, "");
    const rejectedEnvelope = parseEnvelope(rejectedUpdate.stdout);
    assert.equal(rejectedEnvelope.schemaVersion, "3");
    assert.equal(rejectedEnvelope.command, "update");
    assert.equal(rejectedEnvelope.outputMode, "structured");
    assert.equal(rejectedEnvelope.kind, "data");
    assert.equal(rejectedEnvelope.variant, "rejected");

    const maintenanceFailureText = await run(
      dock,
      ["check", "--config", "missing.config.mjs"],
      consumer,
    );
    assert.equal(maintenanceFailureText.code, 1);
    assert.equal(maintenanceFailureText.stdout, "");
    assert.match(
      maintenanceFailureText.stderr,
      /Maintenance failed \(config-load-failed\)/,
    );

    const maintenanceFailureStructured = await run(
      dock,
      ["check", "--config", "missing.config.mjs", "--output", "structured"],
      consumer,
    );
    assert.equal(maintenanceFailureStructured.code, 1);
    assert.equal(maintenanceFailureStructured.stdout, "");
    const failureEnvelope = parseEnvelope(maintenanceFailureStructured.stderr);
    assert.equal(failureEnvelope.schemaVersion, "3");
    assert.equal(failureEnvelope.command, "check");
    assert.equal(failureEnvelope.outputMode, "structured");
    assert.equal(failureEnvelope.kind, "failure");
    assert.equal(failureEnvelope.variant, "maintenanceFailed");

    for (const argv of [
      ["check"],
      ["check", "--config", "dock.config.mjs", "--json"],
      ["check", "--config", "dock.config.mjs", "--output", "invalid"],
    ]) {
      const usageFailure = await run(dock, argv, consumer);
      assert.equal(usageFailure.code, 64, usageFailure.stderr);
      assert.equal(usageFailure.stdout, "");
      const usageEnvelope = parseEnvelope(usageFailure.stderr);
      assert.equal(usageEnvelope.schemaVersion, "3");
      assert.equal(usageEnvelope.kind, "usageFailure");
    }

    process.stdout.write("Installed CLI contract verification passed.\n");
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}

function parseEnvelope(output: string): StructuredEnvelope {
  return JSON.parse(output) as StructuredEnvelope;
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

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `Installed CLI verification failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
