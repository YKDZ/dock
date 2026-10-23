import { copyJsonValue, isJsonValue } from "@ykdz/dock-core";
import type {
  JsonValue,
  MemberDiscoveryCompleteness,
  TextRange,
} from "@ykdz/dock-core";

import type { ExecutedRun, ExecutionView } from "./contracts.ts";
import type { ResolvedOperation } from "./resolution.ts";

/** 框架中一条测试用例的终态。 */
export type ExecutionTestStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "todo"
  | "filtered"
  | "cancelled"
  | "not-run"
  | "duplicate";

export type ExecutionTestRecord = {
  readonly id: string;
  readonly status: ExecutionTestStatus;
  readonly started: boolean;
  readonly attemptCount: number;
  readonly message?: string;
  readonly observations?: readonly ExecutionObservationRecord[];
  readonly reads?: readonly ExecutionReadRecord[];
};

/** 测试执行器在本次运行中发现的测试组与测试路径。 */
export type ExecutionTestCatalog = {
  readonly completeness: MemberDiscoveryCompleteness;
  readonly suites: readonly {
    readonly file: string;
    readonly path: readonly string[];
  }[];
  readonly tests: readonly {
    /** 对应 ExecutionTestRecord.id；沿用测试执行器现有身份。 */
    readonly executionId: string;
    readonly file: string;
    readonly suitePath: readonly string[];
    readonly name: string;
  }[];
};

/** 由活动测试按稳定键记录的一条业务观察。 */
export type ExecutionObservationRecord = {
  /** 本次测试中实际写入该观察的 1 起始尝试序号。 */
  readonly attempt: number;
  readonly key: string;
  readonly value: JsonValue;
};

/** 由活动测试取得的一条当前引用读取，仅用于采集事实与诊断。 */
export type ExecutionReadRecord = {
  /** 本次测试中实际读取该引用的 1 起始尝试序号。 */
  readonly attempt: number;
  readonly referenceId: string;
  readonly value: JsonValue;
  readonly range?: TextRange;
};

/** 面向维护报告的读取诊断，保留产生事实的执行与测试归属。 */
export type ExecutionReadDiagnostic = ExecutionReadRecord & {
  readonly runId: string;
  readonly testId: string;
};

/** 一次框架运行的通用记录，不解释框架事件或测试选择语义。 */
export type ExecutionRunRecord = {
  readonly lifecycle: "complete" | "incomplete";
  readonly commandAttempts: number;
  readonly testExecutions: number;
  readonly tests: readonly ExecutionTestRecord[];
  /** 声明成员发现与测试是否执行分开记录；没有发现能力的执行器可省略。 */
  readonly testCatalog?: ExecutionTestCatalog;
  readonly errors: readonly {
    readonly code: string;
    readonly message: string;
  }[];
  readonly commandResult?: {
    readonly exitCode: number | null;
    readonly signal: string | null;
  };
};

export type ExecutionSummary = {
  readonly commandAttempts: number;
  readonly failedCommands: number;
  readonly testExecutions: number;
  readonly reads?: readonly ExecutionReadDiagnostic[];
};

export interface ExecutionSession {
  run(): Promise<void>;
  view(pluginId: string): ExecutionView;
  summary(): ExecutionSummary | undefined;
}

type StoredRun = ExecutedRun & { readonly pluginId: string };

/** 执行会话只消费完整预检已确定的声明，不接受再次登记。 */
export function createExecutionSession(
  resolved: ResolvedOperation,
): ExecutionSession {
  const runs = new Map<string, StoredRun>();
  let finished = false;
  let runPromise: Promise<void> | undefined;
  const context = Object.freeze({ root: resolved.model.root });
  const references = new Map(
    resolved.runtime.references.map((reference) => [reference.id, reference]),
  );

  return {
    async run(): Promise<void> {
      runPromise ??= runSelected();
      await runPromise;
    },
    view(pluginId): ExecutionView {
      return Object.freeze({
        get(identity: string): ExecutedRun | undefined {
          if (!finished) return undefined;
          const stored = runs.get(identity);
          return stored === undefined || stored.pluginId !== pluginId
            ? undefined
            : {
                declaration: stored.declaration,
                record: cloneRecord(stored.record),
              };
        },
      });
    },
    summary(): ExecutionSummary | undefined {
      if (!finished || runs.size === 0) return undefined;
      let commandAttempts = 0;
      let failedCommands = 0;
      let testExecutions = 0;
      const reads: ExecutionReadDiagnostic[] = [];
      for (const [runId, { record }] of runs) {
        commandAttempts += record.commandAttempts;
        if (
          record.commandResult !== undefined &&
          (record.commandResult.exitCode !== 0 ||
            record.commandResult.signal !== null)
        ) {
          failedCommands += 1;
        }
        testExecutions += record.testExecutions;
        for (const test of record.tests) {
          for (const read of test.reads ?? []) {
            reads.push({ runId, testId: test.id, ...cloneReadRecord(read) });
          }
        }
      }
      return {
        commandAttempts,
        failedCommands,
        testExecutions,
        ...(reads.length === 0 ? {} : { reads }),
      };
    },
  };

  async function runSelected(): Promise<void> {
    await Promise.all(
      resolved.model.runs
        .filter((run) => run.selectedReferences.length > 0)
        .map(async (run) => {
          const plugin = resolved.runtime.plugins.get(run.pluginId)!;
          const declaration = Object.freeze({
            identity: run.identity,
            configuration: run.configuration,
            references: run.references,
          });
          const selectedReferences = Object.freeze(
            run.selectedReferences.map((id) => references.get(id)!),
          );
          let record: ExecutionRunRecord;
          try {
            record = validateExecutionRunRecord(
              await plugin.execution!.execute(
                { declaration, selectedReferences },
                context,
              ),
            );
          } catch (error) {
            record = incompleteRecord(
              "execution-failed",
              error instanceof Error ? error.message : String(error),
            );
          }
          runs.set(run.identity, {
            pluginId: run.pluginId,
            declaration,
            record,
          });
        }),
    );
    finished = true;
  }
}

function validateExecutionRunRecord(value: unknown): ExecutionRunRecord {
  if (!isRecord(value)) return invalidRecord();
  if (
    (value.lifecycle !== "complete" && value.lifecycle !== "incomplete") ||
    !isCount(value.commandAttempts) ||
    !isCount(value.testExecutions) ||
    !Array.isArray(value.tests) ||
    !Array.isArray(value.errors) ||
    (value.commandResult !== undefined &&
      (!isCommandResult(value.commandResult) || value.commandAttempts === 0))
  ) {
    return invalidRecord();
  }
  if (
    value.testCatalog !== undefined &&
    !isExecutionTestCatalog(value.testCatalog)
  ) {
    return invalidRecord();
  }

  const tests: ExecutionTestRecord[] = [];
  for (const test of value.tests) {
    const attemptCount = isRecord(test) ? test.attemptCount : undefined;
    if (
      !isRecord(test) ||
      typeof test.id !== "string" ||
      test.id.length === 0 ||
      !isTestStatus(test.status) ||
      typeof test.started !== "boolean" ||
      !isCount(attemptCount) ||
      test.started !== attemptCount > 0 ||
      (test.message !== undefined && typeof test.message !== "string") ||
      (test.observations !== undefined && !isDenseArray(test.observations)) ||
      (test.reads !== undefined && !isDenseArray(test.reads))
    ) {
      return invalidRecord();
    }
    const observations = test.observations ?? [];
    const reads = test.reads ?? [];
    if (
      !observations.every(isObservationRecord) ||
      !reads.every(isReadRecord)
    ) {
      return invalidRecord();
    }
    if (
      observations.some((observation) => observation.attempt > attemptCount) ||
      reads.some((read) => read.attempt > attemptCount)
    ) {
      return invalidRecord();
    }
    tests.push({
      id: test.id,
      status: test.status,
      started: test.started,
      attemptCount,
      ...(test.message === undefined ? {} : { message: test.message }),
      ...(test.observations === undefined
        ? {}
        : { observations: observations.map(cloneObservationRecord) }),
      ...(test.reads === undefined
        ? {}
        : { reads: reads.map(cloneReadRecord) }),
    });
  }

  const errors: { code: string; message: string }[] = [];
  for (const error of value.errors) {
    if (
      !isRecord(error) ||
      typeof error.code !== "string" ||
      error.code.length === 0 ||
      typeof error.message !== "string"
    ) {
      return invalidRecord();
    }
    errors.push({ code: error.code, message: error.message });
  }

  if (
    value.testExecutions !==
    tests.reduce((total, test) => total + test.attemptCount, 0)
  ) {
    return invalidRecord();
  }

  return {
    lifecycle: value.lifecycle,
    commandAttempts: value.commandAttempts,
    testExecutions: value.testExecutions,
    tests,
    ...(value.testCatalog === undefined
      ? {}
      : { testCatalog: cloneExecutionTestCatalog(value.testCatalog) }),
    errors,
    ...(value.commandResult === undefined
      ? {}
      : {
          commandResult: {
            exitCode: value.commandResult.exitCode,
            signal: value.commandResult.signal,
          },
        }),
  };
}

function incompleteRecord(code: string, message: string): ExecutionRunRecord {
  return {
    lifecycle: "incomplete",
    commandAttempts: 0,
    testExecutions: 0,
    tests: [],
    errors: [{ code, message }],
  };
}

function invalidRecord(): ExecutionRunRecord {
  return incompleteRecord(
    "invalid-execution-record",
    "插件返回的执行记录不符合宿主公开契约。",
  );
}

function cloneRecord(record: ExecutionRunRecord): ExecutionRunRecord {
  return {
    ...record,
    tests: record.tests.map((test) => ({
      ...test,
      ...(test.observations === undefined
        ? {}
        : { observations: test.observations.map(cloneObservationRecord) }),
      ...(test.reads === undefined
        ? {}
        : { reads: test.reads.map(cloneReadRecord) }),
    })),
    ...(record.testCatalog === undefined
      ? {}
      : { testCatalog: cloneExecutionTestCatalog(record.testCatalog) }),
    errors: record.errors.map((error) => ({ ...error })),
    ...(record.commandResult === undefined
      ? {}
      : { commandResult: { ...record.commandResult } }),
  };
}

function isExecutionTestCatalog(value: unknown): value is ExecutionTestCatalog {
  return (
    isRecord(value) &&
    (value.completeness === "complete" || value.completeness === "partial") &&
    isDenseArray(value.suites) &&
    value.suites.every(
      (suite) =>
        isRecord(suite) &&
        isNonEmptyString(suite.file) &&
        isStringPath(suite.path) &&
        suite.path.length > 0,
    ) &&
    isDenseArray(value.tests) &&
    value.tests.every(
      (test) =>
        isRecord(test) &&
        isNonEmptyString(test.executionId) &&
        isNonEmptyString(test.file) &&
        isStringPath(test.suitePath) &&
        isNonEmptyString(test.name),
    )
  );
}

function cloneExecutionTestCatalog(
  catalog: ExecutionTestCatalog,
): ExecutionTestCatalog {
  return {
    completeness: catalog.completeness,
    suites: catalog.suites.map((suite) => ({
      file: suite.file,
      path: [...suite.path],
    })),
    tests: catalog.tests.map((test) => ({
      executionId: test.executionId,
      file: test.file,
      suitePath: [...test.suitePath],
      name: test.name,
    })),
  };
}

function isObservationRecord(
  value: unknown,
): value is ExecutionObservationRecord {
  return (
    isRecord(value) &&
    isJsonValue(value) &&
    isPositiveCount(value.attempt) &&
    typeof value.key === "string" &&
    value.key.length > 0 &&
    Object.hasOwn(value, "value") &&
    Object.keys(value).every(
      (key) => key === "attempt" || key === "key" || key === "value",
    ) &&
    isJsonValue(value.value)
  );
}

function isReadRecord(value: unknown): value is ExecutionReadRecord {
  return (
    isRecord(value) &&
    isJsonValue(value) &&
    isPositiveCount(value.attempt) &&
    typeof value.referenceId === "string" &&
    value.referenceId.length > 0 &&
    Object.hasOwn(value, "value") &&
    Object.keys(value).every(
      (key) =>
        key === "attempt" ||
        key === "referenceId" ||
        key === "value" ||
        key === "range",
    ) &&
    isJsonValue(value.value) &&
    (!Object.hasOwn(value, "range") || isTextRange(value.range))
  );
}

function isTextRange(value: unknown): value is TextRange {
  return (
    isRecord(value) &&
    isJsonValue(value) &&
    typeof value.path === "string" &&
    Number.isSafeInteger(value.start) &&
    Number.isSafeInteger(value.end) &&
    (value.start as number) >= 0 &&
    (value.end as number) >= (value.start as number) &&
    Object.keys(value).every((key) => ["path", "start", "end"].includes(key)) &&
    Object.hasOwn(value, "path") &&
    Object.hasOwn(value, "start") &&
    Object.hasOwn(value, "end")
  );
}

function isDenseArray(value: unknown): value is unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(value).length !== value.length ||
    Object.getOwnPropertyNames(value).length !== value.length + 1
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) return false;
  }
  return true;
}

function cloneObservationRecord(
  record: ExecutionObservationRecord,
): ExecutionObservationRecord {
  return {
    attempt: record.attempt,
    key: record.key,
    value: copyJsonValue(record.value),
  };
}

function cloneReadRecord(record: ExecutionReadRecord): ExecutionReadRecord {
  return {
    attempt: record.attempt,
    referenceId: record.referenceId,
    value: copyJsonValue(record.value),
    ...(record.range === undefined ? {} : { range: { ...record.range } }),
  };
}

function isPositiveCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function isCommandResult(
  value: unknown,
): value is NonNullable<ExecutionRunRecord["commandResult"]> {
  return (
    isRecord(value) &&
    (value.exitCode === null ||
      (typeof value.exitCode === "number" &&
        Number.isSafeInteger(value.exitCode) &&
        value.exitCode >= 0)) &&
    (value.signal === null ||
      (typeof value.signal === "string" && value.signal.length > 0)) &&
    !(value.exitCode !== null && value.signal !== null) &&
    (value.exitCode !== null || value.signal !== null)
  );
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringPath(value: unknown): value is string[] {
  return isDenseArray(value) && value.every(isNonEmptyString);
}

function isTestStatus(value: unknown): value is ExecutionTestStatus {
  return (
    value === "passed" ||
    value === "failed" ||
    value === "skipped" ||
    value === "todo" ||
    value === "filtered" ||
    value === "cancelled" ||
    value === "not-run" ||
    value === "duplicate"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
