import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  executeCli,
  parseCliInvocation,
  type CliOutput,
} from "@ykdz/cli-contract";

import { cli } from "../src/cli-contract.ts";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const packageVersion = (
  JSON.parse(
    await readFile(join(packageDirectory, "package.json"), "utf8"),
  ) as { readonly version: string }
).version;

async function runCli(argv: readonly string[]) {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const invocation = parseCliInvocation(cli, argv);
  const result = await executeCli(cli, {
    invocation,
    dependencies: undefined,
    write(output: CliOutput) {
      if (output.destination === "stdout") {
        stdoutChunks.push(output.chunk);
      } else {
        stderrChunks.push(output.chunk);
      }
    },
  });
  return {
    result,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

async function createConfigWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "dock-cli-contract-test-"));
  const nodeModulesDock = join(root, "node_modules", "@ykdz", "dock");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "cli-contract-fixture",
      private: true,
      type: "module",
    }),
  );
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(nodeModulesDock), { recursive: true });
  await symlink(
    packageDirectory,
    nodeModulesDock,
    process.platform === "win32" ? "junction" : "dir",
  );
  return root;
}

void test("renders English help and installed version", async () => {
  const rootHelp = await runCli(["--help"]);
  assert.equal(rootHelp.result.exitCode, 0);
  assert.equal(rootHelp.stderr, "");
  assert.match(rootHelp.stdout, /\bUsage\b/);
  assert.match(rootHelp.stdout, /\bCommands\b/);
  assert.match(rootHelp.stdout, /\bOptions\b/);
  assert.match(rootHelp.stdout, /\binspect\b/);
  assert.match(rootHelp.stdout, /\bcheck\b/);
  assert.match(rootHelp.stdout, /\bbaseline\b/);
  assert.doesNotMatch(rootHelp.stdout, /--json/);

  const checkHelp = await runCli(["check", "-h"]);
  assert.equal(checkHelp.result.exitCode, 0);
  assert.equal(checkHelp.stderr, "");
  assert.match(checkHelp.stdout, /--output/);
  assert.match(checkHelp.stdout, /\(choices: "text", "structured"\)/);
  assert.match(checkHelp.stdout, /\(default: "text"\)/);
  assert.doesNotMatch(checkHelp.stdout, /--json/);

  const version = await runCli(["--version"]);
  assert.equal(version.result.exitCode, 0);
  assert.equal(version.stderr, "");
  assert.equal(version.stdout.trim(), packageVersion);
});

void test("rejects missing required options, unknown --json, and invalid --output with exit code 64", async () => {
  for (const argv of [
    ["check"],
    ["inspect", "--config", "dock.config.mjs", "--json"],
    ["check", "--config", "dock.config.mjs", "--output", "yaml"],
  ]) {
    const outcome = await runCli(argv);
    assert.equal(outcome.result.kind, "usageFailure");
    assert.equal(outcome.result.exitCode, 64);
    assert.equal(outcome.stdout, "");
    const envelope = JSON.parse(outcome.stderr) as {
      schemaVersion: string;
      kind: string;
      issues: { code: string; option?: string }[];
    };
    assert.equal(envelope.schemaVersion, "3");
    assert.equal(envelope.kind, "usageFailure");
    if (argv.includes("--json")) {
      assert.ok(
        envelope.issues.some(
          (issue) =>
            issue.code === "unknownOption" && issue.option === "--json",
        ),
        outcome.stderr,
      );
    }
  }
});

void test("inspect, check, and baseline update share handlers across English text and structured modes", async () => {
  const root = await createConfigWorkspace();
  const configPath = join(root, "dock.config.mjs");
  const factPath = join(root, "fact.txt");

  try {
    await writeFile(factPath, "initial fact");
    await writeFile(
      configPath,
      [
        'import { readFile } from "node:fs/promises";',
        'import { join } from "node:path";',
        'import { binding, createReference, defineConfig, definePlugin } from "@ykdz/dock";',
        "const plugin = definePlugin({",
        '  id: "fixture:text-fact",',
        "  validate() {},",
        "  describe(request) {",
        "    return {",
        "      data: { count: request.selectedReferences.length },",
        '      text: ["Plugin ready"],',
        "    };",
        "  },",
        "  async collect(request, context) {",
        "    const results = [];",
        "    for (const reference of request.selectedReferences) {",
        "      try {",
        '        const value = await readFile(join(context.root, reference.target), "utf8");',
        "        results.push({",
        "          referenceId: reference.id,",
        '          kind: "value",',
        "          value,",
        "          range: { path: reference.target, start: 0, end: value.length },",
        "        });",
        "      } catch {",
        "        results.push({",
        "          referenceId: reference.id,",
        '          kind: "error",',
        '          error: { code: "missing-fact", message: "Line 1\\r\\nLine 2\\0" },',
        "        });",
        "      }",
        "    }",
        '    return { results, diagnostics: { data: { ok: true }, text: ["Collected\\nSafely"] } };',
        "  },",
        "});",
        "export default defineConfig({",
        '  declarationSources: ["dock.config.mjs"],',
        "  plugins: [plugin],",
        "  bindings: [",
        '    binding("doc-policy", [',
        '      createReference("fixture:text-fact", "fact-ref", "fact.txt", { declaredAt: "dock.config.mjs" }),',
        '    ], { declaredAt: "dock.config.mjs" }),',
        "  ],",
        "});",
      ].join("\n"),
    );

    const inspectText = await runCli(["inspect", "--config", configPath]);
    assert.equal(inspectText.result.exitCode, 0);
    assert.equal(inspectText.stderr, "");
    assert.match(inspectText.stdout, /Config entry:/);
    assert.match(inspectText.stdout, /Baseline status: not created/);
    assert.match(inspectText.stdout, /Scope: doc-policy/);
    assert.match(inspectText.stdout, /Plugins: fixture:text-fact/);
    assert.match(inspectText.stdout, /Plugin ready/);

    const inspectStructured = await runCli([
      "inspect",
      "--config",
      configPath,
      "--output",
      "structured",
    ]);
    assert.equal(inspectStructured.result.exitCode, 0);
    assert.equal(inspectStructured.stderr, "");
    const inspectEnvelope = JSON.parse(inspectStructured.stdout) as {
      schemaVersion: string;
      command: string;
      outputMode: string;
      kind: string;
      variant: string;
      data: { resolution: { root: string } };
    };
    assert.equal(inspectEnvelope.schemaVersion, "3");
    assert.equal(inspectEnvelope.command, "inspect");
    assert.equal(inspectEnvelope.outputMode, "structured");
    assert.equal(inspectEnvelope.kind, "data");
    assert.equal(inspectEnvelope.variant, "inspected");
    assert.equal(inspectEnvelope.data.resolution.root, root);

    const changedCheckText = await runCli(["check", "--config", configPath]);
    assert.equal(changedCheckText.result.exitCode, 1);
    assert.equal(changedCheckText.stderr, "");
    assert.match(changedCheckText.stdout, /Scope: doc-policy/);
    assert.doesNotMatch(
      changedCheckText.stdout,
      /Plugin fixture:text-fact: Collected/,
    );
    assert.doesNotMatch(changedCheckText.stdout, /Current fact:/);
    assert.doesNotMatch(changedCheckText.stdout, /text offset/);
    assert.match(changedCheckText.stdout, /Binding doc-policy/);
    assert.match(changedCheckText.stdout, /fact-ref \(fact\.txt:1\)/);
    assert.match(changedCheckText.stdout, /Change: binding added/);

    const changedCheckStructured = await runCli([
      "check",
      "--config",
      configPath,
      "--output",
      "structured",
    ]);
    assert.equal(changedCheckStructured.result.exitCode, 1);
    assert.equal(changedCheckStructured.stderr, "");
    const changedEnvelope = JSON.parse(changedCheckStructured.stdout) as {
      schemaVersion: string;
      command: string;
      outputMode: string;
      kind: string;
      variant: string;
      data: {
        report: {
          pluginDiagnostics: Array<{
            pluginId: string;
            text: string[];
          }>;
        };
      };
    };
    assert.equal(changedEnvelope.schemaVersion, "3");
    assert.equal(changedEnvelope.command, "check");
    assert.equal(changedEnvelope.outputMode, "structured");
    assert.equal(changedEnvelope.kind, "data");
    assert.equal(changedEnvelope.variant, "changed");
    assert.equal(
      changedEnvelope.data.report.pluginDiagnostics[0]?.pluginId,
      "fixture:text-fact",
    );
    assert.deepEqual(changedEnvelope.data.report.pluginDiagnostics[0]?.text, [
      "Collected\nSafely",
    ]);

    const updateText = await runCli([
      "baseline",
      "update",
      "--config",
      configPath,
    ]);
    assert.equal(updateText.result.exitCode, 0);
    assert.equal(updateText.stderr, "");
    assert.match(updateText.stdout, /Binding doc-policy/);
    assert.doesNotMatch(updateText.stdout, /Current fact:/);
    assert.match(updateText.stdout, /fact-ref \(fact\.txt:1\)/);
    assert.match(updateText.stdout, /Baseline updated\./);
    const savedBaseline = await readFile(
      join(root, "dock.baseline.json"),
      "utf8",
    );

    const updateStructured = await runCli([
      "baseline",
      "update",
      "--config",
      configPath,
      "--output",
      "structured",
    ]);
    assert.equal(updateStructured.result.exitCode, 0);
    assert.equal(updateStructured.stderr, "");
    const updatedEnvelope = JSON.parse(updateStructured.stdout) as {
      schemaVersion: string;
      command: string;
      outputMode: string;
      kind: string;
      variant: string;
    };
    assert.equal(updatedEnvelope.schemaVersion, "3");
    assert.equal(updatedEnvelope.command, "update");
    assert.equal(updatedEnvelope.outputMode, "structured");
    assert.equal(updatedEnvelope.kind, "data");
    assert.equal(updatedEnvelope.variant, "updated");

    const consistentText = await runCli(["check", "--config", configPath]);
    assert.equal(consistentText.result.exitCode, 0);
    assert.equal(consistentText.stderr, "");
    assert.equal(
      consistentText.stdout,
      "Scope: doc-policy\nAll checked bindings are consistent with baseline.\n",
    );

    const consistentStructured = await runCli([
      "check",
      "--config",
      configPath,
      "--output",
      "structured",
    ]);
    assert.equal(consistentStructured.result.exitCode, 0);
    assert.equal(consistentStructured.stderr, "");
    const consistentEnvelope = JSON.parse(consistentStructured.stdout) as {
      variant: string;
      data: {
        report: {
          pluginDiagnostics: Array<{ pluginId: string; text: string[] }>;
          bindings: Array<{
            current: {
              references: Record<
                string,
                {
                  value: unknown;
                  range?: Record<string, unknown>;
                }
              >;
            };
          }>;
        };
      };
    };
    assert.equal(consistentEnvelope.variant, "consistent");
    assert.equal(
      consistentEnvelope.data.report.pluginDiagnostics[0]?.pluginId,
      "fixture:text-fact",
    );
    const structuredRef =
      consistentEnvelope.data.report.bindings[0]?.current.references[
        "fact-ref"
      ];
    assert.equal(structuredRef?.value, "initial fact");
    assert.deepEqual(structuredRef?.range, {
      path: "fact.txt",
      start: 0,
      end: 12,
    });
    assert.deepEqual(Object.keys(structuredRef?.range ?? {}).toSorted(), [
      "end",
      "path",
      "start",
    ]);

    await writeFile(factPath, "updated fact");
    const factChangedText = await runCli(["check", "--config", configPath]);
    assert.equal(factChangedText.result.exitCode, 1);
    assert.equal(factChangedText.stderr, "");
    assert.match(
      factChangedText.stdout,
      /Change: fact-ref fact: before "initial fact"; after "updated fact"/,
    );

    await rm(factPath);
    const errorsText = await runCli(["check", "--config", configPath]);
    assert.equal(errorsText.result.exitCode, 1);
    assert.equal(errorsText.stderr, "");
    assert.match(errorsText.stdout, /Error fact-ref \(missing-fact\): Line 1/);
    assert.match(errorsText.stdout, /Line 2/);

    const errorsStructured = await runCli([
      "check",
      "--config",
      configPath,
      "--output",
      "structured",
    ]);
    assert.equal(errorsStructured.result.exitCode, 1);
    assert.equal(errorsStructured.stderr, "");
    const errorsEnvelope = JSON.parse(errorsStructured.stdout) as {
      kind: string;
      variant: string;
    };
    assert.equal(errorsEnvelope.kind, "data");
    assert.equal(errorsEnvelope.variant, "errors");

    const rejectedText = await runCli([
      "baseline",
      "update",
      "--config",
      configPath,
    ]);
    assert.equal(rejectedText.result.exitCode, 1);
    assert.equal(rejectedText.stderr, "");
    assert.match(
      rejectedText.stdout,
      /Error fact-ref \(missing-fact\): Line 1/,
    );
    assert.match(rejectedText.stdout, /Line 2/);
    assert.equal(
      rejectedText.stdout.match(/Error fact-ref \(missing-fact\):/g)?.length,
      1,
    );
    assert.doesNotMatch(rejectedText.stdout, /Update error/);
    assert.match(rejectedText.stdout, /Baseline was not updated\./);
    assert.equal(
      await readFile(join(root, "dock.baseline.json"), "utf8"),
      savedBaseline,
    );

    const rejectedStructured = await runCli([
      "baseline",
      "update",
      "--config",
      configPath,
      "--output",
      "structured",
    ]);
    assert.equal(rejectedStructured.result.exitCode, 1);
    assert.equal(rejectedStructured.stderr, "");
    const rejectedEnvelope = JSON.parse(rejectedStructured.stdout) as {
      kind: string;
      variant: string;
      data: {
        errors: unknown[];
        report: {
          bindings: Array<{
            consistency?: string;
            errors?: Array<{ referenceId?: string; code: string }>;
          }>;
        };
      };
    };
    assert.equal(rejectedEnvelope.kind, "data");
    assert.equal(rejectedEnvelope.variant, "rejected");
    assert.deepEqual(rejectedEnvelope.data.errors, []);
    assert.equal(
      rejectedEnvelope.data.report.bindings[0]?.consistency,
      undefined,
    );
    assert.equal(
      rejectedEnvelope.data.report.bindings[0]?.errors?.[0]?.referenceId,
      "fact-ref",
    );
    assert.equal(
      rejectedEnvelope.data.report.bindings[0]?.errors?.[0]?.code,
      "missing-fact",
    );
    assert.equal(
      await readFile(join(root, "dock.baseline.json"), "utf8"),
      savedBaseline,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("reports maintenanceFailed on stderr in text and structured modes including multiline errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-cli-failure-test-"));
  const brokenConfigPath = join(root, "broken.config.mjs");

  try {
    await writeFile(
      brokenConfigPath,
      'throw new Error("First failure line\\r\\nSecond failure line\\0");\n',
    );

    const failureText = await runCli(["check", "--config", brokenConfigPath]);
    assert.equal(failureText.result.exitCode, 1);
    assert.equal(failureText.stdout, "");
    assert.match(
      failureText.stderr,
      /Maintenance failed \(config-load-failed\)/,
    );
    assert.match(failureText.stderr, /First failure line/);
    assert.match(failureText.stderr, /Second failure line/);

    const failureStructured = await runCli([
      "check",
      "--config",
      brokenConfigPath,
      "--output",
      "structured",
    ]);
    assert.equal(failureStructured.result.exitCode, 1);
    assert.equal(failureStructured.stdout, "");
    const envelope = JSON.parse(failureStructured.stderr) as {
      schemaVersion: string;
      command: string;
      outputMode: string;
      kind: string;
      variant: string;
      data: { code: string; message: string };
    };
    assert.equal(envelope.schemaVersion, "3");
    assert.equal(envelope.command, "check");
    assert.equal(envelope.outputMode, "structured");
    assert.equal(envelope.kind, "failure");
    assert.equal(envelope.variant, "maintenanceFailed");
    assert.equal(envelope.data.code, "config-load-failed");
    assert.match(envelope.data.message, /First failure line/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("CLI check and baseline update reject legacy version 2 baseline without altering bytes and pass after rebuild", async () => {
  const root = await createConfigWorkspace();
  const configPath = join(root, "dock.config.mjs");
  const baselinePath = join(root, "dock.baseline.json");
  const factPath = join(root, "fact.txt");

  try {
    await writeFile(factPath, "current fact\n", "utf8");
    const legacyBaseline = `${JSON.stringify(
      {
        version: 2,
        bindings: {
          "doc-policy": {
            definition: { id: "doc-policy", references: ["fact-ref"] },
            references: {
              "fact-ref": {
                definition: {
                  id: "fact-ref",
                  target: {
                    pluginId: "@ykdz/dock-reference-file",
                    target: "fact.txt",
                    fileInfo: "fact.txt",
                  },
                },
                value: "current fact\n",
              },
            },
          },
        },
      },
      null,
      2,
    )}\n`;
    await writeFile(baselinePath, legacyBaseline, "utf8");
    await writeFile(
      configPath,
      [
        'import { binding, defineConfig, file } from "@ykdz/dock";',
        "export default defineConfig({",
        "  plugins: [file],",
        '  bindings: [binding("doc-policy", [file.from("fact.txt").reference("fact-ref")])],',
        "});",
      ].join("\n"),
      "utf8",
    );

    for (const argv of [
      ["check", "--config", configPath],
      ["baseline", "update", "--config", configPath],
    ]) {
      const outcome = await runCli(argv);
      assert.equal(outcome.result.exitCode, 1);
      assert.equal(outcome.stdout, "");
      assert.match(outcome.stderr, /Maintenance failed \(baseline-invalid\)/);
      assert.match(
        outcome.stderr,
        /Unsupported baseline version 2; expected version 3\./,
      );
      assert.match(outcome.stderr, /dock baseline update --config/);
      assert.equal(await readFile(baselinePath, "utf8"), legacyBaseline);
    }

    await rm(baselinePath);
    const rebuilt = await runCli([
      "baseline",
      "update",
      "--config",
      configPath,
    ]);
    assert.equal(rebuilt.result.exitCode, 0);
    const verified = await runCli(["check", "--config", configPath]);
    assert.equal(verified.result.exitCode, 0);
    const saved = JSON.parse(await readFile(baselinePath, "utf8")) as {
      version: number;
    };
    assert.equal(saved.version, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("lists related references with line-based locations, fallbacks, pluginErrors, and combined errors with changes", async () => {
  const root = await createConfigWorkspace();
  const configPath = join(root, "dock.config.mjs");
  const versionPath = join(root, "version.txt");
  const guidePath = join(root, "guide.txt");
  const crlfPath = join(root, "crlf.txt");
  const statePath = join(root, "collection-state.json");

  try {
    await writeFile(versionPath, "1.0.0");
    await writeFile(guidePath, "hello\n");
    await writeFile(crlfPath, "first\r\nsecond\r\nthird\r\n");
    await writeFile(
      statePath,
      JSON.stringify({
        members: [{ id: "a", value: "ok" }],
      }),
    );
    await writeFile(
      configPath,
      [
        'import { readFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'import { binding, createReference, defineConfig, definePlugin, file } from "@ykdz/dock";',
        "const customPlugin = definePlugin({",
        '  id: "fixture:custom",',
        "  validate() {},",
        "  fileInfo(reference) {",
        '    if (reference.target === "with-file-info") return "script.ts";',
        '    throw new Error("no file");',
        "  },",
        "  async collect(request, context) {",
        "    const results = [];",
        "    for (const reference of request.selectedReferences) {",
        '      if (reference.target === "collection") {',
        '        const state = JSON.parse(readFileSync(join(context.root, "collection-state.json"), "utf8"));',
        "        results.push({",
        "          referenceId: reference.id,",
        '          kind: "collection",',
        '          collection: { completeness: "complete", members: state.members },',
        "        });",
        "      } else {",
        "        results.push({",
        "          referenceId: reference.id,",
        '          kind: "value",',
        "          value: reference.target,",
        "        });",
        "      }",
        "    }",
        '    if (readFileSync(join(context.root, "version.txt"), "utf8") === "1.0.0-plugin-err") {',
        "      return {",
        '        results: [...results, { referenceId: "unselected", kind: "value", value: 1 }],',
        "      };",
        "    }",
        "    return { results };",
        "  },",
        "});",
        "const noFileInfoPlugin = definePlugin({",
        '  id: "fixture:no-file-info",',
        "  validate() {},",
        "  async collect(request, context) {",
        "    return {",
        "      results: request.selectedReferences.map((reference) => {",
        '        if (reference.target === "collection") {',
        '          const state = JSON.parse(readFileSync(join(context.root, "collection-state.json"), "utf8"));',
        "          return {",
        "            referenceId: reference.id,",
        '            kind: "collection",',
        '            collection: { completeness: "complete", members: state.members },',
        "          };",
        "        }",
        "        return {",
        "          referenceId: reference.id,",
        '          kind: "value",',
        "          value: reference.target,",
        "        };",
        "      }),",
        "    };",
        "  },",
        "});",
        "export default defineConfig({",
        "  plugins: [file, customPlugin, noFileInfoPlugin],",
        "  bindings: [",
        '    binding("release-docs", [',
        '      file.from("version.txt").reference("version-ref"),',
        '      file.from("guide.txt").reference("single-line-ref"),',
        '      file.from("crlf.txt").quote("second\\r\\nthird\\r\\n").reference("crlf-ref"),',
        '      createReference("fixture:custom", "fileinfo-only-ref", "with-file-info"),',
        '      createReference("fixture:no-file-info", "nameless-loc-ref", "opaque-target"),',
        "    ]),",
        '    binding("suite-binding", [',
        '      createReference("fixture:no-file-info", "suite-ref", "collection"),',
        "    ]),",
        "  ],",
        "});",
      ].join("\n"),
    );

    const baselineResult = await runCli([
      "baseline",
      "update",
      "--config",
      configPath,
    ]);
    assert.equal(baselineResult.result.exitCode, 0, baselineResult.stdout);

    // 1) Scalar change: shows change and lists related references with 1-based lines and fallbacks.
    await writeFile(versionPath, "2.0.0");
    const changedText = await runCli([
      "check",
      "--config",
      configPath,
      "--binding",
      "release-docs",
    ]);
    assert.equal(changedText.result.exitCode, 1);
    assert.equal(changedText.stderr, "");
    assert.match(changedText.stdout, /Scope: release-docs/);
    assert.match(changedText.stdout, /Binding release-docs/);
    assert.match(
      changedText.stdout,
      /Change: version-ref fact: before "1\.0\.0"; after "2\.0\.0"/,
    );
    assert.match(changedText.stdout, /single-line-ref \(guide\.txt:1\)/);
    assert.match(changedText.stdout, /crlf-ref \(crlf\.txt:2-3\)/);
    assert.match(changedText.stdout, /fileinfo-only-ref \(script\.ts\)/);
    assert.match(changedText.stdout, /nameless-loc-ref(?:\n|$)/);
    assert.doesNotMatch(changedText.stdout, /Binding suite-binding/);
    assert.doesNotMatch(changedText.stdout, /Current fact:/);

    const changedStructured = await runCli([
      "check",
      "--config",
      configPath,
      "--binding",
      "release-docs",
      "--output",
      "structured",
    ]);
    assert.equal(changedStructured.result.exitCode, 1);
    const structuredReport = JSON.parse(changedStructured.stdout) as {
      data: {
        report: {
          bindings: Array<{
            current: {
              references: Record<string, { range?: Record<string, unknown> }>;
            };
          }>;
        };
      };
    };
    const crlfRange =
      structuredReport.data.report.bindings[0]?.current.references["crlf-ref"]
        ?.range;
    assert.deepEqual(crlfRange, { path: "crlf.txt", start: 7, end: 22 });
    assert.deepEqual(Object.keys(crlfRange ?? {}).toSorted(), [
      "end",
      "path",
      "start",
    ]);

    // 2) Plugin error while all bindings are consistent: pluginError still shown in default text.
    await writeFile(versionPath, "1.0.0-plugin-err");
    await runCli(["baseline", "update", "--config", configPath]);
    const pluginErrorText = await runCli([
      "check",
      "--config",
      configPath,
      "--binding",
      "release-docs",
    ]);
    assert.equal(pluginErrorText.result.exitCode, 0);
    assert.match(
      pluginErrorText.stdout,
      /Plugin fixture:custom error \(unexpected-plugin-result\):/,
    );
    assert.match(
      pluginErrorText.stdout,
      /All checked bindings are consistent with baseline\./,
    );

    // 3) Binding with both errors and confirmed changes: displays errors first, then confirmed changes, and rejects updates without writing baseline.
    await writeFile(versionPath, "1.0.0");
    await runCli(["baseline", "update", "--config", configPath]);
    const baselineBeforeSuiteError = await readFile(
      join(root, "dock.baseline.json"),
      "utf8",
    );
    await writeFile(
      statePath,
      JSON.stringify({
        members: [
          {
            id: "a",
            error: { code: "missing-observation", message: "Missing obs" },
          },
          { id: "b", value: "new-member" },
        ],
      }),
    );
    const errorAndChangeText = await runCli([
      "check",
      "--config",
      configPath,
      "--binding",
      "suite-binding",
    ]);
    assert.equal(errorAndChangeText.result.exitCode, 1);
    const errorIndex = errorAndChangeText.stdout.indexOf(
      "Error suite-ref / a (missing-observation): Missing obs",
    );
    const changeIndex = errorAndChangeText.stdout.indexOf(
      "Change: suite-ref member b added",
    );
    assert.ok(errorIndex !== -1, errorAndChangeText.stdout);
    assert.ok(changeIndex !== -1, errorAndChangeText.stdout);
    assert.ok(errorIndex < changeIndex, errorAndChangeText.stdout);

    const errorAndChangeUpdateText = await runCli([
      "baseline",
      "update",
      "--config",
      configPath,
    ]);
    assert.equal(errorAndChangeUpdateText.result.exitCode, 1);
    assert.equal(errorAndChangeUpdateText.stderr, "");
    const updateErrorIndex = errorAndChangeUpdateText.stdout.indexOf(
      "Error suite-ref / a (missing-observation): Missing obs",
    );
    const updateChangeIndex = errorAndChangeUpdateText.stdout.indexOf(
      "Change: suite-ref member b added",
    );
    assert.ok(updateErrorIndex !== -1, errorAndChangeUpdateText.stdout);
    assert.ok(updateChangeIndex !== -1, errorAndChangeUpdateText.stdout);
    assert.ok(
      updateErrorIndex < updateChangeIndex,
      errorAndChangeUpdateText.stdout,
    );
    assert.equal(
      errorAndChangeUpdateText.stdout.match(
        /Error suite-ref \/ a \(missing-observation\):/g,
      )?.length,
      1,
    );
    assert.doesNotMatch(errorAndChangeUpdateText.stdout, /Update error/);
    assert.match(errorAndChangeUpdateText.stdout, /Baseline was not updated\./);
    assert.equal(
      await readFile(join(root, "dock.baseline.json"), "utf8"),
      baselineBeforeSuiteError,
    );

    const errorAndChangeUpdateStructured = await runCli([
      "baseline",
      "update",
      "--config",
      configPath,
      "--output",
      "structured",
    ]);
    assert.equal(errorAndChangeUpdateStructured.result.exitCode, 1);
    const suiteUpdateEnvelope = JSON.parse(
      errorAndChangeUpdateStructured.stdout,
    ) as {
      variant: string;
      data: {
        errors: unknown[];
        report: {
          bindings: Array<{
            bindingId: string;
            consistency?: string;
            errors?: Array<{
              referenceId?: string;
              memberId?: string;
              code: string;
            }>;
            changes: Array<{
              kind: string;
              memberChanges?: Array<{
                memberId: string;
                afterPresent: boolean;
              }>;
            }>;
          }>;
        };
      };
    };
    assert.equal(suiteUpdateEnvelope.variant, "rejected");
    assert.deepEqual(suiteUpdateEnvelope.data.errors, []);
    const suiteBinding = suiteUpdateEnvelope.data.report.bindings.find(
      (binding) => binding.bindingId === "suite-binding",
    );
    assert.ok(suiteBinding);
    assert.equal(suiteBinding.consistency, undefined);
    assert.equal(suiteBinding.errors?.[0]?.referenceId, "suite-ref");
    assert.equal(suiteBinding.errors?.[0]?.memberId, "a");
    assert.equal(suiteBinding.errors?.[0]?.code, "missing-observation");
    assert.equal(suiteBinding.changes[0]?.memberChanges?.[0]?.memberId, "b");
    assert.equal(
      suiteBinding.changes[0]?.memberChanges?.[0]?.afterPresent,
      true,
    );
    assert.equal(
      await readFile(join(root, "dock.baseline.json"), "utf8"),
      baselineBeforeSuiteError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("renders local line-level context hunks for multiline text fact changes while keeping full facts in structured output", async () => {
  const root = await createConfigWorkspace();
  const configPath = join(root, "dock.config.mjs");
  const guidePath = join(root, "guide.md");
  const notesPath = join(root, "notes.txt");
  const docPath = join(root, "doc.md");
  const modPath = join(root, "mod.ts");

  try {
    const initialLines = Array.from(
      { length: 15 },
      (_, index) => `Line ${String(index + 1).padStart(2, "0")}`,
    );
    const initialText = `${initialLines.join("\n")}\n`;
    await writeFile(guidePath, initialText);
    await writeFile(notesPath, "See guide.md\n");
    await writeFile(
      docPath,
      "# Intro\n\nIntro paragraph.\n\n## Install\n\nRun install.\n",
    );
    await writeFile(
      modPath,
      "export const unused = 1;\n\nexport function greet(name: string): string {\n  return name;\n}\n",
    );
    await writeFile(
      configPath,
      [
        'import { binding, defineConfig, file } from "@ykdz/dock";',
        'import { markdown } from "@ykdz/dock/markdown";',
        'import { typescript } from "@ykdz/dock/typescript";',
        "export default defineConfig({",
        "  plugins: [file, markdown, typescript],",
        "  bindings: [",
        '    binding("guide-binding", [',
        '      file.from("guide.md").reference("guide-ref"),',
        '      file.from("notes.txt").reference("notes-ref"),',
        '      markdown.from("doc.md").section("Install").reference("doc-install"),',
        '      typescript.from("mod.ts").symbol("greet").reference("ts-greet"),',
        "    ]),",
        "  ],",
        "});",
      ].join("\n"),
    );

    const baseline = await runCli([
      "baseline",
      "update",
      "--config",
      configPath,
    ]);
    assert.equal(baseline.result.exitCode, 0, baseline.stdout);

    const updatedLines = [...initialLines];
    updatedLines[7] = "Line 08 updated";
    const updatedText = `${updatedLines.join("\n")}\n`;
    await writeFile(guidePath, updatedText);

    const diffText = await runCli(["check", "--config", configPath]);
    assert.equal(diffText.result.exitCode, 1);
    assert.equal(diffText.stderr, "");
    assert.match(
      diffText.stdout,
      /Change: guide-ref fact changed \(guide\.md:1-15\)/,
    );
    assert.match(diffText.stdout, /@@ /);
    assert.match(diffText.stdout, /Line 06/);
    assert.match(diffText.stdout, /Line 07/);
    assert.match(diffText.stdout, /-\s+.*Line 08/);
    assert.match(diffText.stdout, /\+\s+.*Line 08 updated/);
    assert.match(diffText.stdout, /Line 09/);
    assert.match(diffText.stdout, /Line 10/);
    assert.doesNotMatch(diffText.stdout, /Line 01/);
    assert.doesNotMatch(diffText.stdout, /Line 15/);
    assert.ok(!diffText.stdout.includes(JSON.stringify(initialText)));
    assert.match(diffText.stdout, /notes-ref \(notes\.txt:1\)/);
    assert.match(diffText.stdout, /doc-install \(doc\.md:7\)/);
    assert.match(diffText.stdout, /ts-greet \(mod\.ts:3-5\)/);

    const diffStructured = await runCli([
      "check",
      "--config",
      configPath,
      "--output",
      "structured",
    ]);
    assert.equal(diffStructured.result.exitCode, 1);
    const structured = JSON.parse(diffStructured.stdout) as {
      data: {
        report: {
          bindings: Array<{
            changes: Array<{ before?: string; after?: string }>;
            current: {
              references: Record<
                string,
                { range?: { path: string; start: number; end: number } }
              >;
            };
          }>;
        };
      };
    };
    const factChange = structured.data.report.bindings[0]?.changes[0];
    assert.equal(factChange?.before, initialText);
    assert.equal(factChange?.after, updatedText);
    assert.deepEqual(
      structured.data.report.bindings[0]?.current.references["guide-ref"]
        ?.range,
      { path: "guide.md", start: 0, end: updatedText.length },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("reports empty-selection at top level without claiming consistency, isolates missing-file errors to binding, and reports invalid plugin diagnostics separately", async () => {
  const { updateBaseline } = await import("@ykdz/dock");
  const root = await createConfigWorkspace();
  const emptyConfigPath = join(root, "empty.config.mjs");
  const fileConfigPath = join(root, "dock.config.mjs");
  const diagConfigPath = join(root, "diag.config.mjs");
  const guidePath = join(root, "guide.txt");
  const baselinePath = join(root, "dock.baseline.json");

  try {
    await writeFile(
      emptyConfigPath,
      [
        'import { defineConfig } from "@ykdz/dock";',
        "export default defineConfig({ plugins: [], bindings: [] });",
      ].join("\n"),
    );

    const emptyText = await runCli([
      "baseline",
      "update",
      "--config",
      emptyConfigPath,
    ]);
    assert.equal(emptyText.result.exitCode, 1);
    assert.equal(emptyText.stderr, "");
    assert.match(emptyText.stdout, /Scope: none/);
    assert.doesNotMatch(
      emptyText.stdout,
      /All checked bindings are consistent with baseline\./,
    );
    assert.match(emptyText.stdout, /Update error \(empty-selection\):/);
    assert.match(emptyText.stdout, /Baseline was not updated\./);

    const emptyStructured = await runCli([
      "baseline",
      "update",
      "--config",
      emptyConfigPath,
      "--output",
      "structured",
    ]);
    assert.equal(emptyStructured.result.exitCode, 1);
    const emptyEnvelope = JSON.parse(emptyStructured.stdout) as {
      variant: string;
      data: {
        errors: Array<{ code: string; message: string }>;
        report: { scope: string[]; bindings: unknown[] };
      };
    };
    assert.equal(emptyEnvelope.variant, "rejected");
    assert.deepEqual(emptyEnvelope.data.report.scope, []);
    assert.deepEqual(emptyEnvelope.data.report.bindings, []);
    assert.equal(emptyEnvelope.data.errors.length, 1);
    assert.equal(emptyEnvelope.data.errors[0]?.code, "empty-selection");

    await writeFile(guidePath, "stable guide\n");
    await writeFile(
      fileConfigPath,
      [
        'import { binding, defineConfig, file } from "@ykdz/dock";',
        "export default defineConfig({",
        "  plugins: [file],",
        '  bindings: [binding("guide-policy", [file.from("guide.txt").reference("guide-ref")])],',
        "});",
      ].join("\n"),
    );

    const initial = await runCli([
      "baseline",
      "update",
      "--config",
      fileConfigPath,
    ]);
    assert.equal(initial.result.exitCode, 0);
    assert.match(initial.stdout, /Baseline updated\./);
    const savedBaseline = await readFile(baselinePath, "utf8");

    await rm(guidePath);

    const jsOutcome = await updateBaseline(fileConfigPath);
    assert.equal(jsOutcome.status, "rejected");
    if (jsOutcome.status !== "rejected") return;
    assert.deepEqual(jsOutcome.errors, []);
    assert.equal(jsOutcome.report.bindings[0]?.consistency, undefined);
    assert.equal(
      jsOutcome.report.bindings[0]?.errors?.[0]?.code,
      "missing-file",
    );
    assert.equal(await readFile(baselinePath, "utf8"), savedBaseline);

    const missingFileText = await runCli([
      "baseline",
      "update",
      "--config",
      fileConfigPath,
    ]);
    assert.equal(missingFileText.result.exitCode, 1);
    assert.equal(
      missingFileText.stdout.match(/Error guide-ref \(missing-file\):/g)
        ?.length,
      1,
    );
    assert.doesNotMatch(missingFileText.stdout, /Update error/);
    assert.match(missingFileText.stdout, /Baseline was not updated\./);
    assert.equal(await readFile(baselinePath, "utf8"), savedBaseline);

    const missingFileStructured = await runCli([
      "baseline",
      "update",
      "--config",
      fileConfigPath,
      "--output",
      "structured",
    ]);
    assert.equal(missingFileStructured.result.exitCode, 1);
    const missingFileEnvelope = JSON.parse(missingFileStructured.stdout) as {
      variant: string;
      data: {
        errors: unknown[];
        report: {
          bindings: Array<{
            bindingId: string;
            errors?: Array<{ referenceId?: string; code: string }>;
          }>;
        };
      };
    };
    assert.equal(missingFileEnvelope.variant, "rejected");
    assert.deepEqual(missingFileEnvelope.data.errors, []);
    assert.equal(
      missingFileEnvelope.data.report.bindings[0]?.errors?.[0]?.code,
      "missing-file",
    );
    assert.equal(await readFile(baselinePath, "utf8"), savedBaseline);

    await writeFile(
      diagConfigPath,
      [
        'import { binding, createReference, defineConfig, definePlugin } from "@ykdz/dock";',
        "const plugin = definePlugin({",
        '  id: "fixture:bad-diag",',
        "  validate() {},",
        "  collect(request) {",
        "    return {",
        "      results: request.selectedReferences.map((reference) => ({",
        "        referenceId: reference.id,",
        '        kind: "value",',
        '        value: "valid-fact",',
        "      })),",
        '      diagnostics: { data: new Date(), text: ["ignored"] },',
        "    };",
        "  },",
        "});",
        "export default defineConfig({",
        "  plugins: [plugin],",
        '  bindings: [binding("diag-policy", [createReference("fixture:bad-diag", "diag-ref", "target")])],',
        "});",
      ].join("\n"),
    );

    const diagUpdateText = await runCli([
      "baseline",
      "update",
      "--config",
      diagConfigPath,
    ]);
    assert.equal(diagUpdateText.result.exitCode, 0);
    assert.match(
      diagUpdateText.stdout,
      /Plugin fixture:bad-diag error \(invalid-plugin-diagnostics\):/,
    );
    assert.match(diagUpdateText.stdout, /Baseline updated\./);

    const diagUpdateStructured = await runCli([
      "baseline",
      "update",
      "--config",
      diagConfigPath,
      "--output",
      "structured",
    ]);
    assert.equal(diagUpdateStructured.result.exitCode, 0);
    const diagEnvelope = JSON.parse(diagUpdateStructured.stdout) as {
      variant: string;
      data: {
        report: {
          pluginErrors: Array<{ pluginId: string; code: string }>;
          bindings: Array<{
            consistency?: string;
            current?: { references: Record<string, { value: unknown }> };
          }>;
        };
      };
    };
    assert.equal(diagEnvelope.variant, "updated");
    assert.equal(
      diagEnvelope.data.report.pluginErrors[0]?.code,
      "invalid-plugin-diagnostics",
    );
    assert.equal(
      diagEnvelope.data.report.bindings[0]?.consistency,
      "consistent",
    );
    assert.equal(
      diagEnvelope.data.report.bindings[0]?.current?.references["diag-ref"]
        ?.value,
      "valid-fact",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("CLI and JS API distinguish V3 baseline corruption diagnostics from normal fact changes and preserve corrupted baseline bytes", async () => {
  const root = await createConfigWorkspace();
  const configPath = join(root, "dock.config.mjs");
  const baselinePath = join(root, "dock.baseline.json");
  const factPath = join(root, "fact.txt");
  const statePath = join(root, "members.json");

  try {
    await writeFile(factPath, "alpha-v1", "utf8");
    await writeFile(
      statePath,
      JSON.stringify({
        members: [
          {
            id: "member one",
            value: { status: "passed", customMetric: 7, labels: ["smoke"] },
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      configPath,
      [
        'import { readFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'import { binding, createReference, defineConfig, definePlugin } from "@ykdz/dock";',
        "const plugin = definePlugin({",
        '  id: "fixture:v3-diag",',
        "  validate() {},",
        "  fileInfo(ref) {",
        '    return ref.target === "members.json" ? "members.json" : "fact.txt";',
        "  },",
        "  collect(request, context) {",
        "    return {",
        "      results: request.selectedReferences.map((ref) => {",
        '        if (ref.target === "members.json") {',
        '          const parsed = JSON.parse(readFileSync(join(context.root, "members.json"), "utf8"));',
        "          return {",
        "            referenceId: ref.id,",
        '            kind: "collection",',
        '            collection: { completeness: "complete", members: parsed.members },',
        "          };",
        "        }",
        '        const raw = readFileSync(join(context.root, "fact.txt"), "utf8");',
        "        return {",
        "          referenceId: ref.id,",
        '          kind: "value",',
        "          value: { text: raw, businessTag: ref.id },",
        "        };",
        "      }),",
        "    };",
        "  },",
        "});",
        "export default defineConfig({",
        "  plugins: [plugin],",
        "  bindings: [",
        '    binding("cli binding.v1", [',
        '      createReference("fixture:v3-diag", "plain ref", "fact.txt"),',
        '      createReference("fixture:v3-diag", "suite.ref", "members.json"),',
        "    ]),",
        "  ],",
        "});",
      ].join("\n"),
      "utf8",
    );

    const created = await runCli([
      "baseline",
      "update",
      "--config",
      configPath,
    ]);
    assert.equal(created.result.exitCode, 0, created.stderr);
    const validBaselineRaw = await readFile(baselinePath, "utf8");

    // Normal fact drift: check returns data variant "changed" on stdout, distinct from baseline failure.
    await writeFile(factPath, "alpha-v2", "utf8");
    const driftStructured = await runCli([
      "check",
      "--config",
      configPath,
      "--output",
      "structured",
    ]);
    assert.equal(driftStructured.result.exitCode, 1);
    assert.equal(driftStructured.stderr, "");
    const driftEnvelope = JSON.parse(driftStructured.stdout) as {
      kind: string;
      variant: string;
    };
    assert.equal(driftEnvelope.kind, "data");
    assert.equal(driftEnvelope.variant, "changed");

    await writeFile(factPath, "alpha-v1", "utf8");

    // 1) Missing required reference fact vs extra reference fact.
    const missingObj = JSON.parse(validBaselineRaw) as {
      bindings: Record<string, { references: Record<string, unknown> }>;
    };
    delete missingObj.bindings["cli binding.v1"]!.references["suite.ref"];
    const missingRaw = `${JSON.stringify(missingObj, null, 2)}\n`;
    await writeFile(baselinePath, missingRaw, "utf8");

    for (const argv of [
      ["check", "--config", configPath],
      ["baseline", "update", "--config", configPath],
    ]) {
      const outcome = await runCli(argv);
      assert.equal(outcome.result.exitCode, 1);
      assert.equal(outcome.stdout, "");
      assert.match(outcome.stderr, /Maintenance failed \(baseline-invalid\)/);
      assert.ok(outcome.stderr.includes(baselinePath));
      assert.match(outcome.stderr, /cli binding\.v1/);
      assert.match(outcome.stderr, /suite\.ref/);
      assert.match(outcome.stderr, /missing required reference fact/i);
      assert.equal(await readFile(baselinePath, "utf8"), missingRaw);
    }

    const extraObj = JSON.parse(validBaselineRaw) as {
      bindings: Record<string, { references: Record<string, unknown> }>;
    };
    extraObj.bindings["cli binding.v1"]!.references["extra.ref"] = {
      definition: {
        id: "extra.ref",
        target: { pluginId: "fixture:v3-diag", target: "x", fileInfo: null },
      },
      value: "x",
    };
    const extraRaw = `${JSON.stringify(extraObj, null, 2)}\n`;
    await writeFile(baselinePath, extraRaw, "utf8");

    for (const argv of [
      ["check", "--config", configPath, "--output", "structured"],
      ["baseline", "update", "--config", configPath, "--output", "structured"],
    ]) {
      const outcome = await runCli(argv);
      assert.equal(outcome.result.exitCode, 1);
      assert.equal(outcome.stdout, "");
      const envelope = JSON.parse(outcome.stderr) as {
        kind: string;
        variant: string;
        data: { code: string; message: string };
      };
      assert.equal(envelope.kind, "failure");
      assert.equal(envelope.variant, "maintenanceFailed");
      assert.equal(envelope.data.code, "baseline-invalid");
      assert.match(envelope.data.message, /unexpected reference fact/i);
      assert.doesNotMatch(envelope.data.message, /missing required/i);
      assert.match(envelope.data.message, /cli binding\.v1/);
      assert.match(envelope.data.message, /extra\.ref/);
      assert.equal(await readFile(baselinePath, "utf8"), extraRaw);
    }

    // 2) Duplicate keys (repeated 3x reported once) + unknown fields on Dock and member-collection records.
    const prettyRaw = `${JSON.stringify(JSON.parse(validBaselineRaw), null, 2)}\n`;
    const multiCorrupted = prettyRaw
      .replace(
        '"id": "plain ref",',
        '"id": "plain ref",\n              "id": "plain ref",\n              "id": "plain ref",',
      )
      .replace(
        '"fileInfo": "fact.txt"',
        '"fileInfo": "fact.txt",\n              "wrapperUnknown": true',
      )
      .replace(
        '"id": "member one",',
        '"id": "member one",\n                "memberUnknown": 42,',
      );
    assert.notEqual(multiCorrupted, prettyRaw);
    await writeFile(baselinePath, multiCorrupted, "utf8");

    const multiText = await runCli(["check", "--config", configPath]);
    assert.equal(multiText.result.exitCode, 1);
    assert.equal(multiText.stdout, "");
    assert.match(multiText.stderr, /Maintenance failed \(baseline-invalid\)/);
    assert.match(multiText.stderr, /references\["plain ref"\]\.definition\.id/);
    assert.equal(multiText.stderr.match(/Duplicate key "id"/g)?.length, 1);
    assert.match(multiText.stderr, /definition\.target\.wrapperUnknown/);
    assert.match(multiText.stderr, /value\[0\]\.memberUnknown/);

    const updateRejected = await runCli([
      "baseline",
      "update",
      "--config",
      configPath,
    ]);
    assert.equal(updateRejected.result.exitCode, 1);
    assert.equal(await readFile(baselinePath, "utf8"), multiCorrupted);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("deduplicates repeated root-cause explanations in default CLI text while preserving structured errors and unreadable source protection", async () => {
  const root = await createConfigWorkspace();
  const configPath = join(root, "dock.config.mjs");
  const guidePath = join(root, "guide.md");
  const baselinePath = join(root, "dock.baseline.json");

  try {
    await writeFile(
      guidePath,
      [
        "# Usage",
        "",
        "Run dock check.",
        "",
        "# Notes",
        "",
        "Keep baselines clean.",
        "",
        "<!-- dock:start unused -->",
        "",
        "<!-- dock:strat typo -->",
        "",
      ].join("\n"),
      "utf8",
    );

    const savedBaseline = `${JSON.stringify(
      {
        version: 3,
        bindings: {
          "usage-policy": {
            definition: {
              id: "usage-policy",
              references: ["usage-para", "usage-heading"],
            },
            references: {
              "usage-para": {
                definition: {
                  id: "usage-para",
                  target: {
                    pluginId: "@ykdz/dock-reference-markdown",
                    target: "guide.md",
                    fileInfo: "guide.md",
                  },
                  selection: {
                    kind: "markdown",
                    steps: [{ kind: "section", heading: "Usage" }],
                  },
                },
                value: "Run dock check.",
              },
              "usage-heading": {
                definition: {
                  id: "usage-heading",
                  target: {
                    pluginId: "@ykdz/dock-reference-markdown",
                    target: "guide.md",
                    fileInfo: "guide.md",
                  },
                  selection: {
                    kind: "markdown",
                    steps: [{ kind: "quote", text: "Run dock check." }],
                  },
                },
                value: "Run dock check.",
              },
            },
          },
          "notes-policy": {
            definition: {
              id: "notes-policy",
              references: ["notes-para"],
            },
            references: {
              "notes-para": {
                definition: {
                  id: "notes-para",
                  target: {
                    pluginId: "@ykdz/dock-reference-markdown",
                    target: "guide.md",
                    fileInfo: "guide.md",
                  },
                  selection: {
                    kind: "markdown",
                    steps: [{ kind: "section", heading: "Notes" }],
                  },
                },
                value: "Keep baselines clean.",
              },
            },
          },
        },
      },
      null,
      2,
    )}\n`;
    await writeFile(baselinePath, savedBaseline, "utf8");

    await writeFile(
      configPath,
      [
        'import { binding, defineConfig } from "@ykdz/dock";',
        'import { markdown } from "@ykdz/dock/markdown";',
        "export default defineConfig({",
        "  plugins: [markdown],",
        "  bindings: [",
        '    binding("usage-policy", [',
        '      markdown.from("guide.md").section("Usage").reference("usage-para"),',
        '      markdown.from("guide.md").quote("Run dock check.").reference("usage-heading"),',
        "    ]),",
        '    binding("notes-policy", [',
        '      markdown.from("guide.md").section("Notes").reference("notes-para"),',
        "    ]),",
        "  ],",
        "});",
      ].join("\n"),
      "utf8",
    );

    const checkText = await runCli(["check", "--config", configPath]);
    assert.equal(checkText.result.exitCode, 1);
    assert.equal(checkText.stderr, "");
    assert.equal(
      checkText.stdout.match(/Invalid Dock directives in guide\.md:/g)?.length,
      1,
      checkText.stdout,
    );
    assert.equal(
      checkText.stdout.match(/guide\.md:9: Unclosed start marker/g)?.length,
      1,
    );
    assert.equal(
      checkText.stdout.match(/guide\.md:11: Unknown Dock directive/g)?.length,
      1,
    );
    assert.match(checkText.stdout, /Binding usage-policy/);
    assert.match(checkText.stdout, /Binding notes-policy/);
    assert.match(
      checkText.stdout,
      /Error usage-heading \(invalid-marker\) \(guide\.md:9\): same root cause as notes-para/,
    );
    assert.match(
      checkText.stdout,
      /Error usage-para \(invalid-marker\) \(guide\.md:9\): same root cause as notes-para/,
    );

    const checkStructured = await runCli([
      "check",
      "--config",
      configPath,
      "--output",
      "structured",
    ]);
    assert.equal(checkStructured.result.exitCode, 1);
    const structuredEnvelope = JSON.parse(checkStructured.stdout) as {
      variant: string;
      data: {
        report: {
          bindings: Array<{
            bindingId: string;
            errors?: Array<{
              referenceId?: string;
              code: string;
              message: string;
            }>;
          }>;
        };
      };
    };
    assert.equal(structuredEnvelope.variant, "errors");
    for (const item of structuredEnvelope.data.report.bindings) {
      assert.ok(item.errors && item.errors.length > 0, item.bindingId);
      assert.equal(item.errors[0]?.code, "invalid-marker");
    }

    const updateText = await runCli([
      "baseline",
      "update",
      "--config",
      configPath,
    ]);
    assert.equal(updateText.result.exitCode, 1);
    assert.equal(
      updateText.stdout.match(/Invalid Dock directives in guide\.md:/g)?.length,
      1,
      updateText.stdout,
    );
    assert.equal(await readFile(baselinePath, "utf8"), savedBaseline);

    const missingSourceConfig = join(root, "missing-source.config.mjs");
    await writeFile(
      missingSourceConfig,
      [
        'import { defineConfig } from "@ykdz/dock";',
        'import { markdown } from "@ykdz/dock/markdown";',
        "export default defineConfig({",
        `  baseline: ${JSON.stringify(baselinePath)},`,
        "  plugins: [markdown],",
        '  sources: [markdown.source("missing-guide.md")],',
        "});",
      ].join("\n"),
      "utf8",
    );
    const missingSourceUpdate = await runCli([
      "baseline",
      "update",
      "--config",
      missingSourceConfig,
    ]);
    assert.equal(missingSourceUpdate.result.exitCode, 1);
    assert.match(
      missingSourceUpdate.stderr,
      /Maintenance failed \(declaration-source-read-failed\)/,
    );
    assert.equal(await readFile(baselinePath, "utf8"), savedBaseline);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
