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

  // Mutate a referenced fact (usage section) and verify dock check reports the change and inline prose line.
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
  }

  await writeFile(
    join(consumer, "verify-corrupt-inline-js.mjs"),
    [
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
      "",
    ].join("\n"),
    "utf8",
  );
  const jsCorrupt = run(process.execPath, [
    join(consumer, "verify-corrupt-inline-js.mjs"),
  ]);
  assert.equal(jsCorrupt.status, 0, jsCorrupt.stdout + jsCorrupt.stderr);

  process.stdout.write(
    "README installed package, bootstrap baseline, and broken-example rejection verification passed.\n",
  );
} finally {
  await rm(repository, { recursive: true, force: true });
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
