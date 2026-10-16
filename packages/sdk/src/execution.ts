import type { JsonValue, TextRange } from "@dock/core";

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

/** 由活动测试按稳定键记录的一条业务观察。 */
export type ExecutionObservationRecord = {
  readonly key: string;
  readonly value: JsonValue;
};

/** 由活动测试取得的一条当前引用读取，仅用于采集事实与诊断。 */
export type ExecutionReadRecord = {
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

export type ExecutionCallback = () =>
  | ExecutionRunRecord
  | Promise<ExecutionRunRecord>;

/** 插件在准备阶段登记执行，在采集阶段读取同一次操作的记录。 */
export interface ExecutionRegistry {
  register(
    identity: string,
    configuration: JsonValue,
    execute: ExecutionCallback,
  ): void;
  get(identity: string): ExecutionRunRecord | undefined;
}

export interface ExecutionSession extends ExecutionRegistry {
  /** 完成冲突预检后启动各个唯一运行；每个维护操作只能调用一次。 */
  run(): Promise<void>;
  summary(): ExecutionSummary | undefined;
}

type Registration = {
  readonly identity: string;
  readonly encodedConfiguration: string;
  readonly execute: ExecutionCallback;
};

type StoredRun = {
  readonly record: ExecutionRunRecord;
  readonly encodedConfiguration: string;
};

/** 创建仅属于一次 check 或 baseline update 的公开执行会话。 */
export function createExecutionSession(): ExecutionSession {
  const registrations: Registration[] = [];
  const runs = new Map<string, StoredRun>();
  let phase: "registering" | "running" | "finished" = "registering";
  let runPromise: Promise<void> | undefined;

  return {
    register(identity, configuration, execute): void {
      if (phase !== "registering") {
        throw new TypeError("执行登记只能在采集开始前完成。");
      }
      if (typeof identity !== "string" || identity.length === 0) {
        throw new TypeError("执行身份必须是非空文本。");
      }
      if (!isJsonConfiguration(configuration)) {
        throw new TypeError(`执行 ${identity} 的配置必须是有效 JSON 值。`);
      }
      if (typeof execute !== "function") {
        throw new TypeError(`执行 ${identity} 必须提供运行函数。`);
      }
      registrations.push({
        identity,
        encodedConfiguration: canonicalJson(configuration),
        execute,
      });
    },

    get(identity): ExecutionRunRecord | undefined {
      if (phase !== "finished") return undefined;
      const stored = runs.get(identity);
      return stored === undefined ? undefined : cloneRecord(stored.record);
    },

    async run(): Promise<void> {
      if (runPromise !== undefined) return await runPromise;
      if (phase !== "registering") {
        throw new TypeError("执行会话已经结束。");
      }
      phase = "running";
      runPromise = runRegistered();
      await runPromise;
    },

    summary(): ExecutionSummary | undefined {
      if (phase !== "finished" || runs.size === 0) return undefined;
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

  async function runRegistered(): Promise<void> {
    const byIdentity = new Map<string, Registration[]>();
    for (const registration of registrations) {
      const group = byIdentity.get(registration.identity) ?? [];
      group.push(registration);
      byIdentity.set(registration.identity, group);
    }

    const pending: Registration[] = [];
    for (const [identity, group] of byIdentity) {
      const configurations = new Set(
        group.map((registration) => registration.encodedConfiguration),
      );
      if (configurations.size > 1) {
        runs.set(identity, {
          encodedConfiguration: "",
          record: incompleteRecord(
            "execution-identity-conflict",
            `执行身份 ${identity} 对应多个不同配置。`,
          ),
        });
      } else {
        pending.push(group[0]!);
      }
    }

    // 此时所有身份和配置冲突都已判定，之后才可能启动任何执行回调。
    await Promise.all(
      pending.map(async ({ identity, encodedConfiguration, execute }) => {
        let record: ExecutionRunRecord;
        try {
          record = validateExecutionRunRecord(await execute());
        } catch (error) {
          record = incompleteRecord(
            "execution-failed",
            error instanceof Error ? error.message : String(error),
          );
        }
        runs.set(identity, { encodedConfiguration, record });
      }),
    );
    phase = "finished";
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

  const tests: ExecutionTestRecord[] = [];
  for (const test of value.tests) {
    if (
      !isRecord(test) ||
      typeof test.id !== "string" ||
      test.id.length === 0 ||
      !isTestStatus(test.status) ||
      typeof test.started !== "boolean" ||
      !isCount(test.attemptCount) ||
      test.started !== test.attemptCount > 0 ||
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
    tests.push({
      id: test.id,
      status: test.status,
      started: test.started,
      attemptCount: test.attemptCount,
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
    "插件返回的执行记录不符合 SDK 公开契约。",
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
    errors: record.errors.map((error) => ({ ...error })),
    ...(record.commandResult === undefined
      ? {}
      : { commandResult: { ...record.commandResult } }),
  };
}

function isObservationRecord(
  value: unknown,
): value is ExecutionObservationRecord {
  return (
    isRecord(value) &&
    isJsonConfiguration(value) &&
    typeof value.key === "string" &&
    value.key.length > 0 &&
    Object.hasOwn(value, "value") &&
    Object.keys(value).every((key) => key === "key" || key === "value") &&
    isJsonConfiguration(value.value)
  );
}

function isReadRecord(value: unknown): value is ExecutionReadRecord {
  return (
    isRecord(value) &&
    isJsonConfiguration(value) &&
    typeof value.referenceId === "string" &&
    value.referenceId.length > 0 &&
    Object.hasOwn(value, "value") &&
    Object.keys(value).every(
      (key) => key === "referenceId" || key === "value" || key === "range",
    ) &&
    isJsonConfiguration(value.value) &&
    (!Object.hasOwn(value, "range") || isTextRange(value.range))
  );
}

function isTextRange(value: unknown): value is TextRange {
  return (
    isRecord(value) &&
    isJsonConfiguration(value) &&
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
  return { key: record.key, value: cloneJsonValue(record.value) };
}

function cloneReadRecord(record: ExecutionReadRecord): ExecutionReadRecord {
  return {
    referenceId: record.referenceId,
    value: cloneJsonValue(record.value),
    ...(record.range === undefined ? {} : { range: { ...record.range } }),
  };
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneJsonValue(entry)]),
  );
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

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function isJsonConfiguration(
  value: unknown,
  active = new Set<object>(),
): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (active.has(value)) return false;
  active.add(value);
  let valid: boolean;
  if (Array.isArray(value)) {
    valid =
      Object.getOwnPropertySymbols(value).length === 0 &&
      Object.keys(value).length === value.length;
    for (let index = 0; valid && index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      valid =
        descriptor !== undefined &&
        "value" in descriptor &&
        isJsonConfiguration(descriptor.value, active);
    }
  } else {
    const prototype = Object.getPrototypeOf(value) as unknown;
    valid =
      (prototype === Object.prototype || prototype === null) &&
      Object.getOwnPropertySymbols(value).length === 0 &&
      Object.getOwnPropertyNames(value).length === Object.keys(value).length;
    for (const key of Object.keys(value)) {
      if (!valid) break;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      valid =
        descriptor !== undefined &&
        "value" in descriptor &&
        isJsonConfiguration(descriptor.value, active);
    }
  }
  active.delete(value);
  return valid;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
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
