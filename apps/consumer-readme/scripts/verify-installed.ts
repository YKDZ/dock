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
assert.equal(artifacts.length, 5, "README 自举需要同批五个正式包制品。");
const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const repository = await mkdtemp(join(tmpdir(), "dock-readme-installed-"));
const consumer = join(repository, "apps", "consumer-readme");

try {
  // 沿用工作区消费者的目录布局，配置、测试和基线均原样复制。
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
    "tsconfig.json",
    "scripts/readme.test.ts",
  ]) {
    await copyFile(join(packageDirectory, path), join(consumer, path));
  }
  const typed = run(bin("tsc"), ["-p", "tsconfig.json", "--pretty", "false"]);
  assert.equal(typed.status, 0, typed.stdout + typed.stderr);

  const baselinePath = join(consumer, "dock.baseline.json");
  const baseline = await readFile(baselinePath);
  const checked = run(bin("dock"), [
    "check",
    "--config",
    "dock.config.ts",
    "--json",
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
  assert.ok(nodePlugin, "README JSON 必须保留 Node 插件来源和诊断。");
  const diagnostic = nodePlugin.data as NodeDiagnosticData;
  const nodeRun = diagnostic.runs[0];
  assert.ok(nodeRun, "README JSON 必须包含 Node 运行诊断。");
  assert.equal(nodeRun.identity, "README 示例");
  assert.equal(nodeRun.commandAttempts, 1);
  assert.equal(nodeRun.testExecutions, 1);
  assert.equal(nodeRun.failedCommands, 0);
  assert.ok(nodePlugin.text.length > 0);
  const reads = nodeRun.reads;
  assert.ok(reads && reads.length > 0, "README 验收必须产生原生测试读取证据。");
  for (const read of reads) {
    const identity = JSON.parse(read.testId) as { name?: unknown };
    assert.equal(identity.name, "README 示例完成检查与基线更新");
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
      "--json",
    ]);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    const failure = readReport(failed.stdout, variant);
    assert.deepEqual(failure.pluginErrors, []);
    assert.ok(
      failure.bindings.some((binding) =>
        binding.errors?.some((error) => error.code === "test-failed"),
      ),
      "改错 README 插件后必须报告原生测试失败。",
    );
    assert.deepEqual(await readFile(baselinePath), baseline);
  }

  process.stdout.write(
    "README 正式制品、自举基线及错误示例拒绝更新验收通过。\n",
  );
} finally {
  await rm(repository, { recursive: true, force: true });
}

function readReport(output: string, variant: string): Report {
  const envelope = JSON.parse(output) as {
    variant?: unknown;
    data?: { report?: Report };
  };
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
  assert.equal(result.error, undefined, `执行 ${command} 失败。`);
  return result;
}
