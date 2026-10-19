import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

type ProcessResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

type CliEnvelope = {
  readonly data?: { readonly report?: unknown };
  readonly variant?: string;
};

type RecordValue = Record<string, unknown>;

/** 通过同一批安装制品验证配置 root、模块 URL 和多配置基线隔离。 */
export async function verifyInstalledPaths(consumer: string): Promise<void> {
  const scenario = await mkdtemp(join(consumer, "paths-consumer-"));
  const bin = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "dock.cmd" : "dock",
  );
  try {
    const original = join(scenario, "portable-original");
    const relocated = join(scenario, "nested", "portable-relocated");
    const external = join(scenario, "external.md");
    await mkdir(original);
    await writeFile(external, "项目外的固定文件");
    await writeFile(join(original, "guide.md"), "可随项目迁移的正文");
    await writeFile(
      join(original, "dock.config.mjs"),
      configSource(
        "guide.md",
        "history/baseline.json",
        undefined,
        "guide-policy",
        "guide",
      ),
    );
    const initial = await runDock(
      bin,
      ["baseline", "update", "--config", "dock.config.mjs", "--json"],
      original,
    );
    assert.equal(initial.code, 0, initial.stdout + initial.stderr);
    const savedBaseline = await readFile(
      join(original, "history", "baseline.json"),
    );
    await writeFile(
      join(original, "external.config.mjs"),
      configSource(
        external,
        "history/external.baseline.json",
        undefined,
        "external-policy",
        "external",
      ),
    );
    const externalBaseline = await runDock(
      bin,
      ["baseline", "update", "--config", "external.config.mjs", "--json"],
      original,
    );
    assert.equal(
      externalBaseline.code,
      0,
      externalBaseline.stdout + externalBaseline.stderr,
    );
    await mkdir(join(original, "packages", "library"), { recursive: true });
    await mkdir(join(original, "docs"));
    await writeFile(join(original, "docs", "guide.md"), "同仓库的共享文档");
    await writeFile(
      join(original, "shared.config.mjs"),
      configSource(
        "../../docs/guide.md",
        "../../shared.baseline.json",
        "packages/library",
        "shared-policy",
        "shared-guide",
      ),
    );
    const sharedBaseline = await runDock(
      bin,
      ["baseline", "update", "--config", "shared.config.mjs", "--json"],
      original,
    );
    assert.equal(
      sharedBaseline.code,
      0,
      sharedBaseline.stdout + sharedBaseline.stderr,
    );
    await cp(original, relocated, { recursive: true });
    await rm(original, { recursive: true });
    const externalUnchanged = await runDock(
      bin,
      [
        "check",
        "--config",
        "external.config.mjs",
        "--file",
        external,
        "--json",
      ],
      relocated,
    );
    assert.equal(
      externalUnchanged.code,
      0,
      externalUnchanged.stdout + externalUnchanged.stderr,
    );
    assert.equal(readEnvelope(externalUnchanged.stdout).variant, "consistent");
    const sharedUnchanged = await runDock(
      bin,
      [
        "check",
        "--config",
        "shared.config.mjs",
        "--file",
        "../../docs/guide.md",
        "--json",
      ],
      relocated,
    );
    assert.equal(
      sharedUnchanged.code,
      0,
      sharedUnchanged.stdout + sharedUnchanged.stderr,
    );
    assert.equal(readEnvelope(sharedUnchanged.stdout).variant, "consistent");
    await rename(
      join(relocated, "docs", "guide.md"),
      join(relocated, "docs", "renamed.md"),
    );
    await writeFile(
      join(relocated, "shared.config.mjs"),
      configSource(
        "../../docs/renamed.md",
        "../../shared.baseline.json",
        "packages/library",
        "shared-policy",
        "shared-guide",
      ),
    );
    const sharedHistorical = await runDock(
      bin,
      [
        "check",
        "--config",
        "shared.config.mjs",
        "--file",
        "../../docs/guide.md",
        "--json",
      ],
      relocated,
    );
    assert.equal(
      sharedHistorical.code,
      1,
      sharedHistorical.stdout + sharedHistorical.stderr,
    );
    assert.equal(readEnvelope(sharedHistorical.stdout).variant, "changed");
    assert.deepEqual(readReport(sharedHistorical.stdout).scope, [
      "shared-policy",
    ]);
    const unchanged = await runDock(
      bin,
      ["check", "--config", "dock.config.mjs", "--file", "guide.md", "--json"],
      relocated,
    );
    assert.equal(unchanged.code, 0, unchanged.stdout + unchanged.stderr);
    assert.equal(readEnvelope(unchanged.stdout).variant, "consistent");
    assert.deepEqual(
      await readFile(join(relocated, "history", "baseline.json")),
      savedBaseline,
    );

    await rename(join(relocated, "guide.md"), join(relocated, "renamed.md"));
    await writeFile(
      join(relocated, "dock.config.mjs"),
      configSource(
        "renamed.md",
        "history/baseline.json",
        undefined,
        "guide-policy",
        "guide",
      ),
    );
    const historical = await runDock(
      bin,
      ["check", "--config", "dock.config.mjs", "--file", "guide.md", "--json"],
      relocated,
    );
    assert.equal(historical.code, 1, historical.stdout + historical.stderr);
    assert.equal(readEnvelope(historical.stdout).variant, "changed");
    assert.equal(
      findChangeKind(historical.stdout, "reference-definition"),
      true,
    );
    assert.deepEqual(readReport(historical.stdout).scope, ["guide-policy"]);
    const updated = await runDock(
      bin,
      [
        "baseline",
        "update",
        "--config",
        "dock.config.mjs",
        "--file",
        "guide.md",
        "--json",
      ],
      relocated,
    );
    assert.equal(updated.code, 0, updated.stdout + updated.stderr);
    const accepted = await runDock(
      bin,
      [
        "check",
        "--config",
        "dock.config.mjs",
        "--file",
        "renamed.md",
        "--json",
      ],
      relocated,
    );
    assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
    assert.equal(readEnvelope(accepted.stdout).variant, "consistent");

    for (const [name, alpha, beta] of [
      ["checkout-one", "第一包正文", "第一工具正文"],
      ["checkout-two", "第二包正文", "第二工具正文"],
    ] as const) {
      const checkout = join(scenario, name);
      await createCheckout(checkout, alpha, beta);
      await verifyCheckout(bin, checkout, alpha, beta);
    }
  } finally {
    await rm(scenario, { recursive: true, force: true });
  }
}

async function createCheckout(
  checkout: string,
  alphaContent: string,
  betaContent: string,
): Promise<void> {
  const workspace = join(checkout, "workspace");
  await Promise.all(
    [
      join(checkout, "config"),
      join(workspace, "config"),
      join(workspace, "history"),
      join(workspace, "packages", "alpha"),
      join(workspace, "packages", "beta"),
      join(workspace, "shared"),
      join(workspace, "other-root", "config"),
      join(workspace, "other-root", "packages", "alpha"),
    ].map((path) => mkdir(path, { recursive: true })),
  );
  await Promise.all([
    writeFile(join(workspace, "packages", "alpha", "guide.md"), alphaContent),
    writeFile(join(workspace, "packages", "alpha", "local.md"), "模块邻近正文"),
    writeFile(join(workspace, "packages", "alpha", "copy.md"), alphaContent),
    writeFile(join(workspace, "packages", "beta", "guide.md"), betaContent),
    writeFile(
      join(workspace, "packages", "beta", "local-copy.md"),
      "模块邻近正文",
    ),
    writeFile(
      join(workspace, "packages", "alpha", "dock.config.mjs"),
      packageConfig(),
    ),
    writeFile(
      join(workspace, "packages", "beta", "dock.config.mjs"),
      packageConfig(),
    ),
    writeFile(
      join(workspace, "other-root", "packages", "alpha", "guide.md"),
      "覆盖 root 的普通相对目标",
    ),
    writeFile(
      join(workspace, "config", "default.md"),
      "配置目录默认 root 正文",
    ),
    writeFile(
      join(workspace, "other-root", "config", "default.md"),
      "配置目录默认 root 正文",
    ),
    writeFile(
      join(workspace, "config", "entry.mjs"),
      "throw new Error('root 不能改写配置入口');\n",
    ),
    writeFile(join(workspace, "default-config.mjs"), defaultRootConfig()),
    writeFile(join(checkout, "config", "entry.mjs"), mainConfig()),
    writeFile(
      join(checkout, "config", "independent-one.mjs"),
      configSource(
        "packages/alpha/guide.md",
        "history/one.json",
        "../workspace",
        "shared-policy",
        "shared-reference",
      ),
    ),
    writeFile(
      join(checkout, "config", "independent-two.mjs"),
      configSource(
        "packages/beta/guide.md",
        "history/two.json",
        "../workspace",
        "shared-policy",
        "shared-reference",
      ),
    ),
    writeFile(
      join(checkout, "config", "target-change.mjs"),
      configSource(
        "packages/alpha/guide.md",
        "history/target.json",
        "../workspace",
        "target-policy",
        "target-reference",
      ),
    ),
    writeDeclarations(workspace),
  ]);
}

async function writeDeclarations(workspace: string): Promise<void> {
  await writeFile(
    join(workspace, "shared", "declarations.mjs"),
    [
      'import { file } from "@ykdz/dock-reference-file";',
      'export const guide = file.from("packages/alpha/guide.md").reference("guide", { declaredAt: "declared-before.mjs" });',
      'export const local = file.at(import.meta.url).from("../packages/alpha/local.md").reference("local");',
      'export const url = file.from(new URL("../packages/alpha/local.md", import.meta.url)).reference("url");',
    ].join("\n"),
  );
}

function defaultRootConfig(): string {
  return [
    'import { file } from "@ykdz/dock-reference-file";',
    'import { binding, defineConfig } from "@ykdz/dock";',
    'export default defineConfig({ plugins: [file], bindings: [binding("default-root-policy", [file.from("config/default.md").reference("default-root-reference")])] });',
  ].join("\n");
}

function packageConfig(): string {
  return configSource(
    "guide.md",
    undefined,
    undefined,
    "package-policy",
    "package-guide",
  );
}

function mainConfig(): string {
  return [
    'import { file } from "@ykdz/dock-reference-file";',
    'import { binding, defineConfig } from "@ykdz/dock";',
    'import { guide, local, url } from "../workspace/shared/declarations.mjs";',
    'export default defineConfig({ plugins: [file], root: "../workspace", baseline: "history/primary.json", bindings: [binding("documents", [guide, local, url])] });',
  ].join("\n");
}

function configSource(
  target: string,
  baseline: string | undefined,
  root: string | undefined,
  bindingId: string,
  referenceId: string,
  includeBinding = true,
): string {
  const binding = includeBinding
    ? `[binding(${JSON.stringify(bindingId)}, [file.from(${JSON.stringify(target)}).reference(${JSON.stringify(referenceId)})])]`
    : "[]";
  return [
    'import { file } from "@ykdz/dock-reference-file";',
    'import { binding, defineConfig } from "@ykdz/dock";',
    `export default defineConfig({ plugins: [file],${root === undefined ? "" : ` root: ${JSON.stringify(root)},`}${baseline === undefined ? "" : ` baseline: ${JSON.stringify(baseline)},`} bindings: ${binding} });`,
  ].join("\n");
}

async function verifyCheckout(
  bin: string,
  checkout: string,
  alphaContent: string,
  betaContent: string,
): Promise<void> {
  const workspace = join(checkout, "workspace");
  const firstCheck = await runDock(
    bin,
    ["check", "--config", "config/entry.mjs", "--json"],
    checkout,
  );
  assert.equal(firstCheck.code, 1, firstCheck.stderr);
  assert.equal(readEnvelope(firstCheck.stdout).variant, "changed");
  assertSelectedValue(
    firstCheck.stdout,
    alphaContent,
    "packages/alpha/guide.md",
    "documents",
    "guide",
  );
  assertSelectedValue(
    firstCheck.stdout,
    "模块邻近正文",
    "packages/alpha/local.md",
    "documents",
    "local",
  );
  assertSelectedValue(
    firstCheck.stdout,
    "模块邻近正文",
    "packages/alpha/local.md",
    "documents",
    "url",
  );

  const update = await runDock(
    bin,
    ["baseline", "update", "--config", "config/entry.mjs", "--json"],
    checkout,
  );
  assert.equal(update.code, 0, update.stderr);
  const primaryBaselinePath = join(workspace, "history", "primary.json");
  const primaryBaseline = await readFile(primaryBaselinePath);

  const nestedCwd = join(workspace, "packages", "beta");
  const unchanged = await runDock(
    bin,
    ["check", "--config", "../../../config/entry.mjs", "--json"],
    nestedCwd,
  );
  assert.equal(unchanged.code, 0, unchanged.stderr);
  assert.equal(readEnvelope(unchanged.stdout).variant, "consistent");
  assert.deepEqual(await readFile(primaryBaselinePath), primaryBaseline);

  await verifyRootSwitchPathBases(bin, checkout);
  await verifyDefaultRoot(bin, checkout, workspace);
  await verifyPackageConfigs(
    bin,
    checkout,
    workspace,
    alphaContent,
    betaContent,
  );
  await verifyIndependentConfigs(bin, checkout, workspace, betaContent);
  await verifyChangedTarget(bin, checkout, workspace, alphaContent);
  await verifyMaintainedModuleMove(
    bin,
    checkout,
    workspace,
    primaryBaselinePath,
  );
  await verifyChangedBoundTarget(bin, checkout);
  await verifyFailedUpdateKeepsBaseline(
    bin,
    checkout,
    workspace,
    primaryBaselinePath,
  );
}

async function verifyRootSwitchPathBases(
  bin: string,
  checkout: string,
): Promise<void> {
  const configPath = join(checkout, "config", "entry.mjs");
  await writeFile(
    configPath,
    mainConfig()
      .replace('root: "../workspace"', 'root: "../workspace/other-root"')
      .replace(
        'baseline: "history/primary.json"',
        'baseline: "history/root-switch.json"',
      ),
  );
  const movedRoot = await runDock(
    bin,
    ["check", "--config", configPath, "--json"],
    checkout,
  );
  assert.equal(movedRoot.code, 1, movedRoot.stderr);
  assertSelectedValue(
    movedRoot.stdout,
    "覆盖 root 的普通相对目标",
    "packages/alpha/guide.md",
    "documents",
    "guide",
  );
  assertSelectedValue(
    movedRoot.stdout,
    "模块邻近正文",
    "../packages/alpha/local.md",
    "documents",
    "local",
  );
  await writeFile(configPath, mainConfig());
}

async function verifyDefaultRoot(
  bin: string,
  checkout: string,
  workspace: string,
): Promise<void> {
  const configPath = "workspace/default-config.mjs";
  const initial = await runDock(
    bin,
    ["check", "--config", configPath, "--json"],
    checkout,
  );
  assert.equal(initial.code, 1, initial.stderr);
  assertSelectedValue(
    initial.stdout,
    "配置目录默认 root 正文",
    "config/default.md",
    "default-root-policy",
    "default-root-reference",
  );
  const update = await runDock(
    bin,
    ["baseline", "update", "--config", configPath, "--json"],
    checkout,
  );
  assert.equal(update.code, 0, update.stderr);
  const oldBaselinePath = join(workspace, "dock.baseline.json");
  const oldBaseline = await readFile(oldBaselinePath);
  const movedRootConfig = join(workspace, "default-config.mjs");
  await writeFile(
    movedRootConfig,
    defaultRootConfig().replace(
      "plugins: [file], bindings:",
      'plugins: [file], root: "other-root", bindings:',
    ),
  );
  const movedRootCheck = await runDock(
    bin,
    ["check", "--config", movedRootConfig, "--json"],
    checkout,
  );
  assert.equal(movedRootCheck.code, 1, movedRootCheck.stderr);
  assert.equal(readEnvelope(movedRootCheck.stdout).variant, "changed");
  assertSelectedValue(
    movedRootCheck.stdout,
    "配置目录默认 root 正文",
    "config/default.md",
    "default-root-policy",
    "default-root-reference",
  );
  const movedRootUpdate = await runDock(
    bin,
    ["baseline", "update", "--config", movedRootConfig, "--json"],
    checkout,
  );
  assert.equal(movedRootUpdate.code, 0, movedRootUpdate.stderr);
  await readFile(join(workspace, "other-root", "dock.baseline.json"));
  assert.deepEqual(await readFile(oldBaselinePath), oldBaseline);
}

async function verifyPackageConfigs(
  bin: string,
  checkout: string,
  workspace: string,
  alphaContent: string,
  betaContent: string,
): Promise<void> {
  const alphaConfig = "workspace/packages/alpha/dock.config.mjs";
  const alphaCheck = await runDock(
    bin,
    ["check", "--config", alphaConfig, "--json"],
    checkout,
  );
  assert.equal(alphaCheck.code, 1, alphaCheck.stderr);
  assertSelectedValue(
    alphaCheck.stdout,
    alphaContent,
    "guide.md",
    "package-policy",
    "package-guide",
  );
  const alphaUpdate = await runDock(
    bin,
    ["baseline", "update", "--config", alphaConfig, "--json"],
    checkout,
  );
  assert.equal(alphaUpdate.code, 0, alphaUpdate.stderr);
  await readFile(join(workspace, "packages", "alpha", "dock.baseline.json"));

  const fromBetaCwd = await runDock(
    bin,
    ["check", "--config", "../alpha/dock.config.mjs", "--json"],
    join(workspace, "packages", "beta"),
  );
  assert.equal(fromBetaCwd.code, 0, fromBetaCwd.stderr);
  assert.equal(readEnvelope(fromBetaCwd.stdout).variant, "consistent");

  const betaConfig = "workspace/packages/beta/dock.config.mjs";
  const betaCheck = await runDock(
    bin,
    ["check", "--config", betaConfig, "--json"],
    checkout,
  );
  assert.equal(betaCheck.code, 1, betaCheck.stderr);
  assertSelectedValue(
    betaCheck.stdout,
    betaContent,
    "guide.md",
    "package-policy",
    "package-guide",
  );
  const betaUpdate = await runDock(
    bin,
    ["baseline", "update", "--config", betaConfig, "--json"],
    checkout,
  );
  assert.equal(betaUpdate.code, 0, betaUpdate.stderr);
  await readFile(join(workspace, "packages", "beta", "dock.baseline.json"));
}

async function verifyIndependentConfigs(
  bin: string,
  checkout: string,
  workspace: string,
  betaContent: string,
): Promise<void> {
  for (const name of ["independent-one.mjs", "independent-two.mjs"]) {
    const update = await runDock(
      bin,
      ["baseline", "update", "--config", `config/${name}`, "--json"],
      checkout,
    );
    assert.equal(update.code, 0, update.stderr);
  }
  const secondBaseline = join(workspace, "history", "two.json");
  const secondBytes = await readFile(secondBaseline);
  const second = await runDock(
    bin,
    ["check", "--config", "config/independent-two.mjs", "--json"],
    checkout,
  );
  assert.equal(second.code, 0, second.stderr);
  assert.equal(readEnvelope(second.stdout).variant, "consistent");
  assertSelectedValue(
    second.stdout,
    betaContent,
    "packages/beta/guide.md",
    "shared-policy",
    "shared-reference",
  );

  await writeFile(
    join(checkout, "config", "independent-one.mjs"),
    configSource(
      "packages/alpha/guide.md",
      "history/one.json",
      "../workspace",
      "shared-policy",
      "shared-reference",
      false,
    ),
  );
  const removed = await runDock(
    bin,
    ["check", "--config", "config/independent-one.mjs", "--json"],
    checkout,
  );
  assert.equal(removed.code, 1, removed.stderr);
  assert.equal(readEnvelope(removed.stdout).variant, "changed");
  const other = await runDock(
    bin,
    ["check", "--config", "config/independent-two.mjs", "--json"],
    checkout,
  );
  assert.equal(other.code, 0, other.stderr);
  assert.equal(readEnvelope(other.stdout).variant, "consistent");
  assert.deepEqual(await readFile(secondBaseline), secondBytes);
}

async function verifyChangedTarget(
  bin: string,
  checkout: string,
  workspace: string,
  content: string,
): Promise<void> {
  await writeFile(
    join(workspace, "packages", "alpha", "same-content.md"),
    content,
  );
  const configPath = join(checkout, "config", "target-change.mjs");
  const update = await runDock(
    bin,
    ["baseline", "update", "--config", configPath, "--json"],
    checkout,
  );
  assert.equal(update.code, 0, update.stderr);
  await writeFile(
    configPath,
    configSource(
      "packages/alpha/same-content.md",
      "history/target.json",
      "../workspace",
      "target-policy",
      "target-reference",
    ),
  );
  const changed = await runDock(
    bin,
    ["check", "--config", configPath, "--json"],
    checkout,
  );
  assert.equal(changed.code, 1, changed.stderr);
  assert.equal(readEnvelope(changed.stdout).variant, "changed");
  assert.equal(findChangeKind(changed.stdout, "reference-definition"), true);
}

async function verifyMaintainedModuleMove(
  bin: string,
  checkout: string,
  workspace: string,
  primaryBaselinePath: string,
): Promise<void> {
  const baselineBefore = await readFile(primaryBaselinePath);
  const movedDirectory = join(workspace, "new", "deep");
  await mkdir(movedDirectory, { recursive: true });
  await writeFile(
    join(movedDirectory, "declarations.mjs"),
    [
      'import { file } from "@ykdz/dock-reference-file";',
      'export const guide = file.from("packages/alpha/guide.md").reference("guide", { declaredAt: "declared-after.mjs" });',
      'export const local = file.at(import.meta.url).from("../../packages/alpha/local.md").reference("local");',
      'export const url = file.from(new URL("../../packages/alpha/local.md", import.meta.url)).reference("url");',
    ].join("\n"),
  );
  await writeFile(
    join(checkout, "config", "entry.mjs"),
    mainConfig().replace(
      "../workspace/shared/declarations.mjs",
      "../workspace/new/deep/declarations.mjs",
    ),
  );
  const unchanged = await runDock(
    bin,
    ["check", "--config", "config/entry.mjs", "--json"],
    checkout,
  );
  assert.equal(unchanged.code, 0, unchanged.stderr);
  assert.equal(readEnvelope(unchanged.stdout).variant, "consistent");
  assert.deepEqual(await readFile(primaryBaselinePath), baselineBefore);
}

async function verifyChangedBoundTarget(
  bin: string,
  checkout: string,
): Promise<void> {
  const declarations = join(
    checkout,
    "workspace",
    "new",
    "deep",
    "declarations.mjs",
  );
  const content = await readFile(declarations, "utf8");
  await writeFile(
    declarations,
    content.replace(
      "../../packages/alpha/local.md",
      "../../packages/beta/local-copy.md",
    ),
  );
  const changed = await runDock(
    bin,
    ["check", "--config", "config/entry.mjs", "--json"],
    checkout,
  );
  assert.equal(changed.code, 1, changed.stderr);
  assert.equal(readEnvelope(changed.stdout).variant, "changed");
  assert.equal(findChangeKind(changed.stdout, "reference-definition"), true);
}

async function verifyFailedUpdateKeepsBaseline(
  bin: string,
  checkout: string,
  workspace: string,
  baselinePath: string,
): Promise<void> {
  const savedBaseline = await readFile(baselinePath);
  const target = join(workspace, "packages", "alpha", "guide.md");
  const savedTarget = await readFile(target);
  await rm(target);
  const failed = await runDock(
    bin,
    ["baseline", "update", "--config", "config/entry.mjs", "--json"],
    checkout,
  );
  assert.equal(failed.code, 1, failed.stderr);
  assert.equal(readEnvelope(failed.stdout).variant, "rejected");
  assert.deepEqual(await readFile(baselinePath), savedBaseline);
  await writeFile(target, savedTarget);
}

function assertSelectedValue(
  output: string,
  value: string,
  path: string,
  bindingId: string,
  referenceId: string,
): void {
  const report = readReport(output);
  assert.ok(Array.isArray(report.bindings));
  const binding = report.bindings.find(
    (candidate) => isRecord(candidate) && candidate.bindingId === bindingId,
  );
  assert.ok(isRecord(binding));
  assert.ok(isRecord(binding.current));
  assert.ok(isRecord(binding.current.references));
  const reference = binding.current.references[referenceId];
  assert.ok(isRecord(reference));
  assert.equal(reference.value, value);
  assert.ok(isRecord(reference.range));
  assert.equal(reference.range.path, path);
}

function findChangeKind(output: string, kind: string): boolean {
  const report = readReport(output);
  return (
    Array.isArray(report.bindings) &&
    report.bindings.some(
      (binding) =>
        isRecord(binding) &&
        Array.isArray(binding.changes) &&
        binding.changes.some(
          (change) => isRecord(change) && change.kind === kind,
        ),
    )
  );
}

function readEnvelope(output: string): CliEnvelope {
  return JSON.parse(output) as CliEnvelope;
}

function readReport(output: string): RecordValue {
  const report = readEnvelope(output).data?.report;
  assert.ok(isRecord(report));
  return report;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runDock(
  bin: string,
  args: readonly string[],
  cwd: string,
): Promise<ProcessResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(bin, args, { cwd });
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
