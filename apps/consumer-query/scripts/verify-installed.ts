import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
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
type MaintenanceResult = {
  readonly text: ProcessResult;
  readonly json: ProcessResult;
  readonly report: RecordValue;
};

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const templates = join(repository, "templates");
const integrationPatch = join(
  repository,
  "patches",
  "query-dock-integration.patch",
);
const upstreamUrl = "https://github.com/TanStack/query.git";
const upstreamCommit = "0fbbc6213641ef2d7cec7d4bfd2f1044c561dde8";
const expectedArtifacts = [
  "dock-core-0.0.0.tgz",
  "dock-sdk-0.0.0.tgz",
  "dock-reference-file-0.0.0.tgz",
  "dock-reference-markdown-0.0.0.tgz",
  "dock-reference-typescript-0.0.0.tgz",
  "dock-reference-vitest-0.0.0.tgz",
] as const;
const checkoutToken = "__QUERY_CHECKOUT_ROOT__";
const docPath = "docs/framework/react/reference/functions/keepPreviousData.md";
const sourcePath = "packages/query-core/src/utils.ts";
const testPath = "packages/query-core/src/__tests__/utils.test.tsx";
const observationId = "@observation:keep-case:result";
const bindingIds = ["keep-status", "keep-observation", "keep-source"];
const bindingNotes = {
  "keep-status": "只比较原生测试状态；不能发现实现与测试预期同步改变后仍通过。",
  "keep-observation":
    "样例对象的实际返回值和对象身份；不证明所有泛型输入或 UI 行为。",
  "keep-source": "函数完整符号源码；正常重构也需审阅，不推断语义等价。",
};
const oldObservation = {
  returned: { a: 1, b: 2 },
  sameReference: true,
};
const changedObservation = {
  returned: { a: 3, b: 2 },
  sameReference: true,
};
const historicalQuote = "The previous data is returned unchanged.";
const currentQuote = "The previous data, unchanged.";
const historicalFunction =
  "export function keepPreviousData<T>(\n  previousData: T | undefined,\n): T | undefined {\n  return previousData\n}";
const historicalExecutionSelection = {
  execution: {
    command: "pnpm",
    args: [
      "exec",
      "nx",
      "run",
      "@tanstack/query-core:test:lib",
      "--skip-nx-cache",
      "--",
      "--run",
    ],
    env: {},
    timeoutMs: 30_000,
    evidenceRoot: "packages/query-core",
    forwardedArguments: "posix-shell",
  },
  prerequisites: [],
};
const implementationDrift = `export function keepPreviousData<T>(
  previousData: T | undefined,
): T | undefined {
  if (
    previousData !== undefined &&
    typeof previousData === 'object' &&
    previousData !== null &&
    'a' in previousData
  ) {
    Object.assign(previousData, { a: 3 })
  }
  return previousData
}`;

async function main(): Promise<void> {
  const artifactArguments = process.argv.slice(2);
  assert.equal(
    artifactArguments.length,
    expectedArtifacts.length,
    "正式安装验收必须收到同批 core、SDK、file、Markdown、TypeScript 与 Vitest 制品。",
  );
  const artifacts = artifactArguments.map((argument) =>
    resolve(process.cwd(), argument),
  );
  for (const [index, artifact] of artifacts.entries()) {
    await access(artifact);
    assert.equal(
      basename(artifact),
      expectedArtifacts[index],
      "Query 消费者必须使用 check:install 本次生成的正式制品。",
    );
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "dock-query-consumer-"));
  const queryRoot = join(temporaryRoot, "query");
  await mkdir(queryRoot);
  try {
    process.stdout.write("从固定上游提交重建 Query 消费者。\n");
    await checkoutQuery(queryRoot);
    const history = await applyConsumerAssets(queryRoot);
    await installDependencies(queryRoot);
    await buildQueryCore(queryRoot);
    await runChecked(
      "pnpm",
      ["run", "dock:typecheck"],
      queryRoot,
      "Query 配置和原生业务测试的正式类型检查失败",
    );

    await verifyConvertedHistoryDrift(queryRoot, history);
    const originalInputs = await readOriginalInputs(history);
    try {
      await verifyDirectValidUpdate(queryRoot, history);
      await verifyNormalMaintenance(queryRoot, history);
      await verifyInputOnlyDrift(queryRoot, history, originalInputs);
      await verifySelectionDefinitionDrift(queryRoot, history);
      await verifyImplementationDrift(queryRoot, history, originalInputs);
      await verifyInvalidReferenceAndRejectedUpdate(
        queryRoot,
        history,
        originalInputs,
      );
    } finally {
      await restoreInputs(history, originalInputs);
    }

    const finalText = await run("pnpm", ["run", "dock:check"], queryRoot);
    assert.equal(finalText.code, 0, `${finalText.stdout}\n${finalText.stderr}`);
    for (const bindingId of bindingIds) {
      assert.equal(finalText.stdout.includes(bindingId), true);
    }
    assert.equal(finalText.stdout.includes("与基线一致"), true);
    const final = await runCheckPair(queryRoot, 0, "consistent");
    assertConsistent(final.report);
    assertExecution(final.report);
    assert.deepEqual(await readFile(history.baselinePath), history.baseline);
    process.stdout.write(
      "Query 同批正式制品、历史转换、三关联共享执行和基线往返验收通过。\n",
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

type ConsumerHistory = {
  readonly baselinePath: string;
  readonly originalTest: string;
  baseline: Buffer;
  readonly testPath: string;
  readonly docPath: string;
  readonly sourcePath: string;
  readonly sidecarPath: string;
};

type OriginalInputs = {
  readonly test: string;
  readonly doc: string;
  readonly source: string;
  readonly sidecar: string;
};

async function checkoutQuery(queryRoot: string): Promise<void> {
  await runChecked(
    "git",
    ["init", "--quiet", "--initial-branch=main", queryRoot],
    repository,
    "初始化 Query 临时 checkout 失败",
  );
  await runChecked(
    "git",
    ["remote", "add", "origin", upstreamUrl],
    queryRoot,
    "记录 Query 固定上游失败",
  );
  await runChecked(
    "git",
    ["fetch", "--depth=1", "origin", upstreamCommit],
    queryRoot,
    "获取 Query 固定上游提交失败",
    20 * 60_000,
  );
  await runChecked(
    "git",
    ["checkout", "--quiet", "--detach", "FETCH_HEAD"],
    queryRoot,
    "切换 Query 固定上游提交失败",
  );
  const head = await runChecked(
    "git",
    ["rev-parse", "HEAD"],
    queryRoot,
    "读取 Query checkout 提交失败",
  );
  assert.equal(head.stdout.trim(), upstreamCommit);

  const rootManifest = JSON.parse(
    await readFile(join(queryRoot, "package.json"), "utf8"),
  ) as RecordValue;
  const packageManifest = JSON.parse(
    await readFile(join(queryRoot, "packages/query-core/package.json"), "utf8"),
  ) as RecordValue;
  assert.equal(rootManifest.name, "root");
  assert.ok(isRecord(packageManifest));
  assert.equal(packageManifest.name, "@tanstack/query-core");
  assert.equal(packageManifest.version, "5.104.2");
  await assertMissing(join(queryRoot, "node_modules"));
  await assertMissing(join(queryRoot, ".dock-tools"));
  await assertMissing(join(queryRoot, "packages/query-core/build"));
}

async function applyConsumerAssets(
  queryRoot: string,
): Promise<ConsumerHistory> {
  const dockConfig = join(templates, "dock.config.ts");
  const dockTypeConfig = join(templates, "tsconfig.dock.json");
  await runChecked(
    "git",
    ["apply", integrationPatch],
    queryRoot,
    "应用 Query 最小正式接入补丁失败",
  );

  await mkdir(join(queryRoot, ".dock-tools"));
  const artifactArguments = process.argv
    .slice(2)
    .map((argument) => resolve(process.cwd(), argument));
  await Promise.all(
    artifactArguments.map((artifact) =>
      copyFile(artifact, join(queryRoot, ".dock-tools", basename(artifact))),
    ),
  );
  await copyFile(dockConfig, join(queryRoot, "dock.config.ts"));
  await copyFile(dockTypeConfig, join(queryRoot, "tsconfig.dock.json"));

  const sidecarPath =
    "docs/framework/react/reference/functions/keepPreviousData.dock.ts";
  const evidencePath = "packages/query-core/src/__tests__/keep.evidence.ts";
  const projectionPath =
    "packages/query-core/src/__tests__/keep.projections.ts";
  for (const relativePath of [sidecarPath, evidencePath, projectionPath]) {
    const source = join(templates, relativePath);
    const destination = join(queryRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }

  const testAbsolutePath = join(queryRoot, testPath);
  const originalTest = await readFile(testAbsolutePath, "utf8");
  const baselinePath = join(queryRoot, "dock.baseline.json");
  await installHistoricalBaseline(queryRoot, baselinePath);
  return {
    baselinePath,
    originalTest,
    baseline: await readFile(baselinePath),
    testPath: testAbsolutePath,
    docPath: join(queryRoot, docPath),
    sourcePath: join(queryRoot, sourcePath),
    sidecarPath: join(queryRoot, sidecarPath),
  };
}

async function installHistoricalBaseline(
  queryRoot: string,
  baselinePath: string,
): Promise<void> {
  const templatePath = join(templates, "dock.baseline.template.json");
  const template = await readFile(templatePath, "utf8");
  assert.equal(
    [...template.matchAll(new RegExp(checkoutToken, "gu"))].length,
    7,
    "历史模板必须将三个旧目标路径映射到七处已转换的历史引用。",
  );
  const instantiated = template.replaceAll(checkoutToken, resolve(queryRoot));
  assert.equal(instantiated.includes(checkoutToken), false);
  const baseline: unknown = JSON.parse(instantiated);
  assertHistoricalFacts(baseline, queryRoot);
  await writeFile(baselinePath, instantiated, "utf8");
}

function assertHistoricalFacts(value: unknown, queryRoot: string): void {
  assert.ok(isRecord(value));
  assert.equal(value.version, 2);
  assert.ok(isRecord(value.bindings));
  assert.deepEqual(
    Object.keys(value.bindings).sort(compareStrings),
    [...bindingIds].sort(compareStrings),
  );
  const references = new Map<string, RecordValue>();
  for (const [bindingId, bindingValue] of Object.entries(value.bindings)) {
    assert.ok(isRecord(bindingValue));
    assert.ok(isRecord(bindingValue.definition));
    assert.equal(bindingValue.definition.id, bindingId);
    assert.deepEqual(
      Object.keys(bindingValue.definition).sort(compareStrings),
      ["id", "note", "references"].sort(compareStrings),
    );
    assert.equal(
      bindingValue.definition.note,
      bindingNotes[bindingId as keyof typeof bindingNotes],
    );
    assert.ok(Array.isArray(bindingValue.definition.references));
    const expectedReferences: Record<string, readonly string[]> = {
      "keep-status": ["keep-case", "keep-return-doc"],
      "keep-observation": [observationId, "keep-case", "keep-return-doc"],
      "keep-source": ["keep-function", "keep-return-doc"],
    };
    assert.deepEqual(
      [...bindingValue.definition.references].sort(compareStrings),
      [...(expectedReferences[bindingId] ?? [])].sort(compareStrings),
    );
    assert.ok(isRecord(bindingValue.references));
    assert.deepEqual(
      Object.keys(bindingValue.references).sort(compareStrings),
      [...(expectedReferences[bindingId] ?? [])].sort(compareStrings),
    );
    for (const [referenceId, referenceValue] of Object.entries(
      bindingValue.references,
    )) {
      assert.ok(isRecord(referenceValue));
      assert.ok(isRecord(referenceValue.definition));
      assert.equal(referenceValue.definition.id, referenceId);
      const existing = references.get(referenceId);
      if (existing === undefined) {
        references.set(referenceId, referenceValue);
      } else {
        assert.deepEqual(referenceValue, existing);
      }
    }
  }
  assert.deepEqual(
    [...references.keys()].sort(compareStrings),
    [
      "@observation:keep-case:result",
      "keep-case",
      "keep-function",
      "keep-return-doc",
    ].sort(),
  );
  assert.deepEqual(referenceValue(references, "keep-case"), {
    status: "passed",
  });
  assert.deepEqual(
    referenceValue(references, "@observation:keep-case:result"),
    {
      returned: { a: 1, b: 2 },
      sameReference: true,
    },
  );
  assert.equal(referenceValue(references, "keep-return-doc"), historicalQuote);
  assert.equal(referenceValue(references, "keep-function"), historicalFunction);
  const historicalDocument = references.get("keep-return-doc");
  assert.ok(historicalDocument);
  assert.ok(isRecord(historicalDocument.definition));
  assert.deepEqual(historicalDocument.definition.selection, {
    kind: "markdown",
    steps: [
      { kind: "section", heading: "Returns" },
      { kind: "quote", text: historicalQuote },
    ],
  });
  for (const referenceId of ["keep-case", observationId]) {
    const reference = references.get(referenceId);
    assert.ok(reference);
    assert.ok(isRecord(reference.definition));
    assert.ok(isRecord(reference.definition.target));
    assert.ok(isRecord(reference.definition.target.target));
    assert.deepEqual(
      reference.definition.target.target.historicalSelection,
      historicalExecutionSelection,
      `旧运行选择 ${referenceId} 必须作为 opaque 历史定义保留。`,
    );
  }

  for (const [referenceId, relativePath] of [
    ["keep-return-doc", docPath],
    ["keep-case", testPath],
    ["@observation:keep-case:result", testPath],
    ["keep-function", sourcePath],
  ] as const) {
    const reference = references.get(referenceId);
    assert.ok(reference);
    const definition = reference.definition;
    assert.ok(isRecord(definition));
    assert.ok(isRecord(definition.target));
    assert.equal(
      definition.target.fileInfo,
      resolve(queryRoot, relativePath),
      `旧目标 ${referenceId} 必须映射到固定 Query checkout。`,
    );
  }
}

function referenceValue(
  references: Map<string, RecordValue>,
  id: string,
): unknown {
  const reference = references.get(id);
  assert.ok(reference, `历史基线缺少引用 ${id}。`);
  return reference.value;
}

async function installDependencies(queryRoot: string): Promise<void> {
  process.stdout.write("在全新 Query checkout 安装源码依赖和同批正式制品。\n");
  await runChecked(
    "pnpm",
    ["install", "--no-frozen-lockfile"],
    queryRoot,
    "干净安装 Query 与同批 Dock 正式制品失败",
    20 * 60_000,
  );
}

async function buildQueryCore(queryRoot: string): Promise<void> {
  await assertMissing(join(queryRoot, "packages/query-core/build"));
  process.stdout.write("执行 Query query-core 正式源码 build。\n");
  await runChecked(
    "pnpm",
    ["--filter", "@tanstack/query-core", "run", "build"],
    queryRoot,
    "Query query-core 源码构建失败",
    20 * 60_000,
  );
  await access(join(queryRoot, "packages/query-core/build/modern/index.js"));
}

async function verifyConvertedHistoryDrift(
  queryRoot: string,
  history: ConsumerHistory,
): Promise<void> {
  const text = await run("pnpm", ["run", "dock:check"], queryRoot);
  assert.equal(text.code, 1, `${text.stdout}\n${text.stderr}`);
  assert.equal(text.stdout.includes("keep-observation"), true);
  assert.equal(text.stdout.includes("keep-status"), true);
  assert.equal(text.stdout.includes("keep-source"), true);
  assert.ok(text.stdout.includes(historicalQuote), text.stdout);
  assert.equal(text.stdout.includes(currentQuote), true);
  assert.equal(
    normalized(text.stdout).includes("执行：1 次测试尝试，1 次命令尝试"),
    true,
    `${text.stdout}\n${text.stderr}`,
  );
  const json = await runDock(queryRoot, [
    "check",
    "--config",
    "dock.config.ts",
    "--json",
  ]);
  assert.equal(json.code, 1, `${json.stdout}\n${json.stderr}`);
  const envelope = parseEnvelope(json.stdout);
  assert.equal(envelope.variant, "changed");
  assert.ok(isRecord(envelope.data));
  const report = reportValue(envelope.data);
  assertScope(report);
  assertExecution(report);
  assertHistoricalDocumentDrift(report);
  assert.deepEqual(await readFile(history.baselinePath), history.baseline);
  await writeFile(history.testPath, history.originalTest, "utf8");
}

async function readOriginalInputs(
  history: ConsumerHistory,
): Promise<OriginalInputs> {
  return {
    test: await readFile(history.testPath, "utf8"),
    doc: await readFile(history.docPath, "utf8"),
    source: await readFile(history.sourcePath, "utf8"),
    sidecar: await readFile(history.sidecarPath, "utf8"),
  };
}

async function verifyNormalMaintenance(
  queryRoot: string,
  history: ConsumerHistory,
): Promise<void> {
  const normal = await runCheckPair(queryRoot, 0, "consistent");
  assertConsistent(normal.report);
  assertExecution(normal.report);
  assertCurrentHistory(normal.report, queryRoot);
  assert.deepEqual(await readFile(history.baselinePath), history.baseline);
}

async function verifyInputOnlyDrift(
  queryRoot: string,
  history: ConsumerHistory,
  originalInputs: OriginalInputs,
): Promise<void> {
  const driftedTest = replaceExactlyOnce(
    originalInputs.test,
    "const x = { a: 1, b: 2 }",
    "const x = { a: 3, b: 2 }",
  );
  await writeFile(history.testPath, driftedTest, "utf8");
  try {
    const result = await runCheckPair(queryRoot, 1, "changed");
    assertInputDrift(result.report);
    assertExecution(result.report);
    assert.deepEqual(await readFile(history.baselinePath), history.baseline);
  } finally {
    await writeFile(history.testPath, originalInputs.test, "utf8");
  }
}

async function verifySelectionDefinitionDrift(
  queryRoot: string,
  history: ConsumerHistory,
): Promise<void> {
  const original = await readFile(history.sidecarPath, "utf8");
  await writeFile(
    history.sidecarPath,
    replaceExactlyOnce(
      original,
      'contains: "The previous data"',
      'contains: "previous data"',
    ),
    "utf8",
  );
  try {
    const result = await runCheckPair(queryRoot, 1, "changed");
    assertExecution(result.report);
    for (const bindingId of bindingIds) {
      const binding = bindingFrom(result.report, bindingId);
      assert.equal(binding.consistency, "inconsistent");
      const change = changeFor(binding, "keep-return-doc");
      assert.equal(change.kind, "reference-definition");
      assert.ok(isRecord(change.before));
      assert.ok(isRecord(change.after));
      assert.equal(change.before.id, "keep-return-doc");
      assert.equal(change.after.id, "keep-return-doc");
    }
    assert.equal(
      currentReferenceValue(result.report, "keep-status", "keep-return-doc")
        .value,
      currentQuote,
    );
    assert.deepEqual(await readFile(history.baselinePath), history.baseline);
  } finally {
    await writeFile(history.sidecarPath, original, "utf8");
  }
}

async function verifyImplementationDrift(
  queryRoot: string,
  history: ConsumerHistory,
  originalInputs: OriginalInputs,
): Promise<void> {
  await writeFile(
    history.sourcePath,
    replaceExactlyOnce(
      originalInputs.source,
      historicalFunction,
      implementationDrift,
    ),
    "utf8",
  );
  try {
    const result = await runCheckPair(queryRoot, 1, "changed");
    assertExecution(result.report);
    const status = bindingFrom(result.report, "keep-status");
    assert.equal(status.consistency, "consistent");
    const observation = bindingFrom(result.report, "keep-observation");
    assert.equal(observation.consistency, "inconsistent");
    assert.deepEqual(changeFor(observation, observationId), {
      kind: "fact",
      referenceId: observationId,
      before: oldObservation,
      after: changedObservation,
    });
    const source = bindingFrom(result.report, "keep-source");
    assert.equal(source.consistency, "inconsistent");
    const sourceChange = changeFor(source, "keep-function");
    assert.equal(sourceChange.kind, "fact");
    assert.equal(sourceChange.before, historicalFunction);
    assert.equal(sourceChange.after, implementationDrift);
    assert.deepEqual(await readFile(history.baselinePath), history.baseline);
  } finally {
    await writeFile(history.sourcePath, originalInputs.source, "utf8");
  }
}

async function verifyInvalidReferenceAndRejectedUpdate(
  queryRoot: string,
  history: ConsumerHistory,
  originalInputs: OriginalInputs,
): Promise<void> {
  const invalidDoc = replaceExactlyOnce(
    originalInputs.doc,
    currentQuote,
    "No prior result is included.",
  );
  await writeFile(history.docPath, invalidDoc, "utf8");
  try {
    const check = await runCheckPair(queryRoot, 1, "errors");
    assertExecution(check.report);
    const firstError = findReferenceError(
      bindingFrom(check.report, "keep-status"),
      "keep-return-doc",
    );
    assertTextError(check.text.stdout, "keep-return-doc", firstError);
    for (const bindingId of bindingIds) {
      const error = findReferenceError(
        bindingFrom(check.report, bindingId),
        "keep-return-doc",
      );
      assert.equal(error.code, firstError.code);
      assert.equal(error.message, firstError.message);
    }
    assert.deepEqual(await readFile(history.baselinePath), history.baseline);

    const update = await runDock(queryRoot, [
      "baseline",
      "update",
      "--config",
      "dock.config.ts",
      "--json",
    ]);
    assert.equal(update.code, 1, `${update.stdout}\n${update.stderr}`);
    const envelope = parseEnvelope(update.stdout);
    assert.equal(envelope.variant, "rejected");
    assert.ok(isRecord(envelope.data));
    const report = reportValue(envelope.data);
    assertScope(report);
    assertExecution(report);
    for (const bindingId of bindingIds) {
      findReferenceError(bindingFrom(report, bindingId), "keep-return-doc");
    }
    assert.ok(Array.isArray(envelope.data.errors));
    assert.deepEqual(await readFile(history.baselinePath), history.baseline);
  } finally {
    await writeFile(history.docPath, originalInputs.doc, "utf8");
  }
}

async function verifyDirectValidUpdate(
  queryRoot: string,
  history: ConsumerHistory,
): Promise<void> {
  const update = await run("pnpm", ["run", "dock:baseline:update"], queryRoot);
  assert.equal(update.code, 0, `${update.stdout}\n${update.stderr}`);

  const updatedBytes = await readFile(history.baselinePath);
  assert.notDeepEqual(updatedBytes, history.baseline);
  const updatedBaseline = JSON.parse(updatedBytes.toString("utf8")) as unknown;
  assertBaselineObservation(updatedBaseline, oldObservation);
  assertBaselineReferenceValue(
    updatedBaseline,
    "keep-status",
    "keep-return-doc",
    currentQuote,
  );
  const afterUpdate = await runCheckPair(queryRoot, 0, "consistent");
  assertConsistent(afterUpdate.report);
  assertExecution(afterUpdate.report);
  assertCurrentHistory(afterUpdate.report, queryRoot);
  history.baseline = updatedBytes;
}

async function restoreInputs(
  history: ConsumerHistory,
  originalInputs: OriginalInputs,
): Promise<void> {
  await writeFile(history.testPath, originalInputs.test, "utf8");
  await writeFile(history.docPath, originalInputs.doc, "utf8");
  await writeFile(history.sourcePath, originalInputs.source, "utf8");
  await writeFile(history.sidecarPath, originalInputs.sidecar, "utf8");
  await writeFile(history.baselinePath, history.baseline);
}

async function runCheckPair(
  queryRoot: string,
  exitCode: number,
  variant: string,
): Promise<MaintenanceResult> {
  const text = await runDock(queryRoot, [
    "check",
    "--config",
    "dock.config.ts",
  ]);
  assert.equal(text.code, exitCode, `${text.stdout}\n${text.stderr}`);
  assert.equal(
    normalized(text.stdout).includes("执行：1 次测试尝试，1 次命令尝试"),
    true,
  );
  const json = await runDock(queryRoot, [
    "check",
    "--config",
    "dock.config.ts",
    "--json",
  ]);
  assert.equal(json.code, exitCode, `${json.stdout}\n${json.stderr}`);
  const envelope = parseEnvelope(json.stdout);
  assert.equal(envelope.variant, variant);
  assert.ok(isRecord(envelope.data));
  const report = reportValue(envelope.data);
  assertScope(report);
  return { text, json, report };
}

async function runDock(
  queryRoot: string,
  arguments_: readonly string[],
): Promise<ProcessResult> {
  return await run("pnpm", ["exec", "dock", ...arguments_], queryRoot);
}

async function runChecked(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  label: string,
  timeoutMs = 5 * 60_000,
): Promise<ProcessResult> {
  const result = await run(command, arguments_, cwd, timeoutMs);
  assert.equal(
    result.code,
    0,
    `${label}：\n${result.stdout}\n${result.stderr}`,
  );
  return result;
}

function run(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  timeoutMs = 5 * 60_000,
): Promise<ProcessResult> {
  return new Promise((resolveResult, rejectResult) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceKill: NodeJS.Timeout | undefined;
    const child = spawn(command, [...arguments_], {
      cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      signalProcess(child, "SIGTERM");
      forceKill = setTimeout(() => signalProcess(child, "SIGKILL"), 5_000);
    }, timeoutMs);
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

function assertInputDrift(report: RecordValue): void {
  assert.equal(bindingFrom(report, "keep-status").consistency, "consistent");
  assert.equal(bindingFrom(report, "keep-source").consistency, "consistent");
  const observation = bindingFrom(report, "keep-observation");
  assert.equal(observation.consistency, "inconsistent");
  assert.deepEqual(changeFor(observation, observationId), {
    kind: "fact",
    referenceId: observationId,
    before: oldObservation,
    after: changedObservation,
  });
}

function assertHistoricalDocumentDrift(report: RecordValue): void {
  for (const bindingId of bindingIds) {
    const binding = bindingFrom(report, bindingId);
    assert.equal(binding.consistency, "inconsistent");
    assertDocumentChange(binding);
    assert.ok(Array.isArray(binding.changes));
    const expectedChanges: Record<string, readonly string[]> = {
      "keep-status": [
        "keep-case:reference-definition",
        "keep-return-doc:fact",
        "keep-return-doc:reference-definition",
      ],
      "keep-observation": [
        `${observationId}:reference-definition`,
        "keep-case:reference-definition",
        "keep-return-doc:fact",
        "keep-return-doc:reference-definition",
      ],
      "keep-source": [
        "keep-return-doc:fact",
        "keep-return-doc:reference-definition",
      ],
    };
    assert.deepEqual(
      binding.changes
        .map((change) => {
          assert.ok(isRecord(change));
          assert.ok(typeof change.kind === "string");
          assert.ok(typeof change.referenceId === "string");
          return `${change.referenceId}:${change.kind}`;
        })
        .sort(compareStrings),
      [...(expectedChanges[bindingId] ?? [])].sort(compareStrings),
    );
    const definitionChange = changeOfKind(
      binding,
      "keep-return-doc",
      "reference-definition",
    );
    assert.ok(isRecord(definitionChange.before));
    assert.ok(isRecord(definitionChange.after));
    assert.deepEqual(definitionChange.before.selection, {
      kind: "markdown",
      steps: [
        { kind: "section", heading: "Returns" },
        { kind: "quote", text: historicalQuote },
      ],
    });
    assert.deepEqual(definitionChange.after.selection, {
      kind: "markdown",
      steps: [
        { kind: "section", heading: "Returns" },
        {
          kind: "node",
          selector: { type: "paragraph", contains: "The previous data" },
        },
      ],
    });
    if (bindingId === "keep-status" || bindingId === "keep-observation") {
      assertHistoricalExecutionChange(binding, "keep-case");
    }
    if (bindingId === "keep-observation") {
      assertHistoricalExecutionChange(binding, observationId);
    }
  }
  assert.deepEqual(
    currentReferenceValue(report, "keep-observation", observationId).value,
    oldObservation,
  );
  assert.deepEqual(
    currentReferenceValue(report, "keep-status", "keep-case").value,
    { status: "passed" },
  );
  assert.equal(
    currentReferenceValue(report, "keep-source", "keep-function").value,
    historicalFunction,
  );
}

function assertHistoricalExecutionChange(
  binding: RecordValue,
  referenceId: string,
): void {
  const change = changeOfKind(binding, referenceId, "reference-definition");
  assert.ok(isRecord(change.before));
  assert.ok(isRecord(change.before.target));
  assert.ok(isRecord(change.before.target.target));
  assert.deepEqual(
    change.before.target.target.historicalSelection,
    historicalExecutionSelection,
  );
  assert.ok(isRecord(change.after));
  assert.ok(isRecord(change.after.target));
  assert.ok(isRecord(change.after.target.target));
  assert.equal(
    Object.hasOwn(change.after.target.target, "historicalSelection"),
    false,
  );
}

function assertDocumentChange(binding: RecordValue): void {
  assert.deepEqual(changeOfKind(binding, "keep-return-doc", "fact"), {
    kind: "fact",
    referenceId: "keep-return-doc",
    before: historicalQuote,
    after: currentQuote,
  });
}

function changeOfKind(
  binding: RecordValue,
  referenceId: string,
  kind: string,
): RecordValue {
  assert.ok(Array.isArray(binding.changes));
  const change = binding.changes.find(
    (item) =>
      isRecord(item) && item.referenceId === referenceId && item.kind === kind,
  );
  assert.ok(isRecord(change));
  return change;
}

function assertConsistent(report: RecordValue): void {
  for (const bindingId of bindingIds) {
    const binding = bindingFrom(report, bindingId);
    assert.equal(binding.consistency, "consistent");
    assert.deepEqual(binding.changes, []);
  }
}

function assertCurrentHistory(report: RecordValue, queryRoot: string): void {
  const observation = currentReferenceValue(
    report,
    "keep-observation",
    observationId,
  );
  assert.deepEqual(observation.value, oldObservation);
  assert.equal(
    currentReferenceValue(report, "keep-status", "keep-return-doc").value,
    currentQuote,
  );
  assert.equal(
    currentReferenceValue(report, "keep-source", "keep-function").value,
    historicalFunction,
  );
  for (const [bindingId, referenceId, relativePath] of [
    ["keep-status", "keep-return-doc", docPath],
    ["keep-observation", "keep-case", testPath],
    ["keep-source", "keep-function", sourcePath],
  ] as const) {
    const definition = currentReferenceValue(
      report,
      bindingId,
      referenceId,
    ).definition;
    assert.ok(isRecord(definition));
    assert.ok(isRecord(definition.target));
    assert.equal(definition.target.fileInfo, resolve(queryRoot, relativePath));
  }
}

function currentReferenceValue(
  report: RecordValue,
  bindingId: string,
  referenceId: string,
): RecordValue {
  const binding = bindingFrom(report, bindingId);
  assert.ok(isRecord(binding.current));
  assert.ok(isRecord(binding.current.references));
  const reference = binding.current.references[referenceId];
  assert.ok(isRecord(reference));
  return reference;
}

function assertBaselineObservation(
  value: unknown,
  expected: typeof oldObservation,
): void {
  assertBaselineReferenceValue(
    value,
    "keep-observation",
    observationId,
    expected,
  );
}

function assertBaselineReferenceValue(
  value: unknown,
  bindingId: string,
  referenceId: string,
  expected: unknown,
): void {
  assert.ok(isRecord(value));
  assert.ok(isRecord(value.bindings));
  const binding = value.bindings[bindingId];
  assert.ok(isRecord(binding));
  assert.ok(isRecord(binding.references));
  const reference = binding.references[referenceId];
  assert.ok(isRecord(reference));
  assert.deepEqual(reference.value, expected);
}

function assertScope(report: RecordValue): void {
  assert.ok(Array.isArray(report.scope));
  assert.deepEqual(
    [...report.scope].sort(compareStrings),
    [...bindingIds].sort(compareStrings),
  );
}

function assertExecution(report: RecordValue): void {
  assert.ok(isRecord(report.execution));
  assert.equal(report.execution.testExecutions, 1);
  assert.equal(report.execution.commandAttempts, 1);
}

function bindingFrom(report: RecordValue, bindingId: string): RecordValue {
  assert.ok(Array.isArray(report.bindings));
  const binding = report.bindings.find(
    (item) => isRecord(item) && item.bindingId === bindingId,
  );
  assert.ok(isRecord(binding), `报告缺少关联 ${bindingId}。`);
  return binding;
}

function changeFor(binding: RecordValue, referenceId: string): RecordValue {
  assert.ok(Array.isArray(binding.changes));
  const change = binding.changes.find(
    (item) => isRecord(item) && item.referenceId === referenceId,
  );
  assert.ok(isRecord(change), `报告缺少引用 ${referenceId} 的事实变化。`);
  return change;
}

function findReferenceError(
  binding: RecordValue,
  referenceId: string,
): RecordValue {
  assert.ok(Array.isArray(binding.errors));
  const error = binding.errors.find(
    (item) => isRecord(item) && item.referenceId === referenceId,
  );
  assert.ok(isRecord(error), `报告未包含引用 ${referenceId} 的核对错误。`);
  return error;
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
}

function reportValue(value: RecordValue): RecordValue {
  const report = value.report;
  assert.ok(isRecord(report));
  return report;
}

function parseEnvelope(output: string): RecordValue {
  const envelope: unknown = JSON.parse(output);
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
    `固定 Query 输入必须唯一包含 ${before}。`,
  );
  return source.replace(before, after);
}

function normalized(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(access(path), { code: "ENOENT" });
}

function appendOutput(current: string, next: string): string {
  const combined = current + next;
  const limit = 250_000;
  return combined.length <= limit ? combined : combined.slice(-limit);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

await main();
