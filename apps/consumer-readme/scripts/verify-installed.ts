import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Report = {
  bindings: { bindingId: string; errors?: { code: string }[] }[];
  pluginDiagnostics: {
    pluginId: string;
    data: unknown;
    text: string[];
  }[];
  pluginErrors: { pluginId: string; code: string; message: string }[];
};

type NodeDiagnosticData = {
  runs: NodeRunDiagnostic[];
};

type NodeRunDiagnostic = {
  identity: string;
  commandAttempts: number;
  testExecutions: number;
  failedCommands: number;
  reads: { testId: string }[];
};

const artifacts = process.argv.slice(2);
assert.equal(
  artifacts.length,
  1,
  "README bootstrap verification requires the @ykdz/dock package tarball.",
);
const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const repository = await mkdtemp(join(tmpdir(), "dock-readme-installed-"));
const consumer = join(repository, "apps", "consumer-readme");

try {
  // Mirror the workspace consumer directory layout and copy config, test, and baseline verbatim.
  await mkdir(join(consumer, "scripts"), { recursive: true });
  await copyFile(
    fileURLToPath(import.meta.resolve("dock/README.md")),
    join(repository, "README.md"),
  );
  await copyFile(
    fileURLToPath(import.meta.resolve("dock/package.json")),
    join(repository, "package.json"),
  );
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "dock-readme-consumer",
      private: true,
      type: "module",
      dependencies: { dock: "file:../.." },
    }),
  );
  const compiler = require("typescript-7/package.json") as { version: string };
  const nodeTypes = require("@types/node/package.json") as { version: string };
  const installed = run("npm", [
    "install",
    "--no-save",
    "--no-package-lock",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefer-offline",
    ...artifacts.map((artifact) => resolve(artifact)),
    `typescript@${compiler.version}`,
    `@types/node@${nodeTypes.version}`,
  ]);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);

  for (const path of [
    "dock.config.ts",
    "dock.baseline.json",
    "scripts/readme.test.ts",
  ]) {
    await copyFile(join(packageDirectory, path), join(consumer, path));
  }
  await writeFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        allowImportingTsExtensions: true,
        erasableSyntaxOnly: true,
        exactOptionalPropertyTypes: true,
        isolatedModules: true,
        module: "nodenext",
        moduleResolution: "nodenext",
        noEmit: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: false,
        strict: true,
        target: "es2024",
        types: ["node"],
        verbatimModuleSyntax: true,
      },
      include: ["dock.config.ts", "scripts/**/*.ts"],
    }),
  );
  const typed = run(bin("tsc"), ["-p", "tsconfig.json", "--pretty", "false"]);
  assert.equal(typed.status, 0, typed.stdout + typed.stderr);

  const baselinePath = join(consumer, "dock.baseline.json");
  const baseline = await readFile(baselinePath);
  const checked = run(bin("dock"), [
    "check",
    "--config",
    "dock.config.ts",
    "--output",
    "structured",
  ]);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  const report = readReport(checked.stdout, "consistent");
  assert.deepEqual(report.bindings.map((binding) => binding.bindingId).sort(), [
    "readme-extension",
    "readme-workflow",
  ]);
  assert.deepEqual(report.pluginErrors, []);
  const nodePlugin = report.pluginDiagnostics.find(
    ({ pluginId }) => pluginId === "@ykdz/dock-reference-node-test",
  );
  assert.ok(
    nodePlugin,
    "README structured output must retain node-test plugin diagnostics.",
  );
  const diagnostic = nodePlugin.data as NodeDiagnosticData;
  const nodeRun = diagnostic.runs[0];
  assert.ok(nodeRun, "README structured output must include a Node run entry.");
  assert.equal(nodeRun.identity, "README example");
  assert.equal(nodeRun.commandAttempts, 1);
  assert.equal(nodeRun.testExecutions, 1);
  assert.equal(nodeRun.failedCommands, 0);
  assert.ok(nodePlugin.text.length > 0);
  const reads = nodeRun.reads;
  assert.ok(
    reads && reads.length > 0,
    "README verification must produce native test read evidence.",
  );
  for (const read of reads) {
    const identity = JSON.parse(read.testId) as { name?: unknown };
    assert.equal(
      identity.name,
      "README example completes check and baseline update",
    );
  }
  assert.deepEqual(await readFile(baselinePath), baseline);

  const readmePath = join(repository, "README.md");
  const original = await readFile(readmePath, "utf8");
  const selectedField = "data.engines?.node";
  assert.equal(original.split(selectedField).length, 2);
  await writeFile(
    readmePath,
    original.replace(selectedField, "data.engines?.npm"),
  );

  for (const [command, variant] of [
    [["check"], "errors"],
    [["baseline", "update"], "rejected"],
  ] as const) {
    const failed = run(bin("dock"), [
      ...command,
      "--config",
      "dock.config.ts",
      "--output",
      "structured",
    ]);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    const failure = readReport(failed.stdout, variant);
    assert.deepEqual(failure.pluginErrors, []);
    assert.ok(
      failure.bindings.some((binding) =>
        binding.errors?.some((error) => error.code === "test-failed"),
      ),
      "Broken README example plugin must report a native test failure.",
    );
    assert.deepEqual(await readFile(baselinePath), baseline);
  }

  process.stdout.write(
    "README installed package, bootstrap baseline, and broken-example rejection verification passed.\n",
  );
} finally {
  await rm(repository, { recursive: true, force: true });
}

function readReport(output: string, variant: string): Report {
  const envelope = JSON.parse(output) as {
    schemaVersion?: unknown;
    outputMode?: unknown;
    kind?: unknown;
    variant?: unknown;
    data?: { report?: Report };
  };
  assert.equal(envelope.schemaVersion, "3", output);
  assert.equal(envelope.outputMode, "structured", output);
  assert.equal(envelope.kind, "data", output);
  assert.equal(envelope.variant, variant, output);
  assert.ok(envelope.data?.report, output);
  return envelope.data.report;
}

function bin(name: string): string {
  return join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  );
}

function run(command: string, args: readonly string[]) {
  const result = spawnSync(command, args, {
    cwd: consumer,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, `Failed to execute ${command}.`);
  return result;
}
