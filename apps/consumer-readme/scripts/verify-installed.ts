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

  const listing = run("npm", ["ls", "--all", "--json", "--prefix", consumer]);
  assert.notEqual(
    listing.stdout.trim(),
    "",
    `npm ls produced no JSON output: ${listing.stderr}`,
  );
  const dependencyTree = JSON.parse(listing.stdout) as {
    readonly problems?: readonly string[];
  };
  for (const problem of dependencyTree.problems ?? []) {
    assert.match(
      problem,
      /^missing: .* required by .*@npm:dock@$/u,
      `Unexpected npm ls problem in consumer: ${problem}`,
    );
  }
  const installedPackages = collectInstalledPackageNames(dependencyTree);
  assert.ok(
    installedPackages.has("@ykdz/dock"),
    "Consumer must install @ykdz/dock from the tarball.",
  );
  for (const forbidden of [
    "@dock/core",
    "@dock/host",
    "@dock/text-selection",
    "@dock/file",
    "@dock/markdown",
    "@dock/typescript",
    "@dock/node-test",
    "@dock/vitest",
    "@dock/tooling-config",
    "@ykdz/dock-core",
    "@ykdz/dock-reference-file",
    "@ykdz/dock-reference-markdown",
    "@ykdz/dock-reference-typescript",
    "@ykdz/dock-reference-node-test",
    "@ykdz/dock-reference-vitest",
  ]) {
    assert.equal(
      installedPackages.has(forbidden),
      false,
      `External consumer node_modules must not contain ${forbidden}`,
    );
  }
  for (const name of installedPackages) {
    assert.equal(
      name.startsWith("@dock/"),
      false,
      `External consumer node_modules must not contain workspace internal package ${name}`,
    );
  }

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
  assert.equal(
    (JSON.parse(baseline.toString("utf8")) as { version?: unknown }).version,
    3,
    "README bootstrap baseline must use version 3.",
  );

  const textChecked = run(bin("dock"), ["check", "--config", "dock.config.ts"]);
  assert.equal(textChecked.status, 0, textChecked.stdout + textChecked.stderr);
  assert.equal(textChecked.stderr, "");
  assert.equal(
    textChecked.stdout,
    "Scope: readme-extension, readme-workflow\nAll checked bindings are consistent with baseline.\n",
  );
  assert.deepEqual(await readFile(baselinePath), baseline);

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
    const failedText = run(bin("dock"), [
      ...command,
      "--config",
      "dock.config.ts",
    ]);
    assert.equal(failedText.status, 1, failedText.stdout + failedText.stderr);
    assert.equal(failedText.stderr, "");
    assert.match(failedText.stdout, /Error readme-example \(test-failed\):/);
    if (variant === "rejected") {
      assert.match(failedText.stdout, /Baseline was not updated\./);
      assert.doesNotMatch(failedText.stdout, /Update error/);
    }
    assert.deepEqual(await readFile(baselinePath), baseline);

    const failed = run(bin("dock"), [
      ...command,
      "--config",
      "dock.config.ts",
      "--output",
      "structured",
    ]);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    const failure = readReport(
      failed.stdout,
      variant,
      command[0] === "baseline",
    );
    assert.deepEqual(failure.pluginErrors, []);
    assert.ok(
      failure.bindings.some((binding) =>
        binding.errors?.some((error) => error.code === "test-failed"),
      ),
      "Broken README example plugin must report a native test failure.",
    );
    assert.deepEqual(await readFile(baselinePath), baseline);
  }

  // Verify the inline dock:bind authoring loop against the restored README inside the isolated consumer.
  await writeFile(readmePath, original, "utf8");
  const probeMarkerPath = join(consumer, ".inline-probe-executed");
  await writeFile(
    join(consumer, "scripts", "inline-probe.test.ts"),
    [
      'import { writeFileSync } from "node:fs";',
      'import { test } from "node:test";',
      `writeFileSync(${JSON.stringify(probeMarkerPath)}, "ran", "utf8");`,
      'void test("README inline probe", () => {});',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(consumer, "inline.config.ts"),
    [
      'import { dirname, join, relative } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      'import { binding, defineConfig } from "@ykdz/dock";',
      'import { markdown } from "@ykdz/dock/markdown";',
      'import { defineNodeTestRun, nodeTest, nodeTestStatus } from "@ykdz/dock/node-test";',
      'const root = dirname(fileURLToPath(import.meta.resolve("dock/README.md")));',
      "const consumerDir = dirname(fileURLToPath(import.meta.url));",
      'const readmeDoc = markdown.from("README.md");',
      'const probeFile = relative(root, join(consumerDir, "scripts/inline-probe.test.ts"));',
      'const probeRun = defineNodeTestRun("README inline probe", { files: [probeFile] });',
      'const probeRef = nodeTestStatus("readme example", probeRun, { file: probeFile, name: "README inline probe" });',
      "export default defineConfig({",
      "  root,",
      '  baseline: relative(root, join(consumerDir, "inline.baseline.json")),',
      "  plugins: [markdown, nodeTest],",
      "  bindings: [",
      '    binding("readme-usage-policy", [',
      '      readmeDoc.section("如何使用").reference("readme-usage"),',
      "      probeRef,",
      "    ]),",
      "  ],",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const inlineUpdateInit = run(bin("dock"), [
    "baseline",
    "update",
    "--config",
    "inline.config.ts",
  ]);
  assert.equal(
    inlineUpdateInit.status,
    0,
    inlineUpdateInit.stdout + inlineUpdateInit.stderr,
  );
  await rm(probeMarkerPath, { force: true });

  // Edit ONLY README.md to add a second statement using dock:bind with a blank line and spaced reference ID.
  const anchorLine =
    "> 这份 README 也 [接入](apps/consumer-readme/) 了 Dock，其中书写的命令和示例等都可以在与实际行为发生偏移时被检查出来。";
  assert.ok(original.includes(anchorLine));
  const inlineDirective =
    '<!-- dock:bind {"id":"readme-inline-statement","with":["readme example","readme-usage"]} -->';
  const inlineProse = "新增内联说明：示例测试与使用文档共同保持一致。";
  const readmeWithInline = original.replace(
    anchorLine,
    [anchorLine, "", inlineDirective, "", inlineProse].join("\n"),
  );
  await writeFile(readmePath, readmeWithInline, "utf8");
  const directiveLine =
    readmeWithInline.split("\n").indexOf(inlineDirective) + 1;
  const proseLine = readmeWithInline.split("\n").indexOf(inlineProse) + 1;

  const inspectedInlineText = run(bin("dock"), [
    "inspect",
    "--config",
    "inline.config.ts",
  ]);
  assert.equal(
    inspectedInlineText.status,
    0,
    inspectedInlineText.stdout + inspectedInlineText.stderr,
  );
  assert.equal(inspectedInlineText.stderr, "");
  assert.match(
    inspectedInlineText.stdout,
    /Scope: readme-inline-statement, readme-usage-policy/,
  );

  const inspectedInline = run(bin("dock"), [
    "inspect",
    "--config",
    "inline.config.ts",
    "--output",
    "structured",
  ]);
  assert.equal(
    inspectedInline.status,
    0,
    inspectedInline.stdout + inspectedInline.stderr,
  );
  await assert.rejects(
    readFile(probeMarkerPath, "utf8"),
    /ENOENT/,
    "dock inspect must resolve inline bindings without executing business tests.",
  );
  const inspectedEnvelope = JSON.parse(inspectedInline.stdout) as {
    data?: {
      resolution?: {
        context: {
          bindings: { id: string; references: string[] }[];
          references: { id: string }[];
        };
        declarationSources: {
          bindings: Record<string, string[]>;
        };
      };
    };
  };
  const resolution = inspectedEnvelope.data?.resolution;
  assert.ok(resolution);
  assert.deepEqual(
    resolution.context.bindings.find(
      (entry) => entry.id === "readme-inline-statement",
    ),
    {
      id: "readme-inline-statement",
      references: [
        "dock:bind:readme-inline-statement",
        "readme example",
        "readme-usage",
      ],
    },
  );
  assert.deepEqual(
    resolution.declarationSources.bindings["readme-inline-statement"],
    [`README.md:${directiveLine}`],
  );
  await runConsumerJs("verify-inline-inspect.mjs", [
    'import assert from "node:assert/strict";',
    'import { readFile } from "node:fs/promises";',
    'import { inspect } from "@ykdz/dock";',
    'const jsInspected = await inspect("inline.config.ts");',
    "assert.deepEqual(",
    '  jsInspected.context.bindings.find((entry) => entry.id === "readme-inline-statement"),',
    '  { id: "readme-inline-statement", references: ["dock:bind:readme-inline-statement", "readme example", "readme-usage"] },',
    ");",
    "assert.deepEqual(",
    '  jsInspected.declarationSources.bindings["readme-inline-statement"],',
    `  ["README.md:${directiveLine}"],`,
    ");",
    `await assert.rejects(readFile(${JSON.stringify(probeMarkerPath)}, "utf8"), /ENOENT/);`,
  ]);

  const inlineBaselineInit = run(bin("dock"), [
    "baseline",
    "update",
    "--config",
    "inline.config.ts",
  ]);
  assert.equal(
    inlineBaselineInit.status,
    0,
    inlineBaselineInit.stdout + inlineBaselineInit.stderr,
  );

  // Mutate a referenced fact (usage section) and verify all 4 surfaces report the drift and inline prose line.
  const usageTarget = "配置好后，先保存基线。";
  assert.ok(readmeWithInline.includes(usageTarget));
  const readmeFactChanged = readmeWithInline.replace(
    usageTarget,
    "配置完成后，先保存基线。",
  );
  await writeFile(readmePath, readmeFactChanged, "utf8");

  const inlineChangedCheck = run(bin("dock"), [
    "check",
    "--config",
    "inline.config.ts",
  ]);
  assert.equal(
    inlineChangedCheck.status,
    1,
    inlineChangedCheck.stdout + inlineChangedCheck.stderr,
  );
  assert.match(inlineChangedCheck.stdout, /Binding readme-inline-statement/);
  assert.match(inlineChangedCheck.stdout, /Change: readme-usage fact changed/);
  assert.ok(
    inlineChangedCheck.stdout.includes(
      `dock:bind:readme-inline-statement (README.md:${proseLine})`,
    ),
    inlineChangedCheck.stdout,
  );
  const inlineChangedStructured = run(bin("dock"), [
    "check",
    "--config",
    "inline.config.ts",
    "--output",
    "structured",
  ]);
  assert.equal(
    inlineChangedStructured.status,
    1,
    inlineChangedStructured.stdout + inlineChangedStructured.stderr,
  );
  const inlineChangedReport = readReport(
    inlineChangedStructured.stdout,
    "changed",
  );
  assert.ok(
    inlineChangedReport.bindings.some(
      (entry) => entry.bindingId === "readme-inline-statement",
    ),
  );
  await runConsumerJs("verify-inline-changed.mjs", [
    'import assert from "node:assert/strict";',
    'import { check } from "@ykdz/dock";',
    'const report = await check("inline.config.ts");',
    'const inlineBinding = report.bindings.find((entry) => entry.bindingId === "readme-inline-statement");',
    'assert.equal(inlineBinding?.consistency, "inconsistent");',
    'assert.ok(inlineBinding?.changes?.some((change) => change.kind === "fact" && change.referenceId === "readme-usage"));',
  ]);

  const inlineBaselineUpdated = run(bin("dock"), [
    "baseline",
    "update",
    "--config",
    "inline.config.ts",
  ]);
  assert.equal(
    inlineBaselineUpdated.status,
    0,
    inlineBaselineUpdated.stdout + inlineBaselineUpdated.stderr,
  );
  const inlineConsistent = run(bin("dock"), [
    "check",
    "--config",
    "inline.config.ts",
  ]);
  assert.equal(
    inlineConsistent.status,
    0,
    inlineConsistent.stdout + inlineConsistent.stderr,
  );
  assert.match(
    inlineConsistent.stdout,
    /All checked bindings are consistent with baseline\./,
  );

  // Reorder paragraphs and adjust blank lines around/between dock:bind and its prose block; identity stays stable.
  const leadParagraph =
    "Dock 适合需要长期维护文档的项目，尤其是主要由 Agent 维护、文档较多且修改频繁的项目。";
  assert.ok(readmeFactChanged.includes(leadParagraph));
  const readmeReordered = readmeFactChanged
    .replace(`${leadParagraph}\n\n`, "")
    .replace(
      [anchorLine, "", inlineDirective, "", inlineProse].join("\n"),
      [
        anchorLine,
        "",
        inlineDirective,
        "",
        "",
        inlineProse,
        "",
        leadParagraph,
      ].join("\n"),
    );
  await writeFile(readmePath, readmeReordered, "utf8");
  const reorderedConsistent = run(bin("dock"), [
    "check",
    "--config",
    "inline.config.ts",
  ]);
  assert.equal(
    reorderedConsistent.status,
    0,
    reorderedConsistent.stdout + reorderedConsistent.stderr,
  );
  assert.match(
    reorderedConsistent.stdout,
    /All checked bindings are consistent with baseline\./,
  );

  // Corrupt the baselined dock:bind declaration and verify CLI + JS reject updates, preserve baseline bytes, and do not infer untracked.
  const inlineBaselinePath = join(consumer, "inline.baseline.json");
  const savedInlineBaseline = await readFile(inlineBaselinePath);
  const reorderedDirectiveLine =
    readmeReordered.split("\n").indexOf(inlineDirective) + 1;
  const readmeCorrupted = readmeReordered.replace(
    inlineDirective,
    '<!-- dock:bind {"id":"readme-inline-statement","with": -->',
  );
  await writeFile(readmePath, readmeCorrupted, "utf8");

  for (const args of [
    ["check", "--config", "inline.config.ts"],
    ["baseline", "update", "--config", "inline.config.ts"],
  ]) {
    const failed = run(bin("dock"), args);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.match(failed.stderr, /Maintenance failed \(declaration-invalid\)/);
    assert.ok(
      failed.stderr.includes(`README.md:${reorderedDirectiveLine}`),
      failed.stderr,
    );
    assert.doesNotMatch(failed.stderr, /untracked/i);
    assert.deepEqual(await readFile(inlineBaselinePath), savedInlineBaseline);

    const failedStructured = run(bin("dock"), [
      ...args,
      "--output",
      "structured",
    ]);
    assert.equal(
      failedStructured.status,
      1,
      failedStructured.stdout + failedStructured.stderr,
    );
    const failureEnvelope = JSON.parse(failedStructured.stderr) as {
      kind?: unknown;
      variant?: unknown;
      data?: { code?: unknown; message?: string };
    };
    assert.equal(failureEnvelope.kind, "failure");
    assert.equal(failureEnvelope.variant, "maintenanceFailed");
    assert.equal(failureEnvelope.data?.code, "declaration-invalid");
    assert.ok(
      failureEnvelope.data?.message?.includes(
        `README.md:${reorderedDirectiveLine}`,
      ),
      failedStructured.stderr,
    );
    assert.deepEqual(await readFile(inlineBaselinePath), savedInlineBaseline);
  }

  await runConsumerJs("verify-corrupt-inline-js.mjs", [
    'import assert from "node:assert/strict";',
    'import { readFile } from "node:fs/promises";',
    'import { check, inspect, MaintenanceError, updateBaseline } from "@ykdz/dock";',
    'const before = await readFile("inline.baseline.json");',
    'for (const op of [() => inspect("inline.config.ts"), () => check("inline.config.ts"), () => updateBaseline("inline.config.ts")]) {',
    "  await assert.rejects(op, (error) => {",
    "    assert.ok(error instanceof MaintenanceError);",
    '    assert.equal(error.code, "declaration-invalid");',
    `    assert.ok(error.message.includes("README.md:${reorderedDirectiveLine}"), error.message);`,
    "    return true;",
    "  });",
    '  assert.deepEqual(await readFile("inline.baseline.json"), before);',
    "}",
  ]);

  // Onboard a new guide (guide.md containing only dock:bind declarations, zero TS MarkdownReferences) in the same consumer
  // via explicit markdown.source("guide.md") and standalone references, cross-checking all 4 surfaces across inspect, drift, update, and consistency.
  const guideProbeMarker = join(consumer, ".guide-probe-executed");
  await writeFile(join(consumer, "guide-fact.txt"), "exit=1\n", "utf8");
  await writeFile(
    join(consumer, "scripts", "guide.test.ts"),
    [
      'import assert from "node:assert/strict";',
      'import { readFileSync, writeFileSync } from "node:fs";',
      'import { test } from "node:test";',
      `writeFileSync(${JSON.stringify(guideProbeMarker)}, "ran", "utf8");`,
      'void test("guide example passes", () => {',
      '  assert.equal(readFileSync("guide-fact.txt", "utf8").trim(), "exit=1");',
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(consumer, "guide.md"),
    [
      "# New Consumer Guide",
      "",
      '<!-- dock:bind {"id":"guide-exit-policy","with":["guide fact","guide-test"]} -->',
      "",
      "When verification fails, the CLI exits with status 1.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(consumer, "guide.config.ts"),
    [
      'import { dirname } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      'import { defineConfig, file } from "@ykdz/dock";',
      'import { markdown } from "@ykdz/dock/markdown";',
      'import { defineNodeTestRun, nodeTest, nodeTestStatus } from "@ykdz/dock/node-test";',
      "",
      "const root = dirname(fileURLToPath(import.meta.url));",
      'const guideRun = defineNodeTestRun("guide run", { files: ["scripts/guide.test.ts"] });',
      "",
      "export default defineConfig({",
      "  root,",
      '  baseline: "guide.baseline.json",',
      "  plugins: [markdown, file, nodeTest],",
      '  sources: [markdown.source("guide.md")],',
      "  references: [",
      '    file.from("guide-fact.txt").reference("guide fact"),',
      '    nodeTestStatus("guide-test", guideRun, { file: "scripts/guide.test.ts", name: "guide example passes" }),',
      "  ],",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(consumer, "guide-tsconfig.json"),
    JSON.stringify({
      extends: "./tsconfig.json",
      include: ["guide.config.ts", "scripts/guide.test.ts"],
    }),
  );
  const guideTyped = run(bin("tsc"), [
    "-p",
    "guide-tsconfig.json",
    "--pretty",
    "false",
  ]);
  assert.equal(guideTyped.status, 0, guideTyped.stdout + guideTyped.stderr);

  // 1) inspect across all 4 surfaces without executing business tests
  const guideInspectText = run(bin("dock"), [
    "inspect",
    "--config",
    "guide.config.ts",
  ]);
  assert.equal(
    guideInspectText.status,
    0,
    guideInspectText.stdout + guideInspectText.stderr,
  );
  assert.equal(guideInspectText.stderr, "");
  assert.match(guideInspectText.stdout, /Scope: guide-exit-policy/);
  assert.match(
    guideInspectText.stdout,
    /Binding declaration guide-exit-policy: \{"id":"guide-exit-policy","references":\["dock:bind:guide-exit-policy","guide fact","guide-test"\]\}/,
  );
  assert.match(
    guideInspectText.stdout,
    /Binding guide-exit-policy declaration source: guide\.md:3/,
  );
  await assert.rejects(readFile(guideProbeMarker, "utf8"), /ENOENT/);

  const guideInspectStructured = run(bin("dock"), [
    "inspect",
    "--config",
    "guide.config.ts",
    "--output",
    "structured",
  ]);
  assert.equal(
    guideInspectStructured.status,
    0,
    guideInspectStructured.stdout + guideInspectStructured.stderr,
  );
  const guideInspectEnvelope = JSON.parse(guideInspectStructured.stdout) as {
    schemaVersion?: unknown;
    outputMode?: unknown;
    kind?: unknown;
    variant?: unknown;
    data?: {
      resolution?: {
        context: {
          bindings: { id: string; references: string[] }[];
        };
        declarationSources: {
          bindings: Record<string, string[]>;
        };
      };
    };
  };
  assert.equal(guideInspectEnvelope.schemaVersion, "3");
  assert.equal(guideInspectEnvelope.outputMode, "structured");
  assert.equal(guideInspectEnvelope.kind, "data");
  assert.equal(guideInspectEnvelope.variant, "inspected");
  assert.deepEqual(guideInspectEnvelope.data?.resolution?.context.bindings, [
    {
      id: "guide-exit-policy",
      references: ["dock:bind:guide-exit-policy", "guide fact", "guide-test"],
    },
  ]);
  assert.deepEqual(
    guideInspectEnvelope.data?.resolution?.declarationSources.bindings[
      "guide-exit-policy"
    ],
    ["guide.md:3"],
  );
  await assert.rejects(readFile(guideProbeMarker, "utf8"), /ENOENT/);

  await runConsumerJs("verify-guide-inspect.mjs", [
    'import assert from "node:assert/strict";',
    'import { readFile } from "node:fs/promises";',
    'import { inspect } from "@ykdz/dock";',
    'const jsInspected = await inspect("guide.config.ts");',
    "assert.deepEqual(jsInspected.context.bindings, [",
    '  { id: "guide-exit-policy", references: ["dock:bind:guide-exit-policy", "guide fact", "guide-test"] },',
    "]);",
    "assert.deepEqual(",
    '  jsInspected.declarationSources.bindings["guide-exit-policy"],',
    '  ["guide.md:3"],',
    ");",
    `await assert.rejects(readFile(${JSON.stringify(guideProbeMarker)}, "utf8"), /ENOENT/);`,
  ]);

  // Establish initial baseline for guide.md, then introduce fact drift on guide.md prose (so nodeTest keeps passing).
  const guideInitUpdate = run(bin("dock"), [
    "baseline",
    "update",
    "--config",
    "guide.config.ts",
  ]);
  assert.equal(
    guideInitUpdate.status,
    0,
    guideInitUpdate.stdout + guideInitUpdate.stderr,
  );
  assert.equal(guideInitUpdate.stderr, "");
  assert.match(guideInitUpdate.stdout, /Baseline updated\./);

  await writeFile(
    join(consumer, "guide.md"),
    [
      "# New Consumer Guide",
      "",
      '<!-- dock:bind {"id":"guide-exit-policy","with":["guide fact","guide-test"]} -->',
      "",
      "When verification fails, the CLI exits with non-zero status 1.",
      "",
    ].join("\n"),
    "utf8",
  );

  // 2) Fact drift check across all 4 surfaces
  const guideDriftText = run(bin("dock"), [
    "check",
    "--config",
    "guide.config.ts",
  ]);
  assert.equal(
    guideDriftText.status,
    1,
    guideDriftText.stdout + guideDriftText.stderr,
  );
  assert.equal(guideDriftText.stderr, "");
  assert.match(guideDriftText.stdout, /Binding guide-exit-policy/);
  assert.match(
    guideDriftText.stdout,
    /Change: dock:bind:guide-exit-policy fact: before .* after .* \(guide\.md:5\)/,
  );

  const guideDriftStructured = run(bin("dock"), [
    "check",
    "--config",
    "guide.config.ts",
    "--output",
    "structured",
  ]);
  assert.equal(
    guideDriftStructured.status,
    1,
    guideDriftStructured.stdout + guideDriftStructured.stderr,
  );
  const guideDriftReport = readReport(guideDriftStructured.stdout, "changed");
  assert.equal(guideDriftReport.bindings[0]?.bindingId, "guide-exit-policy");

  await runConsumerJs("verify-guide-drift.mjs", [
    'import assert from "node:assert/strict";',
    'import { check } from "@ykdz/dock";',
    'const jsReport = await check("guide.config.ts");',
    'assert.equal(jsReport.bindings[0]?.bindingId, "guide-exit-policy");',
    'assert.equal(jsReport.bindings[0]?.consistency, "inconsistent");',
    "assert.ok(",
    '  jsReport.bindings[0]?.changes?.some((change) => change.kind === "fact" && change.referenceId === "dock:bind:guide-exit-policy"),',
    ");",
  ]);

  // 3) Explicit baseline update across all 4 surfaces (re-introduce second drift to verify both CLI text/structured and JS updateBaseline)
  const guideUpdateText = run(bin("dock"), [
    "baseline",
    "update",
    "--config",
    "guide.config.ts",
  ]);
  assert.equal(
    guideUpdateText.status,
    0,
    guideUpdateText.stdout + guideUpdateText.stderr,
  );
  assert.equal(guideUpdateText.stderr, "");
  assert.match(guideUpdateText.stdout, /Scope: guide-exit-policy/);
  assert.match(guideUpdateText.stdout, /Baseline updated\./);

  await writeFile(
    join(consumer, "guide.md"),
    [
      "# New Consumer Guide",
      "",
      '<!-- dock:bind {"id":"guide-exit-policy","with":["guide fact","guide-test"]} -->',
      "",
      "When verification fails, Dock exits with status 1.",
      "",
    ].join("\n"),
    "utf8",
  );
  const guideUpdateStructured = run(bin("dock"), [
    "baseline",
    "update",
    "--config",
    "guide.config.ts",
    "--output",
    "structured",
  ]);
  assert.equal(
    guideUpdateStructured.status,
    0,
    guideUpdateStructured.stdout + guideUpdateStructured.stderr,
  );
  const guideUpdateReport = readReport(guideUpdateStructured.stdout, "updated");
  assert.equal(guideUpdateReport.bindings[0]?.bindingId, "guide-exit-policy");

  await writeFile(
    join(consumer, "guide.md"),
    [
      "# New Consumer Guide",
      "",
      '<!-- dock:bind {"id":"guide-exit-policy","with":["guide fact","guide-test"]} -->',
      "",
      "When verification fails, Dock always exits with status 1.",
      "",
    ].join("\n"),
    "utf8",
  );
  await runConsumerJs("verify-guide-update.mjs", [
    'import assert from "node:assert/strict";',
    'import { updateBaseline } from "@ykdz/dock";',
    'const jsUpdated = await updateBaseline("guide.config.ts");',
    'assert.equal(jsUpdated.status, "updated");',
    'assert.equal(jsUpdated.report.bindings[0]?.bindingId, "guide-exit-policy");',
  ]);

  // 4) Restored consistency check across all 4 surfaces
  const guideConsistentText = run(bin("dock"), [
    "check",
    "--config",
    "guide.config.ts",
  ]);
  assert.equal(
    guideConsistentText.status,
    0,
    guideConsistentText.stdout + guideConsistentText.stderr,
  );
  assert.equal(guideConsistentText.stderr, "");
  assert.equal(
    guideConsistentText.stdout,
    "Scope: guide-exit-policy\nAll checked bindings are consistent with baseline.\n",
  );

  const guideConsistentStructured = run(bin("dock"), [
    "check",
    "--config",
    "guide.config.ts",
    "--output",
    "structured",
  ]);
  assert.equal(
    guideConsistentStructured.status,
    0,
    guideConsistentStructured.stdout + guideConsistentStructured.stderr,
  );
  const guideConsistentReport = readReport(
    guideConsistentStructured.stdout,
    "consistent",
  );
  assert.equal(
    guideConsistentReport.bindings[0]?.bindingId,
    "guide-exit-policy",
  );

  await runConsumerJs("verify-guide-consistent.mjs", [
    'import assert from "node:assert/strict";',
    'import { check } from "@ykdz/dock";',
    'const jsConsistent = await check("guide.config.ts");',
    'assert.equal(jsConsistent.bindings[0]?.bindingId, "guide-exit-policy");',
    'assert.equal(jsConsistent.bindings[0]?.consistency, "consistent");',
  ]);

  process.stdout.write(
    "README installed package, bootstrap baseline, and broken-example rejection verification passed.\n",
  );
} finally {
  await rm(repository, { recursive: true, force: true });
}

function collectInstalledPackageNames(
  value: unknown,
  names: Set<string> = new Set<string>(),
): Set<string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return names;
  }
  const packageValue = value as { readonly dependencies?: unknown };
  if (
    typeof packageValue.dependencies !== "object" ||
    packageValue.dependencies === null ||
    Array.isArray(packageValue.dependencies)
  ) {
    return names;
  }
  for (const [name, dependency] of Object.entries(packageValue.dependencies)) {
    if (
      typeof dependency === "object" &&
      dependency !== null &&
      !Array.isArray(dependency)
    ) {
      const entry = dependency as {
        readonly version?: unknown;
        readonly missing?: unknown;
        readonly peerMissing?: unknown;
      };
      if (
        typeof entry.version === "string" &&
        entry.version.length > 0 &&
        entry.missing !== true &&
        entry.peerMissing !== true
      ) {
        names.add(name);
      }
    }
    collectInstalledPackageNames(dependency, names);
  }
  return names;
}

async function runConsumerJs(
  filename: string,
  lines: readonly string[],
): Promise<void> {
  const scriptPath = join(consumer, filename);
  await writeFile(scriptPath, `${lines.join("\n")}\n`, "utf8");
  const result = run(process.execPath, [scriptPath]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function readReport(
  output: string,
  variant: string,
  checkEmptyTopLevelErrors = false,
): Report {
  const envelope = JSON.parse(output) as {
    schemaVersion?: unknown;
    outputMode?: unknown;
    kind?: unknown;
    variant?: unknown;
    data?: { errors?: unknown[]; report?: Report };
  };
  assert.equal(envelope.schemaVersion, "3", output);
  assert.equal(envelope.outputMode, "structured", output);
  assert.equal(envelope.kind, "data", output);
  assert.equal(envelope.variant, variant, output);
  if (checkEmptyTopLevelErrors) {
    assert.deepEqual(envelope.data?.errors, [], output);
  }
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
