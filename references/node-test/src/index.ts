import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createReference, definePlugin, readReference } from "@ykdz/dock";
import type {
  Config,
  JsonValue,
  PluginContext,
  PluginReadResult,
  PluginExecutionContext,
  PluginExecution,
  RunDeclaration,
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

/** 活动 Node 测试内经 SDK 读取当前引用并记录可解释的读取结果。 */
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
  execution: {
    declare(
      references: readonly RuntimeNodeTestReference[],
      context: PluginContext,
    ): readonly RunDeclaration<NodeRunConfiguration>[] {
      return references.map((reference) => {
        const target = getNodeTestTarget(reference.target);
        return {
          identity: target.run.identity,
          configuration: normalizeRun(target.run, context.root),
          references: [reference.id],
        };
      });
    },
    async execute({ declaration, selectedReferences }) {
      const run = declaration.configuration;
      const targets = selectedReferences.map((reference) => {
        const target = getNodeTestTarget(reference.target);
        return {
          file: resolveTargetFile(run.testRoot, target.file),
          name: target.name,
        };
      });
      return await executeNodeTestRun(run, uniqueSelectedTests(targets));
    },
  } satisfies PluginExecution<RuntimeNodeTestReference, NodeRunConfiguration>,
  collect(
    reference: RuntimeNodeTestReference,
    context: PluginExecutionContext<NodeRunConfiguration>,
  ): PluginResult {
    const target = getNodeTestTarget(reference.target);
    const run = context.execution.get(target.run.identity);
    if (run === undefined) {
      return {
        kind: "error",
        error: {
          code: "execution-record-missing",
          message: `Node 执行 ${target.run.identity} 没有完成当前维护会话。`,
        },
      };
    }
    return factFromNodeRun(reference, run.record, run.declaration);
  },
  readReferenceInTest,
});

export const nodeTest = nodeTestImplementation;

/** 在 Node 原生测试回调入口标记实际开始，供取消用例区分是否进入回调。 */
export { beginExecution };

function factFromNodeRun(
  reference: RuntimeNodeTestReference,
  run: Awaited<ReturnType<typeof executeNodeTestRun>>,
  declaration: RunDeclaration<NodeRunConfiguration>,
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
