import { accessSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createReference,
  definePlugin,
  type ReferenceOptions,
} from "../authoring.ts";
import type {
  PluginBatchResult,
  PluginContext,
  PluginInformation,
  PluginRequest,
  PluginResult,
  Reference,
  ReferencePlugin,
  ReferenceValue,
} from "../contracts.ts";
import { canonicalJson, type JsonValue } from "../core/index.ts";
import {
  readReferenceInTest,
  recordVitestObservation,
} from "./attempt-context.ts";
import type { VitestRunResult } from "./event-mapper.ts";
import { executeVitestRun } from "./native-runner.ts";
import type {
  SelectedVitestSuite,
  SelectedVitestTest,
  VitestRunConfiguration,
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
  /** Expands native filtering targets for this run; these tests are not required to pass unless referenced. */
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
  /** Selects additional tests in run.files without requiring them to pass. */
  readonly additionalTests?: readonly VitestTestSelection[];
  /** Single observation declaration providing keys and value types; sample is not used as a default fact. */
  readonly observations?: Observations;
  readonly testRoot?: string;
  readonly configFile?: string;
};

export type VitestTestSelection = {
  /** Must belong to the test files declared for this run. */
  readonly file: string;
  /** Full native test title. */
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

/** Declares a stable observation key; sample only infers the value type and is not recorded as a default. */
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

/** Declares a typed native Vitest run; declaration does not execute tests. */
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

/** Declares a reference on the final passing status of a Vitest test. */
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

/** Binds an observation declaration to a test while preserving the recorded key and value type. */
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
      `Vitest run ${run.identity} does not declare observation key ${observation.key}.`,
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

/** Binds a native suite to a collection of observations recorded under stable keys during this run. */
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
    throw new TypeError(
      "Vitest test suite must select at least one observation.",
    );
  }
  for (const observation of observations) {
    assertObservationDefinition(observation);
    if (!run.observationKeys.includes(observation.key)) {
      throw new TypeError(
        `Vitest run ${run.identity} does not declare observation key ${observation.key}.`,
      );
    }
  }
  const keys = observations.map(({ key }) => key) as VitestSuiteTarget<
    Observations,
    Values,
    Selected
  >["observationKeys"];
  if (new Set(keys).size !== keys.length) {
    throw new TypeError("Vitest suite observation keys must be unique.");
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
      throw new TypeError("Vitest test reference does not support selection.");
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
        `Vitest run ${target.run.identity} does not declare observation key ${target.key}.`,
      );
    }
    if (
      target.kind === "vitest-suite" &&
      target.observationKeys.some(
        (key) => !target.run.observationKeys.includes(key),
      )
    ) {
      throw new TypeError(
        `Vitest suite references an observation key not declared by run ${target.run.identity}.`,
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
            `Vitest run ${target.run.identity} uses conflicting configurations within the same plugin.`,
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
      `Vitest suite file ${target.file} is not included in files for run ${target.run.identity}.`,
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
        `Vitest run declaration ${identity}: selected ${selectedReferences.length}/${references.length} reference(s); test files ${configuration.files.join(", ")}.`,
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
              `Vitest reference ${reference.id} has no matching run declaration in this batch.`,
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
      ? "native command not started"
      : command.signal !== null
        ? `native command received signal ${command.signal}`
        : command.code === 0
          ? "native command exited with code 0"
          : `native command exited with code ${command.code}`;
    const attempts = result.tests.reduce(
      (total, test) => total + test.attemptCount,
      0,
    );
    const lines = [
      `Vitest run ${prepared.identity}: ${attempts} test attempt(s); ${commandStatus}.`,
      ...result.issues.map(
        ({ code, message }) =>
          `Vitest run ${prepared.identity} (${code}): ${message}`,
      ),
      ...result.tests
        .filter((test) => test.status !== "passed")
        .map(
          (test) =>
            `Vitest test ${test.identity} (${test.status}, ${test.attemptCount} attempt(s)): ${test.message ?? "No native test error message."}`,
        ),
      ...result.tests.flatMap((test) =>
        (test.reads ?? []).map((read) => {
          const range =
            read.range === undefined
              ? ""
              : ` (${read.range.path}:${read.range.start}-${read.range.end})`;
          return `Test ${test.identity} attempt ${read.attempt} read reference ${read.referenceId}${range}: ${JSON.stringify(read.value)}`;
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
    throw new TypeError(
      "Vitest plugin is missing prepared data for the full declaration.",
    );
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
      "Vitest additionalTests must select test files listed in run.files.",
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
      // Use an empty Vitest configuration when no standard config file is present.
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
    const detail = run.issues.map((error) => error.message).join("; ");
    return {
      kind: "error",
      error: {
        code: "run-lifecycle-failed",
        message:
          detail ||
          "Native Vitest tests did not finish completely and consistently.",
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
      `Multiple native paths in the same Vitest file match test title ${target.name}.`,
    );
  }
  if (catalogMatches.length === 0) {
    return vitestError(
      "test-not-executed",
      `Declared Vitest test was not executed: ${target.file} / ${target.name}.`,
    );
  }
  const identity = catalogMatches[0]!.identity;
  const matches = run.tests.filter((test) => test.identity === identity);
  if (matches.length > 1 || matches[0]?.status === "duplicate") {
    return vitestError(
      "duplicate-test-identity",
      `Multiple tests in the same Vitest file match identity ${target.name}.`,
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
        `Final attempt of test ${target.name} did not record observation key ${target.key}.`,
      );
    }
    if (observations.length > 1) {
      return vitestError(
        "observation-duplicate",
        `Final attempt of test ${target.name} recorded duplicate observation key ${target.key}.`,
      );
    }
    return { kind: "value", value: observations[0]!.value };
  }
  if (test === undefined) {
    return vitestError(
      "test-not-executed",
      "Declared Vitest test was not found.",
    );
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
    test.message ?? `Referenced test ended with status ${test.status}.`,
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
      "Vitest did not provide a native test suite catalog.",
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
      `Multiple suites in Vitest file ${target.file} match path ${target.suitePath.join(" / ")}.`,
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
      `Declared Vitest test suite was not discovered: ${target.file} / ${target.suitePath.join(" / ")}.`,
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
                ? `Vitest did not provide an execution record for test ${entry.name}.`
                : `Test ${entry.name} matched multiple execution records.`,
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
              `Suite member ${entry.name} ended with status ${test.status}.`,
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
                  ? `Final attempt of suite member ${entry.name} has no unique observation key ${key}.`
                  : `Final attempt of suite member ${entry.name} recorded duplicate observation key ${key}.`,
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
      "Vitest test run must provide an identity, at least one test file, and valid options.",
    );
  }
  if (
    value.observationKeys !== undefined &&
    (!Array.isArray(value.observationKeys) ||
      !value.observationKeys.every(isNonEmptyString) ||
      new Set(value.observationKeys).size !== value.observationKeys.length)
  ) {
    throw new TypeError(
      "Vitest run observationKeys must be unique non-empty strings.",
    );
  }
  if (value.observations !== undefined) {
    if (!isVitestObservationList(value.observations)) {
      throw new TypeError(
        "Vitest run must provide valid observation declarations.",
      );
    }
    const keys = value.observations.map((observation) => observation.key);
    if (new Set(keys).size !== keys.length) {
      throw new TypeError("Vitest run observation keys must be unique.");
    }
  }
  if (
    value.additionalTests !== undefined &&
    (!Array.isArray(value.additionalTests) ||
      !value.additionalTests.every(isVitestTestSelection))
  ) {
    throw new TypeError(
      "Vitest additionalTests must provide valid files and full test names.",
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
    throw new TypeError(
      "Vitest test reference must provide a valid file and full test name.",
    );
  }
  assertRun(value.run.identity, value.run);
  if (!Array.isArray(value.run.observationKeys)) {
    throw new TypeError("Vitest test run is missing observationKeys.");
  }
  if (
    value.kind === "vitest-test-observation" &&
    (!isNonEmptyString(value.key) ||
      !value.run.observationKeys.includes(value.key))
  ) {
    throw new TypeError(
      "Vitest observation reference must target a declared observation key.",
    );
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
      "Vitest suite reference must provide a file, a non-empty native suitePath, and observationKeys.",
    );
  }
  assertRun(value.run.identity, value.run);
  if (!Array.isArray(value.run.observationKeys)) {
    throw new TypeError("Vitest suite run is missing observationKeys.");
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
    throw new TypeError(
      "Vitest test suite must provide a file and a non-empty native suitePath.",
    );
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
    throw new TypeError(
      "Vitest test reference must provide a valid file and full test name.",
    );
  }
}

function vitestError(code: string, message: string): PluginResult {
  return { kind: "error", error: { code, message } };
}

function assertObservationKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Observation key must be a non-empty string.");
  }
}

function assertObservationDefinition(
  value: unknown,
): asserts value is AnyVitestObservation {
  if (!isVitestObservationDefinition(value)) {
    throw new TypeError(
      "Vitest observation must be created via defineVitestObservation.",
    );
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
