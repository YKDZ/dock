import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  createReference,
  definePlugin,
  readReference,
} from "@ykdz/dock";
import type {
  Config,
  JsonValue,
  PluginContext,
  PluginBatchResult,
  PluginInformation,
  PluginReadResult,
  PluginRequest,
  PluginResult,
  ReadableReferenceOf,
  Reference,
  ReferenceOptions,
  ReferencePlugin,
  ReferenceValue,
} from "@ykdz/dock";

import { executeNodeTestRun } from "./native-runner.ts";
import {
  assertNodeTestActive,
  beginExecution,
  recordNodeObservation,
  recordNodeRead,
} from "./test-context.ts";
import type {
  NodeEventTarget,
  NodeSelectedTest,
  NodeRunConfiguration,
  NodeTestRunResult,
} from "./types.ts";

export const nodeTestPluginId = "@ykdz/dock-reference-node-test" as const;

export type NodeTestObservation<
  Key extends string = string,
  Value extends JsonValue = JsonValue,
> = {
  readonly key: Key;
  readonly record: (value: Value) => Value;
};

type AnyNodeTestObservation = {
  readonly key: string;
  readonly record: (value: never) => JsonValue;
};
type ObservationKeys<
  Observations extends readonly AnyNodeTestObservation[],
  Values extends Record<string, JsonValue>,
> = {
  -readonly [Index in keyof Observations]: Observations[Index] extends {
    readonly key: infer Key extends string;
  }
    ? Key
    : never;
} & {
  readonly __dockTypeWitness?: {
    readonly framework: "node-test";
    readonly values: Values;
  };
};
type ObservationValues<Observations extends readonly AnyNodeTestObservation[]> =
  {
    readonly [
      Observation in Observations[number] as Observation["key"]
    ]: ObservationValue<Observation>;
  };
type ValuesFromNodeTestRun<Run> = Run extends {
  readonly observationKeys: {
    readonly __dockTypeWitness?: { readonly values: infer Values };
  };
}
  ? Values extends Record<string, JsonValue>
    ? Values
    : never
  : never;
type WidenJson<Value> = Value extends string
  ? string
  : Value extends number
    ? number
    : Value extends boolean
      ? boolean
      : Value extends readonly (infer Item)[]
        ? WidenJson<Item>[]
        : Value extends object
          ? { readonly [Key in keyof Value]: WidenJson<Value[Key]> }
          : Value;
type ObservationValue<Observation> = Observation extends {
  readonly record: (value: never) => infer Value;
}
  ? Value
  : never;

export type NodeTestRun<
  Observations extends readonly AnyNodeTestObservation[] =
    readonly AnyNodeTestObservation[],
  Values extends Record<string, JsonValue> = ObservationValues<Observations>,
> = {
  readonly identity: string;
  readonly files: [string, ...string[]];
  readonly testRoot?: string;
  readonly namePattern?: string;
  readonly observationKeys: ObservationKeys<Observations, Values>;
};

export type NodeTestRunOptions<
  Observations extends readonly AnyNodeTestObservation[] =
    readonly AnyNodeTestObservation[],
> = {
  readonly files: readonly [string, ...string[]];
  readonly testRoot?: string;
  readonly namePattern?: string;
  readonly observations?: Observations;
};

export type NodeTestValue = { readonly status: "passed" };

export type NodeTestStatusTarget<
  Observations extends readonly AnyNodeTestObservation[] =
    readonly AnyNodeTestObservation[],
  Values extends Record<string, JsonValue> = ObservationValues<Observations>,
> = {
  readonly kind: "node-test-status";
  readonly run: NodeTestRun<Observations, Values>;
  readonly file: string;
  readonly name: string;
};

export type NodeTestObservationTarget = {
  readonly kind: "node-test-observation";
  readonly run: NodeTestRun;
  readonly file: string;
  readonly name: string;
  readonly key: string;
};

export type NodeTestTarget = NodeTestStatusTarget | NodeTestObservationTarget;

export type NodeTestStatusReference<
  Id extends string = string,
  Observations extends readonly AnyNodeTestObservation[] =
    readonly AnyNodeTestObservation[],
  Values extends Record<string, JsonValue> = ObservationValues<Observations>,
> = Reference<
  typeof nodeTestPluginId,
  Id,
  NodeTestStatusTarget<Observations, Values>,
  NodeTestValue,
  never
>;

export type NodeTestObservationReference<
  Id extends string = string,
  Observation extends AnyNodeTestObservation = AnyNodeTestObservation,
> = Reference<
  typeof nodeTestPluginId,
  Id,
  NodeTestObservationTarget,
  ObservationValue<Observation>,
  never
>;

export type NodeTestReference<Id extends string = string> =
  | NodeTestStatusReference<Id>
  | NodeTestObservationReference<Id>;

type RuntimeNodeTestReference = Reference<typeof nodeTestPluginId, string>;

type NodePreparedRun = {
  readonly identity: string;
  readonly configuration: NodeRunConfiguration;
  readonly references: string[];
};

type NodePrepared = { readonly runs: NodePreparedRun[] };

type NodeRunOutcome = {
  readonly preparedRun: NodePreparedRun;
  readonly references: readonly RuntimeNodeTestReference[];
  readonly result: NodeTestRunResult;
};

/** 声明稳定观察键；sample 只用于推导类型，不作为默认事实。 */
export function defineNodeTestObservation<
  const Key extends string,
  Sample extends JsonValue,
>(key: Key, sample: Sample): NodeTestObservation<Key, WidenJson<Sample>> {
  assertObservationKey(key);
  void sample;
  return {
    key,
    record: (value: WidenJson<Sample>): WidenJson<Sample> => {
      recordNodeObservation(key, value);
      return value;
    },
  };
}

/** 类型化地声明一次 Node 原生运行，不在声明时启动测试进程。 */
export function defineNodeTestRun<
  const Observations extends readonly AnyNodeTestObservation[] = readonly [],
>(
  identity: string,
  options: NodeTestRunOptions<Observations>,
): NodeTestRun<Observations, ObservationValues<Observations>> {
  const observationKeys = (options.observations ?? []).map((observation) => {
    assertObservationDefinition(observation);
    return observation.key;
  }) as ObservationKeys<Observations, ObservationValues<Observations>>;
  const run = {
    identity,
    files: [...options.files],
    ...(options.testRoot === undefined ? {} : { testRoot: options.testRoot }),
    ...(options.namePattern === undefined
      ? {}
      : { namePattern: options.namePattern }),
    observationKeys,
  } as NodeTestRun<Observations, ObservationValues<Observations>>;
  assertRun(identity, run);
  return run;
}

/** 声明一条依赖原生测试成功终态的引用。 */
export function nodeTestStatus<
  const Id extends string,
  const Observations extends readonly AnyNodeTestObservation[],
  Values extends Record<string, JsonValue>,
>(
  id: Id,
  run: NodeTestRun<Observations, Values>,
  target: { readonly file: string; readonly name: string },
  options: Pick<ReferenceOptions, "declaredAt" | "note"> = {},
): NodeTestStatusReference<Id, Observations, Values> {
  assertRun(run.identity, run);
  assertTestSelection(target);
  return createReference<
    typeof nodeTestPluginId,
    Id,
    NodeTestStatusTarget<Observations, Values>,
    NodeTestValue,
    never
  >(
    nodeTestPluginId,
    id,
    {
      kind: "node-test-status",
      run,
      file: target.file,
      name: target.name,
    },
    {
      ...(options.declaredAt === undefined
        ? {}
        : { declaredAt: options.declaredAt }),
      ...(options.note === undefined ? {} : { note: options.note }),
    },
  );
}

/** 将同一观察声明绑定到选定 Node 测试，并保留其值类型。 */
export function nodeTestObservation<
  const Id extends string,
  const Run extends NodeTestRun,
  const Key extends keyof ValuesFromNodeTestRun<Run> & string,
>(
  id: Id,
  run: Run,
  target: { readonly file: string; readonly name: string },
  observation: NodeTestObservation<
    Key,
    NoInfer<ValuesFromNodeTestRun<Run>[Key]>
  >,
  options: Pick<ReferenceOptions, "declaredAt" | "note"> = {},
): NodeTestObservationReference<
  Id,
  NodeTestObservation<Key, ValuesFromNodeTestRun<Run>[Key]>
> {
  assertRun(run.identity, run);
  assertTestSelection(target);
  assertObservationDefinition(observation);
  if (!run.observationKeys.includes(observation.key)) {
    throw new TypeError(
      `Node 测试运行 ${run.identity} 未声明观察键 ${observation.key}。`,
    );
  }
  return createReference<
    typeof nodeTestPluginId,
    Id,
    NodeTestObservationTarget,
    ValuesFromNodeTestRun<Run>[Key],
    never
  >(
    nodeTestPluginId,
    id,
    {
      kind: "node-test-observation",
      run,
      file: target.file,
      name: target.name,
      key: observation.key,
    },
    {
      ...(options.declaredAt === undefined
        ? {}
        : { declaredAt: options.declaredAt }),
      ...(options.note === undefined ? {} : { note: options.note }),
    },
  );
}

/** 活动 Node 测试内经宿主读取当前引用并记录可解释的读取结果。 */
export async function readReferenceInTest<
  const Plugins extends readonly ReferencePlugin[],
  const Ref extends ReadableReferenceOf<Plugins>,
>(
  config: Config<Plugins>,
  reference: Ref,
): Promise<PluginReadResult<ReferenceValue<Ref>>> {
  assertNodeTestActive("测试内读取引用");
  const result = await readReference(config, reference);
  assertNodeTestActive("测试内读取引用");
  recordNodeRead({
    referenceId: reference.id,
    value: result.value,
    ...(result.range === undefined ? {} : { range: result.range }),
  });
  return result;
}

const nodeTestImplementation = definePlugin({
  id: nodeTestPluginId,
  validate(reference: RuntimeNodeTestReference): void {
    if (reference.selection !== undefined) {
      throw new TypeError("Node 测试状态引用不支持 selection。");
    }
    assertTestTarget(reference.target);
  },
  fileInfo(
    reference: RuntimeNodeTestReference,
    context: PluginContext,
  ): string {
    const target = getNodeTestTarget(reference.target);
    return resolveTargetFile(
      resolvePath(context.root, target.run.testRoot ?? "."),
      target.file,
    );
  },
  prepare(
    references: readonly RuntimeNodeTestReference[],
    context: PluginContext,
  ): NodePrepared {
    return prepareNodeRuns(references, context.root);
  },
  describe(
    request: PluginRequest<RuntimeNodeTestReference, NodePrepared>,
  ): PluginInformation {
    return describeNodeRuns(request);
  },
  async collect(
    request: PluginRequest<RuntimeNodeTestReference, NodePrepared>,
  ): Promise<PluginBatchResult> {
    return await collectNodeTests(request);
  },
  readReferenceInTest,
});

export const nodeTest = nodeTestImplementation;

/** 在 Node 原生测试回调入口标记实际开始，供取消用例区分是否进入回调。 */
export { beginExecution };

function prepareNodeRuns(
  references: readonly RuntimeNodeTestReference[],
  root: string,
): NodePrepared {
  const runs = new Map<string, NodePreparedRun>();
  for (const reference of references) {
    const target = getNodeTestTarget(reference.target);
    const configuration = normalizeRun(target.run, root);
    const existing = runs.get(target.run.identity);
    if (existing !== undefined) {
      if (
        canonicalJson(existing.configuration) !== canonicalJson(configuration)
      ) {
        throw new TypeError(
          `Node 运行身份 ${target.run.identity} 在完整声明中对应不同配置。`,
        );
      }
      existing.references.push(reference.id);
      continue;
    }
    runs.set(target.run.identity, {
      identity: target.run.identity,
      configuration,
      references: [reference.id],
    });
  }
  return { runs: [...runs.values()] };
}

function describeNodeRuns(
  request: PluginRequest<RuntimeNodeTestReference, NodePrepared>,
): PluginInformation {
  const selectedIds = new Set(
    request.selectedReferences.map((reference) => reference.id),
  );
  const runs = (request.prepared?.runs ?? []).map((run) => ({
    identity: run.identity,
    configuration: run.configuration,
    references: [...run.references],
    selectedReferences: run.references.filter((id) => selectedIds.has(id)),
  }));
  return {
    data: { runs },
    text: runs.map(
      (run) =>
        `Node 运行 ${run.identity}：${describeNodeRunConfiguration(run.configuration)}；完整引用 ${run.references.join("、") || "无"}；本次选中 ${run.selectedReferences.join("、") || "无"}`,
    ),
  };
}

async function collectNodeTests(
  request: PluginRequest<RuntimeNodeTestReference, NodePrepared>,
): Promise<PluginBatchResult> {
  if (request.selectedReferences.length === 0) {
    return { results: [], diagnostics: { data: { runs: [] }, text: [] } };
  }
  const prepared = request.prepared;
  if (prepared === undefined) {
    throw new TypeError("Node 批量采集缺少本次完整预检结果。");
  }

  const selected = new Map<string, RuntimeNodeTestReference[]>();
  for (const reference of request.selectedReferences) {
    const target = getNodeTestTarget(reference.target);
    const references = selected.get(target.run.identity) ?? [];
    references.push(reference);
    selected.set(target.run.identity, references);
  }
  const preparedByIdentity = new Map(
    prepared.runs.map((run) => [run.identity, run]),
  );
  for (const identity of selected.keys()) {
    if (!preparedByIdentity.has(identity)) {
      throw new TypeError(`Node 运行 ${identity} 未通过完整预检。`);
    }
  }

  const outcomes = await Promise.all(
    prepared.runs
      .filter((run) => selected.has(run.identity))
      .map(async (preparedRun): Promise<NodeRunOutcome> => {
        const references = selected.get(preparedRun.identity)!;
        const targets = references.map((reference) => {
          const target = getNodeTestTarget(reference.target);
          return {
            file: resolveTargetFile(
              preparedRun.configuration.testRoot,
              target.file,
            ),
            name: target.name,
          };
        });
        let result: NodeTestRunResult;
        try {
          result = await executeNodeTestRun(
            preparedRun.configuration,
            uniqueSelectedTests(targets),
          );
        } catch (error) {
          result = failedNodeTestRun(error);
        }
        return { preparedRun, references, result };
      }),
  );

  return {
    results: outcomes.flatMap(({ preparedRun, references, result }) =>
      references.map((reference) => ({
        referenceId: reference.id,
        ...factFromNodeRun(reference, result, preparedRun),
      })),
    ),
    diagnostics: nodeRunInformation(outcomes),
  };
}

function nodeRunInformation(
  outcomes: readonly NodeRunOutcome[],
): PluginInformation {
  const runs = outcomes.map(({ preparedRun, result }) => {
    const failedCommands =
      result.commandResult !== undefined &&
      (result.commandResult.exitCode !== 0 ||
        result.commandResult.signal !== null)
        ? 1
        : 0;
    const failures = result.tests
      .filter((test) => test.status === "failed" || test.status === "cancelled")
      .map((test) => ({
        id: test.id,
        status: test.status,
        ...(test.message === undefined ? {} : { message: test.message }),
      }));
    const reads = result.tests.flatMap((test) =>
      (test.reads ?? []).map((read) => ({
        runId: preparedRun.identity,
        testId: test.id,
        ...read,
      })),
    );
    return {
      identity: preparedRun.identity,
      configuration: preparedRun.configuration,
      commandAttempts: result.commandAttempts,
      failedCommands,
      testExecutions: result.testExecutions,
      failures,
      errors: result.errors.map(({ code, message }) => ({ code, message })),
      ...(result.commandResult === undefined
        ? {}
        : { commandResult: { ...result.commandResult } }),
      reads,
    };
  });
  const text: string[] = [];
  for (const run of runs) {
    text.push(
      `Node 运行 ${run.identity}：${run.testExecutions} 次测试尝试，${run.commandAttempts} 次命令尝试，${run.failedCommands} 次命令失败。`,
      `Node 运行 ${run.identity} 配置：${describeNodeRunConfiguration(run.configuration)}`,
    );
    for (const failure of run.failures) {
      text.push(
        `Node 测试 ${failure.id} 最终状态 ${failure.status}${failure.message === undefined ? "" : `：${failure.message}`}`,
      );
    }
    for (const read of run.reads) {
      const location =
        read.range === undefined
          ? ""
          : `；位置 ${read.range.path}（文本偏移 ${read.range.start}–${read.range.end}）`;
      text.push(
        `Node 测试内读取 ${read.referenceId}（运行 ${read.runId}，测试 ${read.testId}，第 ${read.attempt} 次尝试）：${JSON.stringify(read.value)}${location}`,
      );
    }
    for (const error of run.errors) {
      text.push(
        `Node 运行 ${run.identity} 错误（${error.code}）：${error.message}`,
      );
    }
  }
  return { data: { runs }, text };
}

function describeNodeRunConfiguration(
  configuration: NodeRunConfiguration,
): string {
  return `项目目录 ${configuration.root}；测试目录 ${configuration.testRoot}；测试文件 ${configuration.files.join("、")}；名称筛选 ${configuration.namePattern ?? "无"}；观察键 ${configuration.observationKeys.join("、") || "无"}`;
}

function failedNodeTestRun(error: unknown): NodeTestRunResult {
  return {
    lifecycle: "incomplete",
    commandAttempts: 0,
    testExecutions: 0,
    tests: [],
    errors: [{ code: "execution-failed", message: errorMessage(error) }],
  };
}

function factFromNodeRun(
  reference: RuntimeNodeTestReference,
  run: NodeTestRunResult,
  declaration: NodePreparedRun,
): PluginResult {
  const normalized = declaration.configuration;
  if (run.lifecycle !== "complete" || run.errors.length > 0) {
    const detail = run.errors.map((error) => error.message).join("；");
    return {
      kind: "error",
      error: {
        code: "run-lifecycle-failed",
        message: detail || "Node 原生测试没有完整且一致地结束。",
      },
    };
  }

  const target = getNodeTestTarget(reference.target);
  const targetFile = resolveTargetFile(normalized.testRoot, target.file);
  const targetIdentity = JSON.stringify({
    file: relative(normalized.testRoot, targetFile).split("\\").join("/"),
    name: target.name,
  });
  const matches = run.tests.filter((test) => test.id === targetIdentity);
  if (matches.length === 0) {
    if (!normalized.files.includes(targetFile)) {
      return nodeError(
        "test-not-executed",
        `运行 ${declaration.identity} 未包含目标文件 ${target.file}。`,
      );
    }
    if (
      normalized.namePattern !== undefined &&
      !new RegExp(normalized.namePattern).test(target.name)
    ) {
      return nodeError(
        "test-filtered",
        `测试 ${target.name} 被 Node 原生名称筛选排除。`,
      );
    }
    return nodeError(
      "test-not-executed",
      `没有执行声明的测试：${target.file} / ${target.name}。`,
    );
  }
  if (matches.length > 1 || matches[0]?.status === "duplicate") {
    return nodeError(
      "duplicate-test-identity",
      `同一文件中有多个测试匹配身份 ${target.name}。`,
    );
  }

  const [test] = matches;
  if (test === undefined) {
    return nodeError("test-not-executed", "没有找到声明的 Node 测试。");
  }
  if (test.status === "passed") {
    if (target.kind === "node-test-status") {
      return { kind: "value", value: { status: "passed" } };
    }
    const observations = (test.observations ?? []).filter(
      (observation) => observation.key === target.key,
    );
    if (observations.length === 0) {
      return nodeError(
        "observation-missing",
        `测试 ${target.name} 未记录观察键 ${target.key}。`,
      );
    }
    if (observations.length > 1) {
      return nodeError(
        "observation-duplicate",
        `测试 ${target.name} 重复记录观察键 ${target.key}。`,
      );
    }
    return { kind: "value", value: observations[0]!.value };
  }
  const code =
    test.status === "cancelled"
      ? test.started
        ? "test-cancelled"
        : "test-not-executed"
      : test.status === "skipped"
        ? "test-skipped"
        : test.status === "todo"
          ? "test-todo"
          : test.status === "filtered"
            ? "test-filtered"
            : test.status === "duplicate"
              ? "duplicate-test-identity"
              : test.status === "not-run"
                ? "test-not-executed"
                : "test-failed";
  return nodeError(code, test.message ?? `关联测试最终状态为 ${test.status}。`);
}

function normalizeRun(run: NodeTestRun, root: string): NodeRunConfiguration {
  const testRoot = resolvePath(root, run.testRoot ?? ".");
  return {
    framework: nodeTestPluginId,
    root,
    testRoot,
    files: run.files.map((file) => resolvePath(testRoot, file)),
    observationKeys: [...run.observationKeys],
    ...(run.namePattern === undefined ? {} : { namePattern: run.namePattern }),
  };
}

function resolveTargetFile(testRoot: string, file: string): string {
  return resolvePath(testRoot, file);
}

function uniqueSelectedTests(
  targets: readonly NodeSelectedTest[],
): NodeSelectedTest[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const identity = `${target.file}\0${target.name}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function resolvePath(root: string, path: string): string {
  return path.startsWith("file:")
    ? fileURLToPath(new URL(path))
    : isAbsolute(path)
      ? resolve(path)
      : resolve(root, path);
}

function assertRun(
  identity: unknown,
  value: unknown,
): asserts value is NodeTestRun {
  if (
    typeof identity !== "string" ||
    identity.length === 0 ||
    !isRecord(value) ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    !value.files.every(isNonEmptyString) ||
    !Array.isArray(value.observationKeys) ||
    !value.observationKeys.every(isNonEmptyString) ||
    new Set(value.observationKeys).size !== value.observationKeys.length ||
    (value.testRoot !== undefined && !isNonEmptyString(value.testRoot)) ||
    (value.namePattern !== undefined && typeof value.namePattern !== "string")
  ) {
    throw new TypeError(
      "Node 测试运行必须提供身份、至少一个测试文件和有效选项。",
    );
  }
  if (value.namePattern !== undefined) {
    try {
      new RegExp(value.namePattern);
    } catch (error) {
      throw new TypeError(
        `Node 测试 namePattern 无效：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}

function assertTestTarget(value: unknown): asserts value is NodeEventTarget {
  if (
    !isRecord(value) ||
    (value.kind !== "node-test-status" &&
      value.kind !== "node-test-observation") ||
    !isRecord(value.run) ||
    typeof value.file !== "string" ||
    value.file.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0
  ) {
    throw new TypeError("Node 测试引用必须提供有效文件和测试名称。");
  }
  const run = value.run;
  assertRun(run.identity, run);
  if (
    value.kind === "node-test-observation" &&
    (typeof value.key !== "string" ||
      value.key.length === 0 ||
      !run.observationKeys.includes(value.key))
  ) {
    throw new TypeError("Node 测试观察引用必须指向已声明的观察键。");
  }
  assertTestSelection(value);
}

function getNodeTestTarget(value: JsonValue): NodeEventTarget {
  assertTestTarget(value);
  return value;
}

function assertObservationKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("观察键必须是非空文本。");
  }
}

function assertObservationDefinition(
  value: unknown,
): asserts value is AnyNodeTestObservation {
  if (
    !isRecord(value) ||
    typeof value.key !== "string" ||
    value.key.length === 0 ||
    typeof value.record !== "function"
  ) {
    throw new TypeError("Node 测试观察必须由公开声明函数创建。");
  }
}

function assertTestSelection(value: unknown): asserts value is {
  readonly file: string;
  readonly name: string;
} {
  if (
    !isRecord(value) ||
    typeof value.file !== "string" ||
    value.file.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0
  ) {
    throw new TypeError("Node 测试状态引用必须提供有效文件和测试名称。");
  }
}

function nodeError(code: string, message: string): PluginResult<NodeTestValue> {
  return { kind: "error", error: { code, message } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
