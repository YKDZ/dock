import { accessSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createReference, definePlugin } from "@dock/sdk";
import type {
  ExecutionRunRecord,
  JsonValue,
  PluginContext,
  PluginExecutionContext,
  PluginExecutionIdentity,
  PluginResult,
  Reference,
  ReferenceOptions,
  ReferencePlugin,
} from "@dock/sdk";

import {
  readReferenceInTest,
  recordVitestObservation,
} from "./attempt-context.ts";
import { testIdentity } from "./event-mapper.ts";
import { executeVitestRun } from "./native-runner.ts";
import type {
  NormalizedVitestRun,
  SelectedVitestTest,
} from "./native-runner.ts";

export const vitestPluginId = "@dock/reference-vitest" as const;

export type VitestObservation<
  Key extends string = string,
  Value extends JsonValue = JsonValue,
> = {
  readonly key: Key;
  record(value: Value): Value;
};

type ObservationKeys<Observations extends readonly VitestObservation[]> = {
  -readonly [
    Index in keyof Observations
  ]: Observations[Index] extends VitestObservation<infer Key, JsonValue>
    ? Key
    : never;
};

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

type ObservationValue<Observation> =
  Observation extends VitestObservation<string, infer Value> ? Value : never;

const observationTypes: unique symbol = Symbol("VitestRun.observationTypes");

export type VitestRun<
  Observations extends readonly VitestObservation[] =
    readonly VitestObservation[],
> = {
  readonly identity: string;
  readonly files: [string, ...string[]];
  /** 扩大本次原生筛选的目标；它们不是必须成功的状态引用。 */
  readonly additionalTests?: VitestTestSelection[];
  readonly testRoot?: string;
  readonly configFile?: string;
  readonly observationKeys: ObservationKeys<Observations>;
  readonly [observationTypes]?: Observations;
};

export type VitestRunOptions<
  Observations extends readonly VitestObservation[] =
    readonly VitestObservation[],
> = {
  readonly files: readonly [string, ...string[]];
  /** 只选择 run.files 中的附加测试，不要求它们成功。 */
  readonly additionalTests?: readonly VitestTestSelection[];
  /** 单份观察声明为测试记录提供键和值类型；sample 不作为默认事实。 */
  readonly observations?: Observations;
  readonly testRoot?: string;
  readonly configFile?: string;
};

export type VitestTestSelection = {
  /** 必须是此运行声明中的测试文件。 */
  readonly file: string;
  /** 完整原生测试标题。 */
  readonly name: string;
};

export type VitestStatusValue = { readonly status: "passed" };

export type VitestStatusTarget<
  Observations extends readonly VitestObservation[] =
    readonly VitestObservation[],
> = {
  readonly kind: "vitest-test-status";
  readonly run: VitestRun<Observations>;
  readonly file: string;
  readonly name: string;
};

export type VitestObservationTarget = {
  readonly kind: "vitest-test-observation";
  readonly run: VitestRun;
  readonly file: string;
  readonly name: string;
  readonly key: string;
};

export type VitestTestTarget<
  Observations extends readonly VitestObservation[] =
    readonly VitestObservation[],
> = VitestStatusTarget<Observations> | VitestObservationTarget;

export type VitestStatusReference<
  Id extends string = string,
  Observations extends readonly VitestObservation[] =
    readonly VitestObservation[],
> = Reference<
  typeof vitestPluginId,
  Id,
  VitestStatusTarget<Observations>,
  VitestStatusValue,
  never
>;

export type VitestObservationReference<
  Id extends string = string,
  Observation extends VitestObservation = VitestObservation,
> = Reference<
  typeof vitestPluginId,
  Id,
  VitestObservationTarget,
  ObservationValue<Observation>,
  never
>;

export type VitestReference<Id extends string = string> =
  | VitestStatusReference<Id>
  | VitestObservationReference<Id>;

type AnyVitestObservation = VitestObservation<string, JsonValue>;

/** 声明稳定观察键；sample 只用于推导类型，不会作为默认观察值。 */
export function defineVitestObservation<
  const Key extends string,
  Sample extends JsonValue,
>(key: Key, sample: Sample): VitestObservation<Key, WidenJson<Sample>> {
  assertObservationKey(key);
  void sample;
  return {
    key,
    record(value): WidenJson<Sample> {
      recordVitestObservation(key, value);
      return value;
    },
  };
}

/** 类型化地声明一次 Vitest 原生运行；声明阶段不启动测试。 */
export function defineVitestRun<
  const Observations extends readonly VitestObservation[] = readonly [],
>(
  identity: string,
  options: VitestRunOptions<Observations>,
): VitestRun<Observations> {
  const observations = options.observations;
  assertRun(identity, options);
  const observationKeys = (observations ?? []).map((observation) => {
    assertObservationDefinition(observation);
    return observation.key;
  }) as ObservationKeys<Observations>;
  return {
    identity,
    files: [...options.files],
    ...(options.additionalTests === undefined
      ? {}
      : {
          additionalTests: options.additionalTests.map(({ file, name }) => ({
            file,
            name,
          })),
        }),
    ...(options.testRoot === undefined ? {} : { testRoot: options.testRoot }),
    ...(options.configFile === undefined
      ? {}
      : { configFile: options.configFile }),
    observationKeys,
  };
}

/** 声明一条依赖 Vitest 最终成功状态的引用。 */
export function vitestStatus<
  const Id extends string,
  const Observations extends readonly VitestObservation[],
>(
  id: Id,
  run: VitestRun<Observations>,
  target: { readonly file: string; readonly name: string },
  options: Pick<ReferenceOptions, "declaredAt" | "note"> = {},
): VitestStatusReference<Id, Observations> {
  assertRun(run.identity, run);
  assertTestSelection(target);
  return createReference<
    typeof vitestPluginId,
    Id,
    VitestStatusTarget<Observations>,
    VitestStatusValue,
    never
  >(
    vitestPluginId,
    id,
    {
      kind: "vitest-test-status",
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

/** 将一条观察声明绑定到测试，并保留记录键和值类型。 */
export function vitestObservation<
  const Id extends string,
  const Observations extends readonly VitestObservation[],
  const Observation extends Observations[number],
>(
  id: Id,
  run: VitestRun<Observations>,
  target: { readonly file: string; readonly name: string },
  observation: Observation,
  options: Pick<ReferenceOptions, "declaredAt" | "note"> = {},
): VitestObservationReference<Id, Observation> {
  assertRun(run.identity, run);
  assertTestSelection(target);
  assertObservationDefinition(observation);
  if (!run.observationKeys.includes(observation.key)) {
    throw new TypeError(
      `Vitest 运行 ${run.identity} 未声明观察键 ${observation.key}。`,
    );
  }
  return createReference<
    typeof vitestPluginId,
    Id,
    VitestObservationTarget,
    ObservationValue<Observation>,
    never
  >(
    vitestPluginId,
    id,
    {
      kind: "vitest-test-observation",
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

type VitestPlugin = ReferencePlugin<typeof vitestPluginId, VitestReference>;

const vitestImplementation: VitestPlugin = definePlugin({
  id: vitestPluginId,
  validate(reference: VitestReference): void {
    if (reference.selection !== undefined) {
      throw new TypeError("Vitest 测试引用不支持 selection。");
    }
    const target = getVitestTarget(reference.target);
    assertRun(target.run.identity, target.run);
    assertTestTarget(target);
    if (
      target.kind === "vitest-test-observation" &&
      !target.run.observationKeys.includes(target.key)
    ) {
      throw new TypeError(
        `Vitest 运行 ${target.run.identity} 未声明观察键 ${target.key}。`,
      );
    }
  },
  fileInfo(reference: VitestReference, context: PluginContext): string {
    const target = getVitestTarget(reference.target);
    const run = normalizeRun(target.run, context.root);
    return resolveTargetFile(run.testRoot, target.file);
  },
  validateReferences(
    references: readonly VitestReference[],
    context: PluginContext,
  ): readonly PluginExecutionIdentity[] {
    const declarations = new Map<
      string,
      {
        readonly declaration: PluginExecutionIdentity;
        readonly encoded: string;
      }
    >();
    for (const reference of references) {
      const target = getVitestTarget(reference.target);
      const run = normalizeRun(target.run, context.root);
      const encoded = JSON.stringify(run.configuration);
      const prior = declarations.get(run.identity);
      if (prior !== undefined && prior.encoded !== encoded) {
        throw new TypeError(
          `Vitest 运行身份 ${run.identity} 在完整配置中对应不同设置。`,
        );
      }
      if (prior === undefined) {
        declarations.set(run.identity, {
          declaration: {
            identity: run.identity,
            configuration: run.configuration,
          },
          encoded,
        });
      }
    }
    return [...declarations.values()].map(({ declaration }) => declaration);
  },
  async prepare(
    references: readonly VitestReference[],
    context: PluginExecutionContext,
  ): Promise<void> {
    const groups = new Map<
      string,
      {
        readonly run: NormalizedVitestRun;
        readonly targets: SelectedVitestTest[];
      }
    >();
    for (const reference of references) {
      const target = getVitestTarget(reference.target);
      const run = normalizeRun(target.run, context.root);
      const groupKey = `${run.identity}\0${JSON.stringify(run.configuration)}`;
      const group = groups.get(groupKey) ?? {
        run,
        targets: [...run.additionalTests],
      };
      group.targets.push({
        file: resolveTargetFile(run.testRoot, target.file),
        name: target.name,
      });
      groups.set(groupKey, group);
    }
    for (const { run, targets } of groups.values()) {
      context.execution.register(
        run.identity,
        run.configuration,
        async () => await executeVitestRun(run, uniqueSelectedTests(targets)),
      );
    }
  },
  collect(
    reference: VitestReference,
    context: PluginExecutionContext,
  ): PluginResult<JsonValue> {
    const target = getVitestTarget(reference.target);
    const run = context.execution.get(target.run.identity);
    if (run === undefined) {
      return {
        kind: "error",
        error: {
          code: "execution-record-missing",
          message: `Vitest 执行 ${target.run.identity} 没有完成当前维护会话。`,
        },
      };
    }
    return factFromVitestRun(
      reference,
      run,
      resolveTestRoot(target.run, context.root),
    );
  },
});

export const vitest = vitestImplementation;
export { readReferenceInTest };

function normalizeRun(run: VitestRun, root: string): NormalizedVitestRun {
  const testRoot = resolvePath(root, run.testRoot ?? ".");
  const files = [
    ...new Set(run.files.map((file) => resolvePath(testRoot, file))),
  ].sort();
  const fileSet = new Set(files);
  const additionalTests = uniqueSelectedTests(
    (run.additionalTests ?? []).map(({ file, name }) => ({
      file: resolveTargetFile(testRoot, file),
      name,
    })),
  ).sort(compareSelectedTests);
  if (additionalTests.some((selection) => !fileSet.has(selection.file))) {
    throw new TypeError(
      "Vitest 的 additionalTests 必须选择 run.files 中的测试文件。",
    );
  }
  const configFile = resolveConfigFile(root, run.configFile, testRoot);
  const configuration: JsonValue = {
    framework: vitestPluginId,
    root,
    testRoot,
    files,
    observationKeys: [...run.observationKeys],
    ...(additionalTests.length === 0 ? {} : { additionalTests }),
    ...(configFile === undefined ? {} : { configFile }),
  };
  return {
    identity: run.identity,
    root,
    testRoot,
    files,
    additionalTests,
    ...(configFile === undefined ? {} : { configFile }),
    configuration: configuration as NormalizedVitestRun["configuration"],
  };
}

function resolveConfigFile(
  root: string,
  configFile: string | undefined,
  testRoot: string,
): string | undefined {
  if (configFile !== undefined) return resolvePath(root, configFile);
  for (const name of [
    "vitest.config.mts",
    "vitest.config.ts",
    "vitest.config.mjs",
    "vitest.config.js",
    "vitest.config.cts",
    "vitest.config.cjs",
    "vite.config.mts",
    "vite.config.ts",
    "vite.config.mjs",
    "vite.config.js",
    "vite.config.cts",
    "vite.config.cjs",
  ]) {
    const candidate = resolve(testRoot, name);
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // 没有常规配置文件时使用空 Vitest 配置。
    }
  }
  return undefined;
}

function factFromVitestRun(
  reference: VitestReference,
  run: ExecutionRunRecord,
  testRoot: string,
): PluginResult<JsonValue> {
  if (run.lifecycle !== "complete" || run.errors.length > 0) {
    const detail = run.errors.map((error) => error.message).join("；");
    return {
      kind: "error",
      error: {
        code: "run-lifecycle-failed",
        message: detail || "Vitest 原生测试没有完整且一致地结束。",
      },
    };
  }

  const target = getVitestTarget(reference.target);
  const targetFile = resolveTargetFile(testRoot, target.file);
  const identity = testIdentity(
    relativeTestFile(testRoot, targetFile),
    target.name,
  );
  const matches = run.tests.filter((test) => test.id === identity);
  if (matches.length === 0) {
    return vitestError(
      "test-not-executed",
      `没有执行声明的 Vitest 测试：${target.file} / ${target.name}。`,
    );
  }
  if (matches.length > 1 || matches[0]?.status === "duplicate") {
    return vitestError(
      "duplicate-test-identity",
      `同一 Vitest 文件中有多个测试匹配身份 ${target.name}。`,
    );
  }

  const test = matches[0];
  if (test?.status === "passed") {
    if (target.kind === "vitest-test-status") {
      return { kind: "value", value: { status: "passed" } };
    }
    const observations = (test.observations ?? []).filter(
      (observation) =>
        observation.key === target.key &&
        observation.attempt === test.attemptCount,
    );
    if (observations.length === 0) {
      return vitestError(
        "observation-missing",
        `测试 ${target.name} 的最终尝试未记录观察键 ${target.key}。`,
      );
    }
    if (observations.length > 1) {
      return vitestError(
        "observation-duplicate",
        `测试 ${target.name} 的最终尝试重复记录观察键 ${target.key}。`,
      );
    }
    return { kind: "value", value: observations[0]!.value };
  }
  if (test === undefined) {
    return vitestError("test-not-executed", "没有找到声明的 Vitest 测试。");
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
  return vitestError(
    code,
    test.message ?? `关联测试最终状态为 ${test.status}。`,
  );
}

function resolveTestRoot(run: VitestRun, root: string): string {
  return resolvePath(root, run.testRoot ?? ".");
}

function resolveTargetFile(testRoot: string, file: string): string {
  return resolvePath(testRoot, file);
}

function relativeTestFile(testRoot: string, file: string): string {
  return importRelative(testRoot, file).split("\\").join("/");
}

function importRelative(root: string, file: string): string {
  return relative(root, file);
}

function uniqueSelectedTests(
  targets: readonly SelectedVitestTest[],
): SelectedVitestTest[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const identity = `${target.file}\0${target.name}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function compareSelectedTests(
  left: SelectedVitestTest,
  right: SelectedVitestTest,
): number {
  const fileOrder = compareStrings(left.file, right.file);
  return fileOrder === 0 ? compareStrings(left.name, right.name) : fileOrder;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
): asserts value is VitestRun {
  if (
    typeof identity !== "string" ||
    identity.length === 0 ||
    !isRecord(value) ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    !value.files.every(isNonEmptyString) ||
    (value.testRoot !== undefined && !isNonEmptyString(value.testRoot)) ||
    (value.configFile !== undefined && !isNonEmptyString(value.configFile))
  ) {
    throw new TypeError(
      "Vitest 测试运行必须提供身份、至少一个测试文件和有效选项。",
    );
  }
  if (
    value.observationKeys !== undefined &&
    (!Array.isArray(value.observationKeys) ||
      !value.observationKeys.every(isNonEmptyString) ||
      new Set(value.observationKeys).size !== value.observationKeys.length)
  ) {
    throw new TypeError("Vitest 运行的观察键必须唯一且是非空文本。");
  }
  if (value.observations !== undefined) {
    if (!isVitestObservationList(value.observations)) {
      throw new TypeError("Vitest 运行必须包含有效的观察声明。");
    }
    const keys = value.observations.map((observation) => observation.key);
    if (new Set(keys).size !== keys.length) {
      throw new TypeError("Vitest 运行的观察键必须唯一。");
    }
  }
  if (
    value.additionalTests !== undefined &&
    (!Array.isArray(value.additionalTests) ||
      !value.additionalTests.every(isVitestTestSelection))
  ) {
    throw new TypeError(
      "Vitest additionalTests 必须提供有效文件和完整测试标题。",
    );
  }
}

function isVitestTestSelection(value: unknown): value is VitestTestSelection {
  return (
    isRecord(value) &&
    isNonEmptyString(value.file) &&
    isNonEmptyString(value.name)
  );
}

function assertTestTarget(value: unknown): asserts value is VitestTestTarget {
  if (
    !isRecord(value) ||
    (value.kind !== "vitest-test-status" &&
      value.kind !== "vitest-test-observation") ||
    !isRecord(value.run) ||
    !isNonEmptyString(value.file) ||
    !isNonEmptyString(value.name)
  ) {
    throw new TypeError("Vitest 测试引用必须提供有效文件和完整测试标题。");
  }
  assertRun(value.run.identity, value.run);
  if (!Array.isArray(value.run.observationKeys)) {
    throw new TypeError("Vitest 测试运行缺少观察键列表。");
  }
  if (
    value.kind === "vitest-test-observation" &&
    (!isNonEmptyString(value.key) ||
      !value.run.observationKeys.includes(value.key))
  ) {
    throw new TypeError("Vitest 观察引用必须指向已声明的观察键。");
  }
}

function getVitestTarget(value: JsonValue): VitestTestTarget {
  assertTestTarget(value);
  return value;
}

function assertTestSelection(
  value: unknown,
): asserts value is { readonly file: string; readonly name: string } {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.file) ||
    !isNonEmptyString(value.name)
  ) {
    throw new TypeError("Vitest 状态引用必须提供有效文件和完整测试标题。");
  }
}

function vitestError(code: string, message: string): PluginResult<JsonValue> {
  return { kind: "error", error: { code, message } };
}

function assertObservationKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("观察键必须是非空文本。");
  }
}

function assertObservationDefinition(
  value: unknown,
): asserts value is AnyVitestObservation {
  if (!isVitestObservationDefinition(value)) {
    throw new TypeError("Vitest 观察必须由公开声明函数创建。");
  }
}

function isVitestObservationDefinition(
  value: unknown,
): value is AnyVitestObservation {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    value.key.length > 0 &&
    typeof value.record === "function"
  );
}

function isVitestObservationList(
  value: unknown,
): value is AnyVitestObservation[] {
  return Array.isArray(value) && value.every(isVitestObservationDefinition);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
