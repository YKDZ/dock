import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ProcessResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

type CliEnvelope = {
  readonly schemaVersion: string;
  readonly command: string;
  readonly outputMode?: string;
  readonly kind: string;
  readonly variant?: string;
  readonly data?: {
    readonly report?: {
      readonly scope?: readonly string[];
      readonly bindings?: readonly {
        readonly bindingId: string;
        readonly consistency?: string;
        readonly changes?: readonly { readonly kind: string }[];
      }[];
    };
  };
};

/**
 * Verifies that a clean consumer upgrading from 0.2.x can keep its version-2
 * `dock.baseline.json` intact after updating config imports to `@ykdz/dock`.
 */
export async function verifyInstalledMigration(
  dockTarball: string,
): Promise<void> {
  const tarball = resolve(process.cwd(), dockTarball);
  await access(tarball);

  const consumer = await mkdtemp(join(tmpdir(), "dock-migration-consumer-"));
  try {
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "dock-migration-installed-consumer",
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
        tarball,
      ],
      consumer,
    );
    assert.equal(
      install.code,
      0,
      `Clean tarball installation failed:\n${install.stdout}\n${install.stderr}`,
    );

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

    // Genuine 0.2.x baseline format (version 2) using the preserved built-in plugin IDs.
    const legacyBaseline = {
      version: 2,
      bindings: {
        "migration-policy": {
          definition: {
            id: "migration-policy",
            references: [
              "notes-port",
              "guide-section",
              "ts-greet",
              "node-pass",
            ],
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
                    {
                      kind: "symbol",
                      name: ["greet"],
                      declaration: "function",
                    },
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
    const initialBaselineText = `${JSON.stringify(legacyBaseline, null, 2)}\n`;
    await writeFile(baselinePath, initialBaselineText, "utf8");

    // Config updated solely in its import paths to @ykdz/dock and its subpaths.
    await writeFile(
      join(consumer, "dock.config.mjs"),
      [
        'import { binding, defineConfig, file } from "@ykdz/dock";',
        'import { markdown } from "@ykdz/dock/markdown";',
        'import { typescript } from "@ykdz/dock/typescript";',
        'import { defineNodeTestRun, nodeTest, nodeTestStatus } from "@ykdz/dock/node-test";',
        "",
        'const run = defineNodeTestRun("migration-run", { files: ["test/app.test.mts"] });',
        "",
        "export default defineConfig({",
        "  plugins: [file, markdown, typescript, nodeTest],",
        "  bindings: [",
        '    binding("migration-policy", [',
        '      file.from("notes.txt").quote("port=4173").reference("notes-port"),',
        '      markdown.from("guide.md").section("Guide").reference("guide-section"),',
        '      typescript.from("api.ts").symbol("greet", "function").reference("ts-greet"),',
        '      nodeTestStatus("node-pass", run, { file: "test/app.test.mts", name: "migration sample passes" }),',
        "    ]),",
        "  ],",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    const dock = join(
      consumer,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "dock.cmd" : "dock",
    );

    const initialCheck = await run(
      dock,
      ["check", "--config", "dock.config.mjs", "--output", "structured"],
      consumer,
    );
    assert.equal(
      initialCheck.code,
      0,
      `0.2.x baseline check failed:\n${initialCheck.stdout}\n${initialCheck.stderr}`,
    );
    assert.equal(initialCheck.stderr, "");
    const initialEnvelope = parseEnvelope(initialCheck.stdout);
    assert.equal(initialEnvelope.schemaVersion, "3");
    assert.equal(initialEnvelope.command, "check");
    assert.equal(initialEnvelope.outputMode, "structured");
    assert.equal(initialEnvelope.kind, "data");
    assert.equal(initialEnvelope.variant, "consistent");
    assert.equal(
      await readFile(baselinePath, "utf8"),
      initialBaselineText,
      "Consistent check must leave the 0.2.x baseline untouched.",
    );

    await writeFile(
      join(consumer, "guide.md"),
      "# Guide\n\nDefault port 8080.\n",
      "utf8",
    );
    const changedCheck = await run(
      dock,
      ["check", "--config", "dock.config.mjs", "--output", "structured"],
      consumer,
    );
    assert.equal(changedCheck.code, 1, changedCheck.stderr);
    assert.equal(changedCheck.stderr, "");
    const changedEnvelope = parseEnvelope(changedCheck.stdout);
    assert.equal(changedEnvelope.schemaVersion, "3");
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

    const recheck = await run(
      dock,
      ["check", "--config", "dock.config.mjs", "--output", "structured"],
      consumer,
    );
    assert.equal(recheck.code, 0, recheck.stderr);
    assert.equal(recheck.stderr, "");
    const recheckEnvelope = parseEnvelope(recheck.stdout);
    assert.equal(recheckEnvelope.schemaVersion, "3");
    assert.equal(recheckEnvelope.outputMode, "structured");
    assert.equal(recheckEnvelope.kind, "data");
    assert.equal(recheckEnvelope.variant, "consistent");

    process.stdout.write(
      "Clean consumer 0.2.x baseline compatibility and migration verification passed.\n",
    );
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}

function parseEnvelope(output: string): CliEnvelope {
  return JSON.parse(output) as CliEnvelope;
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

async function main(): Promise<void> {
  const artifacts = process.argv.slice(2);
  assert.equal(
    artifacts.length,
    1,
    "Installed migration verification expects the @ykdz/dock tarball path.",
  );
  await verifyInstalledMigration(artifacts[0]!);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `Installed migration verification failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
