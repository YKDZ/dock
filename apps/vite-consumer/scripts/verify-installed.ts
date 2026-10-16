import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ProcessResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

type RecordValue = Record<string, unknown>;
type TextRange = {
  readonly path: string;
  readonly start: number;
  readonly end: number;
};
type CheckResult = {
  readonly text: ProcessResult;
  readonly json: ProcessResult;
  readonly report: RecordValue;
};

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const templates = join(repository, "templates");
const integrationPatch = join(
  repository,
  "patches",
  "vite-dock-integration.patch",
);
const viteUrl = "https://github.com/vitejs/vite.git";
const viteCommit = "dce9fe69d37e957b62f3b5df61a761f7f2f949f5";
const expectedPackages = [
  "dock-core-0.0.0.tgz",
  "dock-sdk-0.0.0.tgz",
  "dock-reference-file-0.0.0.tgz",
  "dock-reference-markdown-0.0.0.tgz",
  "dock-reference-vitest-0.0.0.tgz",
] as const;
const docPath = "docs/guide/static-deploy.md";
const testPath = "packages/vite/src/node/__tests__/static-deploy.spec.ts";
const bindingId = "static-local-workflow";
const previewFactId = "static-preview-order";
const testStatusId = "static-deploy-workflow";
const oldPreviewFact =
  "After building the app, you can test it locally by running `npm run preview` command.";
const currentPreviewFact =
  "Once you've built the app, you may test it locally by running `npm run preview` command.";
const driftedPreviewFact =
  "Once you've built the app, you can verify it locally by running `npm run preview` command.";
const checkoutToken = "__VITE_CHECKOUT_ROOT__";

async function main(): Promise<void> {
  const artifactArguments = process.argv.slice(2);
  assert.equal(
    artifactArguments.length,
    expectedPackages.length,
    "正式安装验收必须收到同批 core、SDK、file、Markdown 与 Vitest 制品。",
  );
  const artifacts = artifactArguments.map((argument) =>
    resolve(process.cwd(), argument),
  );
  for (const [index, artifact] of artifacts.entries()) {
    await access(artifact);
    assert.equal(
      basename(artifact),
      expectedPackages[index],
      "正式消费必须使用 check:install 本次生成的完整同批制品。",
    );
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "dock-vite-consumer-"));
  const viteRoot = join(temporaryRoot, "vite");
  await mkdir(viteRoot);
  try {
    process.stdout.write("从固定上游提交重建 Vite 消费者。\n");
    await checkoutVite(viteRoot);
    await installArtifacts(viteRoot, artifacts);
    await applyConsumerAssets(viteRoot);
    await installViteDependencies(viteRoot);
    await buildViteFromSource(viteRoot);
    await runChecked(
      "pnpm",
      ["run", "dock:typecheck"],
      viteRoot,
      "Vite 消费配置与业务测试公开类型检查失败",
    );

    await verifyInstalledMaintenance(viteRoot);
    process.stdout.write(
      "Vite 同批正式制品、真实构建预览、历史基线与 CLI 验收通过。\n",
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function checkoutVite(viteRoot: string): Promise<void> {
  await runChecked(
    "git",
    ["init", "--quiet", "--initial-branch=main", viteRoot],
    repository,
    "初始化 Vite 临时 checkout 失败",
  );
  await runChecked(
    "git",
    ["remote", "add", "origin", viteUrl],
    viteRoot,
    "记录 Vite 固定上游失败",
  );
  await runChecked(
    "git",
    ["fetch", "--depth=1", "origin", viteCommit],
    viteRoot,
    "获取 Vite 固定上游提交失败",
  );
  await runChecked(
    "git",
    ["checkout", "--quiet", "--detach", "FETCH_HEAD"],
    viteRoot,
    "切换 Vite 固定上游提交失败",
  );
  const head = await runChecked(
    "git",
    ["rev-parse", "HEAD"],
    viteRoot,
    "读取 Vite checkout 提交失败",
  );
  assert.equal(head.stdout.trim(), viteCommit);

  const rootManifest = JSON.parse(
    await readFile(join(viteRoot, "package.json"), "utf8"),
  ) as RecordValue;
  const packageManifest = JSON.parse(
    await readFile(join(viteRoot, "packages/vite/package.json"), "utf8"),
  ) as RecordValue;
  assert.equal(rootManifest.name, "@vitejs/vite-monorepo");
  assert.equal(packageManifest.name, "vite");
  assert.equal(packageManifest.version, "8.3.4");
  await assertMissing(join(viteRoot, "packages/vite/dist"));
}

async function installArtifacts(
  viteRoot: string,
  artifacts: readonly string[],
): Promise<void> {
  const destination = join(viteRoot, ".dock-tools");
  await mkdir(destination);
  await Promise.all(
    artifacts.map((artifact) =>
      copyFile(artifact, join(destination, basename(artifact))),
    ),
  );
}

async function applyConsumerAssets(viteRoot: string): Promise<void> {
  await runChecked(
    "git",
    ["apply", integrationPatch],
    viteRoot,
    "应用 Vite 固定接入补丁失败",
  );

  await copyFile(
    join(templates, "dock.config.ts"),
    join(viteRoot, "dock.config.ts"),
  );
  await copyFile(
    join(templates, "tsconfig.dock.json"),
    join(viteRoot, "tsconfig.dock.json"),
  );
  await installHistoricalBaseline(viteRoot);

  const testSource = join(templates, testPath);
  const testDestination = join(viteRoot, testPath);
  await assertMissing(testDestination);
  await mkdir(dirname(testDestination), { recursive: true });
  await copyFile(testSource, testDestination);

  const fixtureSource = join(
    templates,
    "packages/vite/src/node/__tests__/fixtures/dock-static-site",
  );
  const fixtureDestination = join(
    viteRoot,
    "packages/vite/src/node/__tests__/fixtures/dock-static-site",
  );
  await assertMissing(fixtureDestination);
  await cp(fixtureSource, fixtureDestination, { recursive: true });
}

async function installHistoricalBaseline(viteRoot: string): Promise<void> {
  const templatePath = join(templates, "dock.baseline.template.json");
  const template = await readFile(templatePath, "utf8");
  assert.equal(
    [...template.matchAll(new RegExp(checkoutToken, "gu"))].length,
    7,
    "历史模板只能含六个 Markdown 文件位置与一个测试文件位置。",
  );
  const checkoutRoot = resolve(viteRoot);
  const instantiated = template.replaceAll(checkoutToken, checkoutRoot);
  assert.equal(instantiated.includes(checkoutToken), false);
  const baseline = JSON.parse(instantiated) as RecordValue;
  assert.equal(baseline.version, 2);
  const bindings = baseline.bindings;
  assert.ok(isRecord(bindings));
  const binding = bindings[bindingId];
  assert.ok(isRecord(binding));
  const references = binding.references;
  assert.ok(isRecord(references));
  for (const reference of Object.values(references)) {
    assert.ok(isRecord(reference));
    assert.ok(isRecord(reference.definition));
    const target = reference.definition.target;
    assert.ok(isRecord(target));
    const fileInfo = target.fileInfo;
    assert.ok(typeof fileInfo === "string");
    assert.equal(fileInfo.startsWith(checkoutRoot), true);
  }
  await writeFile(join(viteRoot, "dock.baseline.json"), instantiated, "utf8");
}

async function installViteDependencies(viteRoot: string): Promise<void> {
  process.stdout.write("安装 Vite 源码依赖和同批 Dock 制品。\n");
  await runChecked(
    "pnpm",
    ["install", "--no-frozen-lockfile"],
    viteRoot,
    "干净安装 Vite 与同批 Dock 制品失败",
    20 * 60_000,
  );
}

async function buildViteFromSource(viteRoot: string): Promise<void> {
  await assertMissing(join(viteRoot, "packages/vite/dist"));
  process.stdout.write("执行 Vite packages/vite 正式 build 任务。\n");
  await runChecked(
    "pnpm",
    ["--filter", "vite", "run", "build"],
    viteRoot,
    "Vite 上游 packages/vite build 任务失败",
    20 * 60_000,
  );
  await access(join(viteRoot, "packages/vite/dist/node/index.js"));
}

async function verifyInstalledMaintenance(viteRoot: string): Promise<void> {
  const baselinePath = join(viteRoot, "dock.baseline.json");
  const docFile = join(viteRoot, docPath);
  const originalDoc = await readFile(docFile, "utf8");
  const baselineBeforeChecks = await readFile(baselinePath);

  const initial = await runCheckPair(viteRoot);
  assert.equal(
    initial.text.code,
    1,
    `${initial.text.stdout}\n${initial.text.stderr}`,
  );
  assert.equal(
    initial.json.code,
    1,
    `${initial.json.stdout}\n${initial.json.stderr}`,
  );
  assert.equal(
    parseEnvelope(initial.json.stdout).variant,
    "changed",
    initial.json.stdout,
  );
  assertHistoricalBaselineDrift(
    initial.report,
    viteRoot,
    originalDoc,
    currentPreviewFact,
  );
  assert.match(initial.text.stdout, /变化/u);
  assert.ok(initial.text.stdout.includes(oldPreviewFact));
  assert.ok(initial.text.stdout.includes(currentPreviewFact));
  assert.match(initial.text.stdout, /static-local-workflow/u);
  assert.match(
    initial.text.stdout,
    new RegExp(escapeRegExp(resolve(viteRoot, docPath)), "u"),
  );
  assert.match(
    initial.text.stdout,
    new RegExp(escapeRegExp(resolve(viteRoot, testPath)), "u"),
  );
  assert.deepEqual(await readFile(baselinePath), baselineBeforeChecks);

  await verifyHistoricalDrift(
    viteRoot,
    docFile,
    originalDoc,
    baselinePath,
    baselineBeforeChecks,
  );
  await verifyOmittedBuild(viteRoot, baselinePath, baselineBeforeChecks);
  await verifyMissingBuildCommand(
    viteRoot,
    docFile,
    originalDoc,
    baselinePath,
    baselineBeforeChecks,
  );

  const recovered = await runCheckPair(viteRoot);
  assert.equal(recovered.text.code, 1, recovered.text.stdout);
  assert.equal(recovered.json.code, 1, recovered.json.stdout);
  assert.equal(parseEnvelope(recovered.json.stdout).variant, "changed");
  assertHistoricalBaselineDrift(
    recovered.report,
    viteRoot,
    originalDoc,
    currentPreviewFact,
  );
  assert.deepEqual(await readFile(baselinePath), baselineBeforeChecks);

  const updated = await runDock(viteRoot, [
    "baseline",
    "update",
    "--config",
    "dock.config.ts",
    "--json",
  ]);
  assert.equal(updated.code, 0, `${updated.stdout}\n${updated.stderr}`);
  assert.equal(parseEnvelope(updated.stdout).variant, "updated");
  const updatedReport = reportFrom(updated.stdout);
  assertScope(updatedReport);
  const updatedBaseline = JSON.parse(
    await readFile(baselinePath, "utf8"),
  ) as RecordValue;
  assertCurrentHistory(updatedReport, viteRoot, originalDoc);
  assert.equal(JSON.stringify(updatedBaseline).includes(checkoutToken), false);

  const afterUpdate = await runCheckPair(viteRoot);
  assert.equal(afterUpdate.text.code, 0, afterUpdate.text.stdout);
  assert.equal(afterUpdate.json.code, 0, afterUpdate.json.stdout);
  assert.equal(parseEnvelope(afterUpdate.json.stdout).variant, "consistent");
  assertCurrentHistory(afterUpdate.report, viteRoot, originalDoc);
}

async function verifyHistoricalDrift(
  viteRoot: string,
  docFile: string,
  originalDoc: string,
  baselinePath: string,
  baselineBeforeChecks: Buffer,
): Promise<void> {
  const driftedDoc = replaceExactlyOnce(
    originalDoc,
    currentPreviewFact,
    driftedPreviewFact,
  );
  await writeFile(docFile, driftedDoc, "utf8");
  try {
    const result = await runCheckPair(viteRoot);
    assert.equal(result.text.code, 1, result.text.stdout);
    assert.equal(result.json.code, 1, result.json.stderr);
    assert.equal(parseEnvelope(result.json.stdout).variant, "changed");
    assertHistoricalBaselineDrift(
      result.report,
      viteRoot,
      driftedDoc,
      driftedPreviewFact,
    );
    assert.match(result.text.stdout, /变化/u);
    assert.ok(result.text.stdout.includes(oldPreviewFact));
    assert.ok(result.text.stdout.includes(driftedPreviewFact));
    assert.deepEqual(await readFile(baselinePath), baselineBeforeChecks);
  } finally {
    await writeFile(docFile, originalDoc, "utf8");
  }
}

async function verifyOmittedBuild(
  viteRoot: string,
  baselinePath: string,
  baselineBeforeChecks: Buffer,
): Promise<void> {
  const omittedBuild = { DOCK_VITE_OMIT_BUILD: "1" };
  const text = await runDock(
    viteRoot,
    ["check", "--config", "dock.config.ts"],
    omittedBuild,
  );
  const json = await runDock(
    viteRoot,
    ["check", "--config", "dock.config.ts", "--json"],
    omittedBuild,
  );
  const jsonError = assertErrorReport(json, testStatusId);
  assertTextError(text.stdout, testStatusId, jsonError);
  assert.match(jsonError.message, /遗漏构建步骤后预览必须失败/u);
  assert.deepEqual(await readFile(baselinePath), baselineBeforeChecks);

  const updateText = await runDock(
    viteRoot,
    ["baseline", "update", "--config", "dock.config.ts"],
    omittedBuild,
  );
  const updateJson = await runDock(
    viteRoot,
    ["baseline", "update", "--config", "dock.config.ts", "--json"],
    omittedBuild,
  );
  const jsonUpdateError = assertRejectedUpdate(updateJson, testStatusId);
  assertTextError(updateText.stdout, testStatusId, jsonUpdateError);
  assert.deepEqual(await readFile(baselinePath), baselineBeforeChecks);
}

async function verifyMissingBuildCommand(
  viteRoot: string,
  docFile: string,
  originalDoc: string,
  baselinePath: string,
  baselineBeforeChecks: Buffer,
): Promise<void> {
  const invalidDoc = replaceExactlyOnce(
    originalDoc,
    "$ npm run build",
    "$ npm run compile",
  );
  await writeFile(docFile, invalidDoc, "utf8");
  try {
    const text = await runDock(viteRoot, [
      "check",
      "--config",
      "dock.config.ts",
    ]);
    const json = await runDock(viteRoot, [
      "check",
      "--config",
      "dock.config.ts",
      "--json",
    ]);
    const jsonError = assertErrorReport(json, "static-build-command");
    assertTextError(text.stdout, "static-build-command", jsonError);
    assert.equal(jsonError.code, "missing-selection");
    assertCurrentErrorRange(jsonError.range, invalidDoc);
    assert.match(text.stdout, /docs\/guide\/static-deploy\.md/u);
    assert.match(
      text.stdout,
      new RegExp(
        `文本偏移 ${jsonError.range.start}–${jsonError.range.end}`,
        "u",
      ),
    );
    assert.ok(normalized(text.stdout).includes(normalized(jsonError.message)));
    assert.deepEqual(await readFile(baselinePath), baselineBeforeChecks);

    const updateText = await runDock(viteRoot, [
      "baseline",
      "update",
      "--config",
      "dock.config.ts",
    ]);
    const updateJson = await runDock(viteRoot, [
      "baseline",
      "update",
      "--config",
      "dock.config.ts",
      "--json",
    ]);
    const jsonUpdateError = assertRejectedUpdate(
      updateJson,
      "static-build-command",
    );
    assertTextError(updateText.stdout, "static-build-command", jsonUpdateError);
    assert.equal(jsonUpdateError.code, "missing-selection");
    assertCurrentErrorRange(jsonUpdateError.range, invalidDoc);
    assert.match(updateText.stdout, /docs\/guide\/static-deploy\.md/u);
    assert.match(
      updateText.stdout,
      new RegExp(
        `文本偏移 ${jsonUpdateError.range.start}–${jsonUpdateError.range.end}`,
        "u",
      ),
    );
    assert.ok(
      normalized(updateText.stdout).includes(
        normalized(jsonUpdateError.message),
      ),
    );
    assert.deepEqual(await readFile(baselinePath), baselineBeforeChecks);
  } finally {
    await writeFile(docFile, originalDoc, "utf8");
  }
}

async function runCheckPair(viteRoot: string): Promise<CheckResult> {
  const text = await runDock(viteRoot, ["check", "--config", "dock.config.ts"]);
  const json = await runDock(viteRoot, [
    "check",
    "--config",
    "dock.config.ts",
    "--json",
  ]);
  const report = reportFrom(json.stdout);
  assertScope(report);
  return { text, json, report };
}

function assertCurrentHistory(
  report: RecordValue,
  viteRoot: string,
  source: string,
  expectedPreviewFact = currentPreviewFact,
): void {
  const binding = bindingFrom(report);
  assert.ok(isRecord(binding.current));
  assert.ok(isRecord(binding.current.references));
  const references = binding.current.references;
  const preview = references[previewFactId];
  assert.ok(isRecord(preview));
  assert.equal(preview.value, expectedPreviewFact);
  assert.ok(isRecord(preview.range));
  assert.equal(preview.range.path, docPath);
  assert.equal(
    source.slice(preview.range.start as number, preview.range.end as number),
    expectedPreviewFact,
  );
  assert.ok(isRecord(preview.definition));
  assert.ok(isRecord(preview.definition.target));
  assert.equal(preview.definition.target.pluginId, "@dock/reference-markdown");
  assert.equal(preview.definition.target.fileInfo, resolve(viteRoot, docPath));

  const test = references[testStatusId];
  assert.ok(isRecord(test));
  assert.deepEqual(test.value, { status: "passed" });
  assert.ok(isRecord(test.definition));
  assert.ok(isRecord(test.definition.target));
  assert.equal(test.definition.target.pluginId, "@dock/reference-vitest");
  assert.equal(test.definition.target.fileInfo, resolve(viteRoot, testPath));
}

function assertErrorReport(
  result: ProcessResult,
  referenceId: string,
): RecordValue & { readonly code: string; readonly message: string } {
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  const envelope = parseEnvelope(result.stdout);
  assert.equal(envelope.variant, "errors");
  assert.ok(isRecord(envelope.data));
  assert.ok(isRecord(envelope.data.report));
  assertScope(envelope.data.report);
  const failure = findReferenceError(envelope.data.report, referenceId);
  assert.ok(typeof failure.code === "string");
  assert.ok(typeof failure.message === "string");
  return failure as RecordValue & {
    readonly code: string;
    readonly message: string;
  };
}

function assertRejectedUpdate(
  result: ProcessResult,
  referenceId: string,
): RecordValue & { readonly code: string; readonly message: string } {
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  const envelope = parseEnvelope(result.stdout);
  assert.equal(envelope.variant, "rejected");
  assert.ok(isRecord(envelope.data));
  assert.ok(Array.isArray(envelope.data.errors));
  const error = envelope.data.errors.find(
    (item) => isRecord(item) && item.referenceId === referenceId,
  );
  assert.ok(isRecord(error));
  assert.ok(typeof error.code === "string");
  assert.ok(typeof error.message === "string");
  return error as RecordValue & {
    readonly code: string;
    readonly message: string;
  };
}

function assertTextError(
  output: string,
  referenceId: string,
  error: RecordValue,
): void {
  const text = normalized(output);
  assert.equal(text.includes(referenceId), true);
  assert.equal(text.includes(String(error.code)), true);
  assert.equal(text.includes(normalized(String(error.message))), true);
  if (error.range !== undefined) {
    assert.ok(isRecord(error.range));
    const range = error.range;
    assert.ok(typeof range.path === "string");
    assert.ok(typeof range.start === "number");
    assert.ok(typeof range.end === "number");
    assert.equal(
      text.includes(`${range.path}，文本偏移 ${range.start}–${range.end}`),
      true,
    );
  }
}

function assertCurrentErrorRange(
  range: unknown,
  source: string,
): asserts range is TextRange {
  assert.ok(isRecord(range));
  assert.ok(typeof range.path === "string");
  assert.equal(range.path, docPath);
  assert.ok(typeof range.start === "number");
  assert.ok(Number.isInteger(range.start));
  assert.ok(typeof range.end === "number");
  assert.ok(Number.isInteger(range.end));
  assert.ok(range.start < range.end);
  assert.ok(range.end <= source.length);
}

function findReferenceError(
  report: RecordValue,
  referenceId: string,
): RecordValue {
  const binding = bindingFrom(report);
  assert.ok(Array.isArray(binding.errors));
  const error = binding.errors.find(
    (item) => isRecord(item) && item.referenceId === referenceId,
  );
  assert.ok(isRecord(error), `报告未包含引用 ${referenceId} 的错误。`);
  return error;
}

function assertHistoricalBaselineDrift(
  report: RecordValue,
  viteRoot: string,
  source: string,
  currentFact: string,
): void {
  const binding = bindingFrom(report);
  assert.ok(Array.isArray(binding.changes));
  const changes = binding.changes.filter(
    (item) => isRecord(item) && item.referenceId === previewFactId,
  );
  assert.equal(changes.length, 2);
  assert.ok(
    binding.changes.every(
      (item) => isRecord(item) && item.referenceId === previewFactId,
    ),
  );
  assert.ok(
    changes.some(
      (item) => isRecord(item) && item.kind === "reference-definition",
    ),
  );
  const fact = changes.find((item) => isRecord(item) && item.kind === "fact");
  assert.ok(isRecord(fact), `报告未包含 ${previewFactId} 的历史事实变化。`);
  assert.equal(fact.before, oldPreviewFact);
  assert.equal(fact.after, currentFact);
  assertCurrentHistory(report, viteRoot, source, currentFact);
}

function bindingFrom(report: RecordValue): RecordValue {
  assert.ok(Array.isArray(report.bindings));
  const binding = report.bindings.find(
    (item) => isRecord(item) && item.bindingId === bindingId,
  );
  assert.ok(isRecord(binding));
  return binding;
}

function assertScope(report: RecordValue): void {
  assert.deepEqual(report.scope, [bindingId]);
}

function reportFrom(output: string): RecordValue {
  const envelope = parseEnvelope(output);
  assert.ok(isRecord(envelope.data));
  assert.ok(isRecord(envelope.data.report));
  return envelope.data.report;
}

function parseEnvelope(output: string): RecordValue {
  let envelope: unknown;
  try {
    envelope = JSON.parse(output);
  } catch (error) {
    assert.fail(
      `CLI JSON 输出不可解析：${String(error)}\n实际输出：\n${output}`,
    );
  }
  assert.ok(isRecord(envelope));
  return envelope;
}

function replaceExactlyOnce(
  source: string,
  before: string,
  after: string,
): string {
  assert.equal(
    source.split(before).length - 1,
    1,
    `输入必须唯一包含 ${before}`,
  );
  return source.replace(before, after);
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(access(path), { code: "ENOENT" });
}

async function runDock(
  cwd: string,
  arguments_: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<ProcessResult> {
  return await run("pnpm", ["exec", "dock", ...arguments_], cwd, {
    DOCK_VITE_OMIT_BUILD: "0",
    ...env,
  });
}

async function runChecked(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
  label: string,
  timeoutMs = 5 * 60_000,
): Promise<ProcessResult> {
  const result = await run(executable, arguments_, cwd, {}, timeoutMs);
  assert.equal(
    result.code,
    0,
    `${label}：\n${result.stdout}\n${result.stderr}`,
  );
  return result;
}

function run(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 5 * 60_000,
): Promise<ProcessResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(executable, [...arguments_], {
      cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, ...env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      signalProcess(child, "SIGTERM");
      forceKill = setTimeout(() => signalProcess(child, "SIGKILL"), 5_000);
    }, timeoutMs);
    let forceKill: NodeJS.Timeout | undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (forceKill !== undefined) clearTimeout(forceKill);
      rejectResult(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (forceKill !== undefined) clearTimeout(forceKill);
      resolveResult({ code: timedOut ? 124 : (code ?? 1), stdout, stderr });
    });
  });
}

function signalProcess(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  } else {
    child.kill(signal);
  }
}

function appendOutput(current: string, next: string): string {
  const combined = current + next;
  const limit = 250_000;
  return combined.length <= limit
    ? combined
    : `……前序输出已截断……\n${combined.slice(-limit)}`;
}

function normalized(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Vite 正式安装验收失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
