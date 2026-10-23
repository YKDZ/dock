import { accessSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, createReference, definePlugin } from "@ykdz/dock";
import type {
  JsonValue,
  PluginContext,
  PluginBatchResult,
  PluginInformation,
  PluginRequest,
  PluginResult,
  Reference,
  ReferenceOptions,
  ReferencePlugin,
  ReferenceValue,
} from "@ykdz/dock";

import {
  readReferenceInTest,
  recordVitestObservation,
} from "./attempt-context.ts";
import type { VitestRunResult } from "./event-mapper.ts";
import { executeVitestRun } from "./native-runner.ts";
import type {
  VitestRunConfiguration,
  SelectedVitestSuite,
  SelectedVitestTest,
} from "./native-runner.ts";

export const vitestPluginId = "@ykdz/dock-reference-vitest" as const;

export type VitestObservation<
  Key extends string = string,
  Value extends JsonValue = JsonValue,
> = {
  readonly key: Key;
  readonly record: (value: Value) => Value;
};

type AnyVitestObservation = {
  readonly key: string;
  readonly record: (value: never) => JsonValue;
};

type ObservationKeys<
  Observations extends readonly AnyVitestObservation[],
  Values extends Record<string, JsonValue>,
> = {
  -readonly [Index in keyof Observations]: Observations[Index] extends {
    readonly key: infer Key extends string;
  }
    ? Key
    : never;
} & {
  readonly __dockTypeWitness?: {
    readonly framework: "vitest";
    readonly values: Values;
  };
};

type ObservationValues<Observations extends readonly AnyVitestObservation[]> = {
  readonly [
    Observation in Observations[number] as Observation["key"]
  ]: ObservationValue<Observation>;
};

type ObservationForValues<Values extends Record<string, JsonValue>> = {
  [Key in keyof Values & string]: VitestObservation<Key, Values[Key]>;
}[keyof Values & string];

type SuiteMemberValue<Observations extends readonly AnyVitestObservation[]> = {
  -readonly [Index in keyof Observations]: Observations[Index] extends {
    readonly key: infer Key extends string;
    readonly record: (value: never) => infer Value extends JsonValue;
  }
    ? { readonly key: Key; readonly value: Value }
    : never;
};

type ValuesFromVitestRun<Run> = Run extends {
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

export type VitestRun<
  Observations extends readonly AnyVitestObservation[] =
    readonly AnyVitestObservation[],
  Values extends Record<string, JsonValue> = ObservationValues<Observations>,
> = {
  readonly identity: string;
  readonly files: [string, ...string[]];
  /** 扩大本次原生筛选的目标；它们不是必须成功的状态引用。 */
  readonly additionalTests?: VitestTestSelection[];
  readonly testRoot?: string;
  readonly configFile?: string;
  readonly observationKeys: ObservationKeys<Observations, Values>;
};

export type VitestRunOptions<
  Observations extends readonly AnyVitestObservation[] =
    readonly AnyVitestObservation[],
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
  Observations extends readonly AnyVitestObservation[] =
    readonly AnyVitestObservation[],
  Values extends Record<string, JsonValue> = ObservationValues<Observations>,
> = {
  readonly kind: "vitest-test-status";
  readonly run: VitestRun<Observations, Values>;
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

export type VitestSuiteTarget<
  Observations extends readonly AnyVitestObservation[] =
    readonly AnyVitestObservation[],
  Values extends Record<string, JsonValue> = ObservationValues<Observations>,
  Selected extends readonly AnyVitestObservation[] =
    readonly AnyVitestObservation[],
> = {
  readonly kind: "vitest-suite";
  readonly run: VitestRun<Observations, Values>;
  readonly file: string;
  readonly suitePath: [string, ...string[]];
  readonly observationKeys: {
    -readonly [Index in keyof Selected]: Selected[Index] extends {
      readonly key: infer Key extends string;
    }
      ? Key
      : never;
  };
};

export type VitestTestTarget<
  Observations extends readonly AnyVitestObservation[] =
    readonly AnyVitestObservation[],
  Values extends Record<string, JsonValue> = ObservationValues<Observations>,
> =
  | VitestStatusTarget<Observations, Values>
  | VitestObservationTarget
  | VitestSuiteTarget<Observations, Values>;

export type VitestStatusReference<
  Id extends string = string,
  Observations extends readonly AnyVitestObservation[] =
    readonly AnyVitestObservation[],
  Values extends Record<string, JsonValue> = ObservationValues<Observations>,
> = Reference<
  typeof vitestPluginId,
  Id,
  VitestStatusTarget<Observations, Values>,
  VitestStatusValue,
  never
>;

export type VitestObservationReference<
  Id extends string = string,
  Observation extends AnyVitestObservation = AnyVitestObservation,
> = Reference<
  typeof vitestPluginId,
  Id,
  VitestObservationTarget,
  ObservationValue<Observation>,
  never
>;

export type VitestSuiteReference<
  Id extends string = string,
  Observations extends readonly AnyVitestObservation[] =
    readonly AnyVitestObservation[],
  Values extends Record<string, JsonValue> = ObservationValues<Observations>,
  Selected extends readonly AnyVitestObservation[] =
    readonly AnyVitestObservation[],
> = Reference<
  typeof vitestPluginId,
  Id,
  VitestSuiteTarget<Observations, Values, Selected>,
  SuiteMemberValue<Selected>,
  never
>;

export type VitestReference<Id extends string = string> =
  | VitestStatusReference<Id>
  | VitestObservationReference<Id>
  | VitestSuiteReference<Id>;

/** 声明稳定观察键；sample 只用于推导类型，不会作为默认观察值。 */
export function defineVitestObservation<
  const Key extends string,
  Sample extends JsonValue,
>(key: Key, sample: Sample): VitestObservation<Key, WidenJson<Sample>> {
  assertObservationKey(key);
  void sample;
  return {
    key,
    record: (value: WidenJson<Sample>): WidenJson<Sample> => {
      recordVitestObservation(key, value);
      return value;
    },
  };
}

/** 类型化地声明一次 Vitest 原生运行；声明阶段不启动测试。 */
export function defineVitestRun<
  const Observations extends readonly AnyVitestObservation[] = readonly [],
>(
  identity: string,
  options: VitestRunOptions<Observations>,
): VitestRun<Observations, ObservationValues<Observations>> {
  const observations = options.observations;
  assertRun(identity, options);
  const observationKeys = (observations ?? []).map((observation) => {
    assertObservationDefinition(observation);
    return observation.key;
  }) as ObservationKeys<Observations, ObservationValues<Observations>>;
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
  const Observations extends readonly AnyVitestObservation[],
  Values extends Record<string, JsonValue>,
>(
  id: Id,
  run: VitestRun<Observations, Values>,
  target: { readonly file: string; readonly name: string },
  options: Pick<ReferenceOptions, "declaredAt" | "note"> = {},
): VitestStatusReference<Id, Observations, Values> {
  assertRun(run.identity, run);
  assertTestSelection(target);
  return createReference<
    typeof vitestPluginId,
    Id,
    VitestStatusTarget<Observations, Values>,
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
  const Run extends VitestRun,
  const Key extends keyof ValuesFromVitestRun<Run> & string,
>(
  id: Id,
  run: Run,
  target: { readonly file: string; readonly name: string },
  observation: VitestObservation<Key, NoInfer<ValuesFromVitestRun<Run>[Key]>>,
  options: Pick<ReferenceOptions, "declaredAt" | "note"> = {},
): VitestObservationReference<
  Id,
  VitestObservation<Key, ValuesFromVitestRun<Run>[Key]>
> {
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
    ValuesFromVitestRun<Run>[Key],
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

/** 将原生测试组绑定到本次运行中按稳定键记录的观察集合。 */
export function vitestSuite<
  const Id extends string,
  const Observations extends readonly AnyVitestObservation[],
  Values extends Record<string, JsonValue>,
  const Selected extends readonly [
    ObservationForValues<Values>,
    ...ObservationForValues<Values>[],
  ],
>(
  id: Id,
  run: VitestRun<Observations, Values>,
  target: {
    readonly file: string;
    readonly suitePath: readonly [string, ...string[]];
  },
  observations: Selected,
  options: Pick<ReferenceOptions, "declaredAt" | "note"> = {},
): VitestSuiteReference<Id, Observations, Values, Selected> {
  assertRun(run.identity, run);
  assertSuiteSelection(target);
  if (observations.length === 0) {
    throw new TypeError("Vitest 测试组必须选择至少一条观察。");
  }
  for (const observation of observations) {
    assertObservationDefinition(observation);
    if (!run.observationKeys.includes(observation.key)) {
      throw new TypeError(
        `Vitest 运行 ${run.identity} 未声明观察键 ${observation.key}。`,
      );
    }
  }
  const keys = observations.map(({ key }) => key) as VitestSuiteTarget<
    Observations,
    Values,
    Selected
  >["observationKeys"];
  if (new Set(keys).size !== keys.length) {
    throw new TypeError("Vitest 测试组选择的观察键必须唯一。");
  }
  return createReference<
    typeof vitestPluginId,
    Id,
    VitestSuiteTarget<Observations, Values, Selected>,
    SuiteMemberValue<Selected>,
    never
  >(
    vitestPluginId,
    id,
    {
      kind: "vitest-suite",
      run,
      file: target.file,
      suitePath: [...target.suitePath],
      observationKeys: keys,
    },
    {
      ...(options.declaredAt === undefined
        ? {}
        : { declaredAt: options.declaredAt }),
      ...(options.note === undefined ? {} : { note: options.note }),
    },
  );
}

type VitestValue = ReferenceValue<VitestReference>;
type PreparedVitestRun = {
  identity: string;
  configuration: VitestRunConfiguration;
  referenceIds: string[];
};
type VitestPrepared = { runs: PreparedVitestRun[] };
type VitestPlugin = ReferencePlugin<
  typeof vitestPluginId,
  VitestReference,
  VitestValue,
  VitestPrepared
>;

const vitestImplementation: VitestPlugin = definePlugin({
  id: vitestPluginId,
  validate(reference: VitestReference): void {
    if (reference.selection !== undefined) {
      throw new TypeError("Vitest 测试引用不支持 selection。");
    }
    const target = getVitestTarget(reference.target);
    assertRun(target.run.identity, target.run);
    if (target.kind === "vitest-suite") {
      assertSuiteTarget(target);
    } else {
      assertTestTarget(target);
    }
    if (
      target.kind === "vitest-test-observation" &&
      !target.run.observationKeys.includes(target.key)
    ) {
      throw new TypeError(
        `Vitest 运行 ${target.run.identity} 未声明观察键 ${target.key}。`,
      );
    }
    if (
      target.kind === "vitest-suite" &&
      target.observationKeys.some(
        (key) => !target.run.observationKeys.includes(key),
      )
    ) {
      throw new TypeError(
        `Vitest 测试组引用了运行 ${target.run.identity} 未声明的观察键。`,
      );
    }
  },
  fileInfo(reference: VitestReference, context: PluginContext): string {
    const target = getVitestTarget(reference.target);
    return resolveTargetFile(
      resolveTestRoot(target.run, context.root),
      target.file,
    );
  },
  prepare(
    references: readonly VitestReference[],
    context: PluginContext,
  ): VitestPrepared {
    const runs = new Map<
      string,
      {
        readonly configuration: VitestRunConfiguration;
        readonly referenceIds: string[];
      }
    >();
    for (const reference of references) {
      const target = getVitestTarget(reference.target);
      const configuration = normalizeRun(target.run, context.root);
      assertSuiteBelongsToRun(target, configuration);
      const previous = runs.get(target.run.identity);
      if (previous !== undefined) {
        if (
          canonicalJson(previous.configuration) !== canonicalJson(configuration)
        ) {
          throw new TypeError(
            `Vitest 运行 ${target.run.identity} 在同一插件中使用了不同配置。`,
          );
        }
        previous.referenceIds.push(reference.id);
      } else {
        runs.set(target.run.identity, {
          configuration,
          referenceIds: [reference.id],
        });
      }
    }
    return {
      runs: [...runs].map(([identity, run]) => ({
        identity,
        configuration: run.configuration,
        referenceIds: run.referenceIds,
      })),
    };
  },
  describe(
    request: PluginRequest<VitestReference, VitestPrepared>,
  ): PluginInformation {
    return describeVitestRuns(request);
  },
  collect(
    request: PluginRequest<VitestReference, VitestPrepared>,
  ): Promise<PluginBatchResult<VitestValue>> {
    return collectVitestRuns(request);
  },
});

export const vitest = vitestImplementation;
export { readReferenceInTest };

type VitestCollectionRun = {
  readonly prepared: PreparedVitestRun;
  readonly selectedReferences: readonly VitestReference[];
  readonly result: VitestRunResult;
};

function assertSuiteBelongsToRun(
  target: VitestTestTarget,
  configuration: VitestRunConfiguration,
): void {
  if (
    target.kind === "vitest-suite" &&
    !configuration.files.includes(
      resolveTargetFile(configuration.testRoot, target.file),
    )
  ) {
    throw new TypeError(
      `Vitest 测试组文件 ${target.file} 不在运行 ${target.run.identity} 的 files 中。`,
    );
  }
}

function describeVitestRuns(
  request: PluginRequest<VitestReference, VitestPrepared>,
): PluginInformation {
  const prepared = requirePrepared(request);
  const selectedIds = new Set(
    request.selectedReferences.map((reference) => reference.id),
  );
  const runs = prepared.runs.map(
    ({ identity, configuration, referenceIds }) => {
      const selectedReferences = referenceIds.filter((id) =>
        selectedIds.has(id),
      );
      return {
        identity,
        configuration,
        references: [...referenceIds],
        selectedReferences,
      };
    },
  );
  return {
    data: { runs },
    text: runs.map(
      ({ identity, configuration, references, selectedReferences }) =>
        `Vitest 运行声明 ${identity}：选中 ${selectedReferences.length}/${references.length} 条引用，测试文件 ${configuration.files.join("、")}。`,
    ),
  };
}

async function collectVitestRuns(
  request: PluginRequest<VitestReference, VitestPrepared>,
): Promise<PluginBatchResult<VitestValue>> {
  const prepared = requirePrepared(request);
  const runs = await Promise.all(
    prepared.runs.flatMap((run) => {
      const referenceIds = new Set(run.referenceIds);
      const selectedReferences = request.selectedReferences.filter(
        (reference) => referenceIds.has(reference.id),
      );
      return selectedReferences.length === 0
        ? []
        : [
            collectVitestRun({
              prepared: run,
              selectedReferences,
            }),
          ];
    }),
  );
  const byReference = new Map(
    runs.flatMap((run) =>
      run.selectedReferences.map((reference) => [reference.id, run] as const),
    ),
  );
  return {
    results: request.selectedReferences.map((reference) => {
      const run = byReference.get(reference.id);
      const result =
        run === undefined
          ? vitestError(
              "prepared-run-missing",
              `Vitest 引用 ${reference.id} 没有对应的本次运行声明。`,
            )
          : factFromVitestRun(
              reference,
              run.result,
              run.prepared.configuration.testRoot,
            );
      return { referenceId: reference.id, ...result };
    }),
    diagnostics: vitestDiagnostics(runs),
  };
}

async function collectVitestRun(
  run: Pick<VitestCollectionRun, "prepared" | "selectedReferences">,
): Promise<VitestCollectionRun> {
  const { configuration } = run.prepared;
  const selectedTests: SelectedVitestTest[] = [
    ...configuration.additionalTests,
  ];
  const selectedSuites: SelectedVitestSuite[] = [];
  for (const reference of run.selectedReferences) {
    const target = getVitestTarget(reference.target);
    if (target.kind === "vitest-suite") {
      selectedSuites.push({
        file: resolveTargetFile(configuration.testRoot, target.file),
        suitePath: [...target.suitePath],
      });
    } else {
      selectedTests.push({
        file: resolveTargetFile(configuration.testRoot, target.file),
        name: target.name,
      });
    }
  }

  let result: VitestRunResult;
  try {
    result = await executeVitestRun(
      configuration,
      uniqueSelectedTests(selectedTests),
      uniqueSelectedSuites(selectedSuites),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = {
      complete: false,
      command: {
        attempted: false,
        code: null,
        signal: null,
        error: message,
      },
      tests: [],
      issues: [{ code: "vitest-runner-failed", message }],
    };
  }
  return { ...run, result };
}

function vitestDiagnostics(
  runs: readonly VitestCollectionRun[],
): PluginInformation {
  const data: JsonValue = {
    runs: runs.map(({ prepared, selectedReferences, result }) => {
      const selectedIdentities = selectedVitestTestIdentities(
        selectedReferences,
        prepared.configuration,
        result,
      );
      return {
        identity: prepared.identity,
        configuration: {
          framework: prepared.configuration.framework,
          root: prepared.configuration.root,
          testRoot: prepared.configuration.testRoot,
          files: [...prepared.configuration.files],
          additionalTests: prepared.configuration.additionalTests.map(
            ({ file, name }) => ({ file, name }),
          ),
          ...(prepared.configuration.configFile === undefined
            ? {}
            : { configFile: prepared.configuration.configFile }),
          observationKeys: [...prepared.configuration.observationKeys],
        },
        references: [...prepared.referenceIds],
        selectedReferences: selectedReferences.map(({ id }) => id),
        command: {
          attempted: result.command.attempted,
          code: result.command.code,
          signal: result.command.signal,
          ...(result.command.error === undefined
            ? {}
            : { error: result.command.error }),
        },
        testAttempts: result.tests.reduce(
          (total, test) => total + test.attemptCount,
          0,
        ),
        tests: result.tests
          .filter((test) => selectedIdentities.has(test.identity))
          .map((test) => ({
            identity: test.identity,
            status: test.status,
            attemptCount: test.attemptCount,
            ...(test.message === undefined ? {} : { message: test.message }),
          })),
        failures: result.tests
          .filter((test) => test.status !== "passed")
          .map((test) => ({
            identity: test.identity,
            status: test.status,
            attemptCount: test.attemptCount,
            ...(test.message === undefined ? {} : { message: test.message }),
          })),
        ...(result.discovery === undefined
          ? {}
          : { discoveryCompleteness: result.discovery.completeness }),
        reads: result.tests.flatMap((test) =>
          (test.reads ?? []).map((read) => ({
            testIdentity: test.identity,
            ...read,
          })),
        ),
        issues: result.issues.map(({ code, message }) => ({ code, message })),
      };
    }),
  };
  const text = runs.flatMap(({ prepared, result }) => {
    const command = result.command;
    const commandStatus = !command.attempted
      ? "未启动原生命令"
      : command.signal !== null
        ? `原生命令收到信号 ${command.signal}`
        : command.code === 0
          ? "原生命令退出成功"
          : `原生命令退出码 ${command.code}`;
    const lines = [
      `Vitest 运行 ${prepared.identity}：${result.tests.reduce((total, test) => total + test.attemptCount, 0)} 次测试尝试；${commandStatus}。`,
      ...result.issues.map(
        ({ code, message }) =>
          `Vitest 运行 ${prepared.identity}（${code}）：${message}`,
      ),
      ...result.tests
        .filter((test) => test.status !== "passed")
        .map(
          (test) =>
            `Vitest 测试 ${test.identity}（${test.status}，${test.attemptCount} 次尝试）：${test.message ?? "没有原生测试错误说明。"}`,
        ),
      ...result.tests.flatMap((test) =>
        (test.reads ?? []).map((read) => {
          const range =
            read.range === undefined
              ? ""
              : `（${read.range.path}:${read.range.start}-${read.range.end}）`;
          return `测试 ${test.identity} 第 ${read.attempt} 次读取引用 ${read.referenceId}${range}：${JSON.stringify(read.value)}`;
        }),
      ),
    ];
    return lines;
  });
  return { data, text };
}

function selectedVitestTestIdentities(
  references: readonly VitestReference[],
  configuration: VitestRunConfiguration,
  run: VitestRunResult,
): Set<string> {
  const identities = new Set<string>();
  for (const reference of references) {
    const target = getVitestTarget(reference.target);
    const file = relativeTestFile(
      configuration.testRoot,
      resolveTargetFile(configuration.testRoot, target.file),
    );
    for (const test of run.discovery?.tests ?? []) {
      if (test.file !== file) continue;
      if (
        target.kind === "vitest-suite"
          ? isWithinSuite(test.suitePath, target.suitePath)
          : flattenTestName(test.suitePath, test.name) === target.name
      ) {
        identities.add(test.identity);
      }
    }
  }
  return identities;
}

function requirePrepared(
  request: PluginRequest<VitestReference, VitestPrepared>,
): VitestPrepared {
  if (request.prepared === undefined) {
    throw new TypeError("Vitest 插件缺少本次完整声明的准备数据。");
  }
  return request.prepared;
}

function normalizeRun(run: VitestRun, root: string): VitestRunConfiguration {
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
  return {
    framework: vitestPluginId,
    root,
    testRoot,
    files,
    additionalTests,
    observationKeys: [...run.observationKeys],
    ...(configFile === undefined ? {} : { configFile }),
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
  run: VitestRunResult,
  testRoot: string,
): PluginResult<VitestValue> {
  if (!run.complete || run.issues.length > 0) {
    const detail = run.issues.map((error) => error.message).join("；");
    return {
      kind: "error",
      error: {
        code: "run-lifecycle-failed",
        message: detail || "Vitest 原生测试没有完整且一致地结束。",
      },
    };
  }

  const target = getVitestTarget(reference.target);
  if (target.kind === "vitest-suite") {
    return factFromVitestSuite(target, run, testRoot);
  }
  const targetFile = resolveTargetFile(testRoot, target.file);
  const relativeFile = relativeTestFile(testRoot, targetFile);
  const catalogMatches = (run.discovery?.tests ?? []).filter(
    (test) =>
      test.file === relativeFile &&
      flattenTestName(test.suitePath, test.name) === target.name,
  );
  if (catalogMatches.length > 1) {
    return vitestError(
      "duplicate-test-identity",
      `同一 Vitest 文件中有多个原生路径匹配测试标题 ${target.name}。`,
    );
  }
  if (catalogMatches.length === 0) {
    return vitestError(
      "test-not-executed",
      `没有执行声明的 Vitest 测试：${target.file} / ${target.name}。`,
    );
  }
  const identity = catalogMatches[0]!.identity;
  const matches = run.tests.filter((test) => test.identity === identity);
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
      ? test.attemptCount > 0
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

function factFromVitestSuite(
  target: VitestSuiteTarget,
  run: VitestRunResult,
  testRoot: string,
): PluginResult<VitestValue> {
  const catalog = run.discovery;
  if (catalog === undefined) {
    return vitestError(
      "test-catalog-missing",
      "Vitest 没有提供原生测试组目录。",
    );
  }

  const file = relativeTestFile(
    testRoot,
    resolveTargetFile(testRoot, target.file),
  );
  const suites = catalog.suites.filter(
    (suite) =>
      suite.file === file && sameStringPath(suite.path, target.suitePath),
  );
  if (suites.length > 1) {
    return vitestError(
      "duplicate-suite-identity",
      `Vitest 文件 ${target.file} 中有多个测试组匹配路径 ${target.suitePath.join(" / ")}。`,
    );
  }
  if (suites.length === 0) {
    if (catalog.completeness === "partial") {
      return {
        kind: "collection",
        collection: { completeness: "partial", members: [] },
      };
    }
    return vitestError(
      "test-group-not-found",
      `没有发现声明的 Vitest 测试组：${target.file} / ${target.suitePath.join(" / ")}。`,
    );
  }

  const members = catalog.tests
    .filter(
      (test) =>
        test.file === file && isWithinSuite(test.suitePath, target.suitePath),
    )
    .map((entry) => {
      const id = entry.identity;
      const matches = run.tests.filter(
        (test) => test.identity === entry.identity,
      );
      if (matches.length !== 1) {
        return {
          id,
          error: {
            code:
              matches.length === 0
                ? "test-execution-missing"
                : "duplicate-test-identity",
            message:
              matches.length === 0
                ? `Vitest 没有提供测试 ${entry.name} 的执行记录。`
                : `测试 ${entry.name} 对应多条执行记录。`,
          },
        } as const;
      }
      const test = matches[0]!;
      if (test.status !== "passed") {
        return {
          id,
          error: {
            code: statusErrorCode(test.status, test.attemptCount > 0),
            message:
              test.message ??
              `组成员 ${entry.name} 的最终状态为 ${test.status}。`,
          },
        } as const;
      }

      const values: { key: string; value: JsonValue }[] = [];
      for (const key of target.observationKeys) {
        const observations = (test.observations ?? []).filter(
          (observation) =>
            observation.key === key &&
            observation.attempt === test.attemptCount,
        );
        if (observations.length !== 1) {
          return {
            id,
            error: {
              code:
                observations.length === 0
                  ? "observation-missing"
                  : "observation-duplicate",
              message:
                observations.length === 0
                  ? `组成员 ${entry.name} 的最终尝试没有唯一观察键 ${key}。`
                  : `组成员 ${entry.name} 的最终尝试重复记录观察键 ${key}。`,
            },
          } as const;
        }
        values.push({ key, value: observations[0]!.value });
      }
      return { id, value: values } as const;
    });

  return {
    kind: "collection",
    collection: { completeness: catalog.completeness, members },
  };
}

function statusErrorCode(
  status: VitestRunResult["tests"][number]["status"],
  started: boolean,
): string {
  if (status === "cancelled")
    return started ? "test-cancelled" : "test-not-executed";
  if (status === "skipped") return "test-skipped";
  if (status === "todo") return "test-todo";
  if (status === "filtered") return "test-filtered";
  if (status === "duplicate") return "duplicate-test-identity";
  if (status === "not-run") return "test-not-executed";
  return "test-failed";
}

function isWithinSuite(
  suitePath: readonly string[],
  parentPath: readonly string[],
): boolean {
  return (
    suitePath.length >= parentPath.length &&
    parentPath.every((segment, index) => suitePath[index] === segment)
  );
}

function sameStringPath(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => segment === right[index])
  );
}

function flattenTestName(suitePath: readonly string[], name: string): string {
  return [...suitePath, name].join(" > ");
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

function uniqueSelectedSuites(
  suites: readonly SelectedVitestSuite[],
): SelectedVitestSuite[] {
  const seen = new Set<string>();
  return suites.filter((suite) => {
    const identity = JSON.stringify([suite.file, ...suite.suitePath]);
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

function assertTestTarget(
  value: unknown,
): asserts value is VitestStatusTarget | VitestObservationTarget {
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

function assertSuiteTarget(value: unknown): asserts value is VitestSuiteTarget {
  if (
    !isRecord(value) ||
    value.kind !== "vitest-suite" ||
    !isRecord(value.run) ||
    !isNonEmptyString(value.file) ||
    !isNonEmptyStringList(value.suitePath) ||
    value.suitePath.length === 0 ||
    !isNonEmptyStringList(value.observationKeys) ||
    value.observationKeys.length === 0 ||
    new Set(value.observationKeys).size !== value.observationKeys.length
  ) {
    throw new TypeError(
      "Vitest 测试组引用必须提供文件、非空原生路径和观察键。",
    );
  }
  assertRun(value.run.identity, value.run);
  if (!Array.isArray(value.run.observationKeys)) {
    throw new TypeError("Vitest 测试组运行缺少观察键列表。");
  }
}

function getVitestTarget(value: JsonValue): VitestTestTarget {
  if (isRecord(value) && value.kind === "vitest-suite") {
    assertSuiteTarget(value);
    return value;
  }
  assertTestTarget(value);
  return value;
}

function assertSuiteSelection(value: unknown): asserts value is {
  readonly file: string;
  readonly suitePath: readonly [string, ...string[]];
} {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.file) ||
    !isNonEmptyStringList(value.suitePath) ||
    value.suitePath.length === 0
  ) {
    throw new TypeError("Vitest 测试组必须提供文件和非空原生路径。");
  }
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

function vitestError(code: string, message: string): PluginResult {
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

function isNonEmptyStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
