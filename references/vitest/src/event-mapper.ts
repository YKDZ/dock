import { relative } from "node:path";

import type {
  ExecutionObservationRecord,
  ExecutionReadRecord,
  ExecutionRunRecord,
  ExecutionTestRecord,
  ExecutionTestStatus,
} from "@dock/sdk";

type CandidateTest = {
  readonly id: string;
  readonly status: ExecutionTestStatus;
  readonly started: boolean;
  readonly attemptCount: number;
  readonly message?: string;
  readonly observations?: readonly ExecutionObservationRecord[];
  readonly reads?: readonly ExecutionReadRecord[];
};

export type VitestCandidate = {
  readonly version: string;
  readonly completed: boolean;
  readonly tests: readonly CandidateTest[];
  readonly errors: readonly string[];
};

export type VitestReceipt = {
  readonly version: string;
  readonly closed: boolean;
  readonly candidate?: VitestCandidate;
  readonly closeErrors: readonly string[];
};

export type VitestProcessResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: string;
};

type TestModuleLike = {
  readonly moduleId?: unknown;
  readonly children?: {
    allTests?: () => Iterable<unknown>;
    allSuites?: () => Iterable<unknown>;
  };
  readonly errors?: () => readonly unknown[];
};

type TestSuiteLike = {
  readonly fullName?: unknown;
  readonly errors?: () => readonly unknown[];
};

type TestCaseLike = {
  readonly type?: unknown;
  readonly name?: unknown;
  readonly fullName?: unknown;
  readonly options?: { readonly mode?: unknown };
  result?: () => unknown;
  meta?: () => unknown;
  diagnostic?: () => unknown;
};

/** 从已完成的 Vitest 原生测试树收集候选状态，不判断关联或基线。 */
export function captureVitestCandidate(
  modulesValue: unknown,
  unhandledValue: unknown,
  reason: unknown,
  version: string,
  root: string,
): VitestCandidate {
  const errors = list(unhandledValue).map(errorMessage);
  const tests: CandidateTest[] = [];
  const modules = list(modulesValue);

  for (const moduleValue of modules) {
    if (!isRecord(moduleValue)) {
      errors.push("Vitest 返回了无法解释的测试模块记录。");
      continue;
    }
    const module = moduleValue as TestModuleLike;
    const modulePath = module.moduleId;
    if (typeof modulePath !== "string" || !isAbsolutePath(modulePath)) {
      errors.push("Vitest 返回的测试模块没有可定位的绝对路径。");
    }
    for (const error of list(safeCall(module.errors, moduleValue))) {
      errors.push(errorMessage(error));
    }

    const allSuites = safeCall(module.children?.allSuites, module.children);
    if (allSuites === undefined || !isIterable(allSuites)) {
      errors.push("Vitest 返回的测试模块没有完整测试组列表。");
    } else {
      for (const suiteValue of allSuites) {
        if (!isRecord(suiteValue)) {
          errors.push("Vitest 返回了无法解释的测试组记录。");
          continue;
        }
        const suite = suiteValue as TestSuiteLike;
        const suiteErrors = safeCall(suite.errors, suiteValue);
        if (!Array.isArray(suiteErrors)) {
          errors.push("Vitest 返回的测试组没有可解释的错误列表。");
          continue;
        }
        for (const error of suiteErrors) {
          errors.push(errorMessage(error));
        }
      }
    }

    const allTests = safeCall(module.children?.allTests, module.children);
    if (allTests === undefined || !isIterable(allTests)) {
      errors.push("Vitest 返回的测试模块没有完整测试列表。");
      continue;
    }
    for (const testValue of allTests) {
      if (!isRecord(testValue)) {
        errors.push("Vitest 返回了无法解释的测试记录。");
        continue;
      }
      const test = testValue as TestCaseLike;
      const name =
        typeof test.fullName === "string"
          ? test.fullName
          : typeof test.name === "string"
            ? test.name
            : undefined;
      if (typeof modulePath !== "string" || typeof name !== "string") {
        errors.push("Vitest 返回的测试缺少稳定文件路径或标题。");
        continue;
      }

      const file = relative(root, modulePath).split("\\").join("/");
      const result = safeCall(test.result, testValue);
      const metadata = safeCall(test.meta, testValue);
      const diagnostic = safeCall(test.diagnostic, testValue);
      const state = isRecord(result) ? result.state : undefined;
      const mode = isRecord(test.options) ? test.options.mode : undefined;
      const attemptCount = attemptCountFor(
        metadata,
        diagnostic,
        state,
        errors,
        name,
      );
      const status = finalStatus(state, mode, attemptCount);
      const activity = attemptHistory(metadata, attemptCount, errors, name);
      const message =
        status === "failed" || status === "cancelled"
          ? resultMessage(result)
          : undefined;
      tests.push({
        id: testIdentity(file, name),
        status,
        started: attemptCount > 0,
        attemptCount,
        ...(message === undefined ? {} : { message }),
        ...(activity.observations.length === 0
          ? {}
          : { observations: activity.observations }),
        ...(activity.reads.length === 0 ? {} : { reads: activity.reads }),
      });
    }
  }

  markDuplicateIdentities(tests);
  if (reason === "interrupted") {
    errors.push("Vitest 在单次测试运行完成前中断。");
  } else if (reason !== "passed" && reason !== "failed") {
    errors.push("Vitest 没有提供可解释的单次运行终态。");
  }
  return {
    version,
    completed: reason === "passed" || reason === "failed",
    tests,
    errors: uniqueMessages(errors),
  };
}

/** 将关闭后的 reporter 收据与真实子进程退出状态合并为公共记录。 */
export function mapVitestRun(
  receiptValue: unknown,
  processResult: VitestProcessResult,
): ExecutionRunRecord {
  const errors: ExecutionRunRecord["errors"][number][] = [];
  const supportedVersions = new Set(["4.1.11", "5.0.3"]);
  const receipt = parseReceipt(receiptValue);
  if (receipt === undefined) {
    errors.push({
      code: "vitest-receipt-incomplete",
      message: "Vitest 没有提供完整且结构有效的关闭收据。",
    });
  }
  if (receipt !== undefined && !supportedVersions.has(receipt.version)) {
    errors.push({
      code: "vitest-version-unsupported",
      message: `尚未验证 Vitest ${receipt.version}。`,
    });
  }
  for (const closeError of receipt?.closeErrors ?? []) {
    errors.push({
      code: "vitest-close-failed",
      message: closeError,
    });
  }
  if (processResult.signal !== null) {
    errors.push({
      code: "vitest-process-interrupted",
      message: `Vitest 进程收到信号 ${processResult.signal}。`,
    });
  }
  if (processResult.error !== undefined) {
    errors.push({
      code: "vitest-process-failed",
      message: processResult.error,
    });
  }
  const candidate = receipt?.candidate;
  if (candidate !== undefined) {
    for (const message of candidate.errors) {
      errors.push({ code: "vitest-run-incomplete", message });
    }
    if (!candidate.completed) {
      errors.push({
        code: "vitest-run-incomplete",
        message: "Vitest 测试树没有报告完整的单次运行终态。",
      });
    }
  }

  const tests: ExecutionTestRecord[] =
    candidate?.tests.map((test) => ({
      id: test.id,
      status: test.status,
      started: test.started,
      attemptCount: test.attemptCount,
      ...(test.message === undefined ? {} : { message: test.message }),
      ...(test.observations === undefined
        ? {}
        : { observations: test.observations }),
      ...(test.reads === undefined ? {} : { reads: test.reads }),
    })) ?? [];
  const hasFailedTests = tests.some((test) => test.status === "failed");
  if (processResult.code === 0 && hasFailedTests) {
    errors.push({
      code: "vitest-exit-mismatch",
      message: "Vitest 报告了失败测试，但原生进程以成功退出码结束。",
    });
  } else if (processResult.code === 1 && !hasFailedTests) {
    errors.push({
      code: "vitest-exit-unexplained",
      message:
        "Vitest 以失败退出码结束，但完整测试树中没有失败测试可解释该退出。",
    });
  } else if (
    processResult.code !== null &&
    processResult.code !== 0 &&
    processResult.code !== 1
  ) {
    errors.push({
      code: "vitest-exit-abnormal",
      message: `Vitest 进程以异常退出码 ${processResult.code} 结束。`,
    });
  } else if (processResult.code === null && processResult.signal === null) {
    errors.push({
      code: "vitest-exit-missing",
      message: "Vitest 进程没有提供退出状态。",
    });
  }

  return {
    lifecycle: errors.length === 0 ? "complete" : "incomplete",
    commandAttempts: 1,
    testExecutions: tests.reduce((total, test) => total + test.attemptCount, 0),
    tests,
    errors: uniqueExecutionErrors(errors),
    ...(processResult.code === null && processResult.signal === null
      ? {}
      : {
          commandResult: {
            exitCode: processResult.code,
            signal: processResult.signal,
          },
        }),
  };
}

function parseReceipt(value: unknown): VitestReceipt | undefined {
  if (
    !isRecord(value) ||
    typeof value.version !== "string" ||
    value.closed !== true ||
    !isStringList(value.closeErrors) ||
    !isRecord(value.candidate)
  ) {
    return undefined;
  }
  const candidate = value.candidate;
  if (
    typeof candidate.version !== "string" ||
    candidate.version !== value.version ||
    typeof candidate.completed !== "boolean" ||
    !Array.isArray(candidate.tests) ||
    !candidate.tests.every(isCandidateTest) ||
    !isStringList(candidate.errors)
  ) {
    return undefined;
  }
  return {
    version: value.version,
    closed: true,
    candidate: {
      version: candidate.version,
      completed: candidate.completed,
      tests: candidate.tests,
      errors: candidate.errors,
    },
    closeErrors: value.closeErrors,
  };
}

function isCandidateTest(value: unknown): value is CandidateTest {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    isExecutionTestStatus(value.status) &&
    typeof value.started === "boolean" &&
    isNonNegativeCount(value.attemptCount) &&
    value.started === value.attemptCount > 0 &&
    (value.message === undefined || typeof value.message === "string") &&
    (value.observations === undefined ||
      (Array.isArray(value.observations) &&
        value.observations.every(isCandidateObservation))) &&
    (value.reads === undefined ||
      (Array.isArray(value.reads) && value.reads.every(isCandidateRead)))
  );
}

function isCandidateObservation(
  value: unknown,
): value is ExecutionObservationRecord {
  return (
    isRecord(value) &&
    isPositiveCount(value.attempt) &&
    typeof value.key === "string" &&
    value.key.length > 0 &&
    Object.hasOwn(value, "value") &&
    Object.keys(value).every(
      (key) => key === "attempt" || key === "key" || key === "value",
    )
  );
}

function isCandidateRead(value: unknown): value is ExecutionReadRecord {
  return (
    isRecord(value) &&
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
    (value.range === undefined || isTextRange(value.range))
  );
}

function isTextRange(
  value: unknown,
): value is NonNullable<ExecutionReadRecord["range"]> {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    Number.isSafeInteger(value.start) &&
    Number.isSafeInteger(value.end) &&
    (value.start as number) >= 0 &&
    (value.end as number) >= (value.start as number) &&
    Object.keys(value).length === 3 &&
    Object.hasOwn(value, "path") &&
    Object.hasOwn(value, "start") &&
    Object.hasOwn(value, "end")
  );
}

function isExecutionTestStatus(value: unknown): value is ExecutionTestStatus {
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

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

export function testIdentity(file: string, name: string): string {
  return JSON.stringify({ file, name });
}

function attemptCountFor(
  metadata: unknown,
  diagnostic: unknown,
  state: unknown,
  errors: string[],
  name: string,
): number {
  const metadataCount = isRecord(metadata)
    ? metadata.dockVitestAttemptCount
    : undefined;
  const retryCount = isRecord(diagnostic) ? diagnostic.retryCount : undefined;
  const hasTerminalResult = state === "passed" || state === "failed";
  if (!isNonNegativeCount(metadataCount)) {
    if (hasTerminalResult) {
      errors.push(`测试 ${name} 缺少可验证的 setup 尝试计数。`);
    }
    return 0;
  }
  if (!hasTerminalResult) return metadataCount;
  if (metadataCount === 0) {
    errors.push(`测试 ${name} 有最终状态但没有已证明的执行尝试。`);
    return 0;
  }

  if (
    !isNonNegativeCount(retryCount) ||
    retryCount === Number.MAX_SAFE_INTEGER
  ) {
    errors.push(`测试 ${name} 缺少可验证的最终 retryCount。`);
    return metadataCount;
  }
  const resultCount = retryCount + 1;
  if (metadataCount !== resultCount) {
    errors.push(
      `测试 ${name} 的 setup 计数 ${metadataCount} 与 Vitest retryCount ${retryCount} 不一致。`,
    );
    return metadataCount;
  }
  return metadataCount;
}

function attemptHistory(
  metadata: unknown,
  attemptCount: number,
  errors: string[],
  name: string,
): {
  readonly observations: ExecutionObservationRecord[];
  readonly reads: ExecutionReadRecord[];
} {
  const attempts = isRecord(metadata) ? metadata.dockVitestAttempts : undefined;
  if (attemptCount === 0) {
    if (
      attempts !== undefined &&
      (!Array.isArray(attempts) || attempts.length > 0)
    ) {
      errors.push(`测试 ${name} 没有已证明的尝试，却包含尝试活动记录。`);
    }
    return { observations: [], reads: [] };
  }
  if (!Array.isArray(attempts) || attempts.length !== attemptCount) {
    errors.push(`测试 ${name} 的活动尝试记录数与原生开始数不一致。`);
    return { observations: [], reads: [] };
  }

  const observations: ExecutionObservationRecord[] = [];
  const reads: ExecutionReadRecord[] = [];
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    if (
      !isRecord(attempt) ||
      attempt.attempt !== index + 1 ||
      !Array.isArray(attempt.observations) ||
      !attempt.observations.every(isCandidateObservation) ||
      !Array.isArray(attempt.reads) ||
      !attempt.reads.every(isCandidateRead)
    ) {
      errors.push(`测试 ${name} 的第 ${index + 1} 次活动记录无效。`);
      continue;
    }
    observations.push(...attempt.observations);
    reads.push(...attempt.reads);
  }
  return { observations, reads };
}

function finalStatus(
  state: unknown,
  mode: unknown,
  attemptCount: number,
): ExecutionTestStatus {
  if (mode === "todo") return "todo";
  if (state === "passed") return "passed";
  if (state === "failed") return "failed";
  if (state === "skipped") return "skipped";
  if (state === "cancelled" || state === "interrupted") return "cancelled";
  if (attemptCount > 0) return "cancelled";
  if (mode === "skip") return "skipped";
  return "not-run";
}

function resultMessage(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.errors)) return undefined;
  const messages = result.errors.map(errorMessage);
  return messages.length === 0 ? undefined : messages.join("；");
}

function markDuplicateIdentities(tests: CandidateTest[]): void {
  const counts = new Map<string, number>();
  for (const test of tests) {
    counts.set(test.id, (counts.get(test.id) ?? 0) + 1);
  }
  for (let index = 0; index < tests.length; index += 1) {
    const test = tests[index];
    if (test !== undefined && (counts.get(test.id) ?? 0) > 1) {
      tests[index] = { ...test, status: "duplicate" };
    }
  }
}

function uniqueMessages(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueExecutionErrors(
  values: readonly ExecutionRunRecord["errors"][number][],
): ExecutionRunRecord["errors"][number][] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.code}\0${value.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeCall(method: unknown, owner: unknown): unknown {
  if (typeof method !== "function") return undefined;
  try {
    return method.call(owner);
  } catch {
    return undefined;
  }
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (isRecord(value) && typeof value.message === "string") {
    return value.message;
  }
  return String(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    typeof value === "object" && value !== null && Symbol.iterator in value
  );
}

function isNonNegativeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isPositiveCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}
