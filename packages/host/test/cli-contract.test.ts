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
      /Update error doc-policy \/ fact-ref \(missing-fact\):/,
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
      data: { errors: { code: string }[] };
    };
    assert.equal(rejectedEnvelope.kind, "data");
    assert.equal(rejectedEnvelope.variant, "rejected");
    assert.equal(rejectedEnvelope.data.errors[0]?.code, "missing-fact");
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

    // 3) Binding with both errors and confirmed changes: displays errors first, then confirmed changes.
    await writeFile(versionPath, "1.0.0");
    await runCli(["baseline", "update", "--config", configPath]);
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
