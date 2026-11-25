import { relative, resolve } from "node:path";

import { isJsonValue, type JsonValue, type TextRange } from "@dock/core";

type VitestTestStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "todo"
  | "filtered"
  | "cancelled"
  | "not-run"
  | "duplicate";

/** Business observation attributed to a specific Vitest attempt (`attempt`); only the final passing attempt supplies the checked fact. */
export type VitestObservationRecord = {
  readonly attempt: number;
  readonly key: string;
  readonly value: JsonValue;
};

/** Reference read recorded during a specific Vitest attempt (`attempt`) to explain what value and range the test observed across retries. */
export type VitestReadRecord = {
  readonly attempt: number;
  readonly referenceId: string;
  readonly value: JsonValue;
  readonly range?: TextRange;
};

/** Single test record mapped from Vitest attempts; `attemptCount`, `observations`, and `reads` explain retry outcomes and missing observations. */
type VitestTestRecord = {
  readonly identity: string;
  readonly status: VitestTestStatus;
  readonly attemptCount: number;
  readonly message?: string;
  readonly observations?: readonly VitestObservationRecord[];
  readonly reads?: readonly VitestReadRecord[];
};

type VitestTestCatalog = {
  readonly completeness: "complete" | "partial";
  readonly suites: readonly {
    readonly file: string;
    readonly path: string[];
  }[];
  readonly tests: readonly {
    readonly identity: string;
    readonly file: string;
    readonly suitePath: string[];
    readonly name: string;
  }[];
};

type VitestIssue = {
  readonly code: string;
  readonly message: string;
};

export type VitestCandidate = {
  readonly version: string;
  readonly completed: boolean;
  readonly tests: readonly VitestTestRecord[];
  readonly catalog: VitestTestCatalog;
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
  readonly signal: string | null;
  readonly error?: string;
};

/** Local interpretation of native Vitest records; not part of the public host execution contract. */
export type VitestRunResult = {
  readonly complete: boolean;
  readonly command: VitestProcessResult & { readonly attempted: boolean };
  readonly tests: readonly VitestTestRecord[];
  readonly discovery?: VitestTestCatalog;
  readonly issues: readonly VitestIssue[];
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
  readonly name?: unknown;
  readonly type?: unknown;
  readonly suite?: unknown;
  readonly parent?: unknown;
  readonly errors?: () => readonly unknown[];
};

type TestCaseLike = {
  readonly type?: unknown;
  readonly name?: unknown;
  readonly fullName?: unknown;
  readonly suite?: unknown;
  readonly parent?: unknown;
  readonly options?: { readonly mode?: unknown };
  result?: () => unknown;
  meta?: () => unknown;
  diagnostic?: () => unknown;
};

/** Collects candidate test state from the completed native Vitest tree without evaluating bindings or baselines. */
export function captureVitestCandidate(
  modulesValue: unknown,
  unhandledValue: unknown,
  reason: unknown,
  version: string,
  root: string,
  requestedFiles: readonly string[] = [],
): VitestCandidate {
  const errors = list(unhandledValue).map(errorMessage);
  const tests: VitestTestRecord[] = [];
  const catalogSuites: VitestTestCatalog["suites"][number][] = [];
  const catalogTests: VitestTestCatalog["tests"][number][] = [];
  const modules = list(modulesValue);
  const discoveredFiles = new Set<string>();
  let catalogComplete =
    errors.length === 0 && (reason === "passed" || reason === "failed");

  for (const moduleValue of modules) {
    if (!isRecord(moduleValue)) {
      errors.push("Vitest returned an unreadable test module record.");
      catalogComplete = false;
      continue;
    }
    const module = moduleValue as TestModuleLike;
    const modulePath = module.moduleId;
    if (typeof modulePath !== "string" || !isAbsolutePath(modulePath)) {
      errors.push(
        "Vitest returned a test module without a resolvable absolute path.",
      );
      catalogComplete = false;
    } else {
      discoveredFiles.add(resolve(modulePath));
    }
    const moduleErrors = list(safeCall(module.errors, moduleValue));
    for (const error of moduleErrors) {
      errors.push(errorMessage(error));
    }
    if (moduleErrors.length > 0) catalogComplete = false;

    const allSuites = safeCall(module.children?.allSuites, module.children);
    if (allSuites === undefined || !isIterable(allSuites)) {
      errors.push(
        "Vitest returned a test module without a complete suite list.",
      );
      catalogComplete = false;
    } else {
      for (const suiteValue of allSuites) {
        if (!isRecord(suiteValue)) {
          errors.push("Vitest returned an unreadable test suite record.");
          catalogComplete = false;
          continue;
        }
        const suite = suiteValue as TestSuiteLike;
        const suitePath = nativeSuitePath(suiteValue, true);
        if (
          typeof modulePath !== "string" ||
          suite.type !== "suite" ||
          typeof suite.name !== "string" ||
          suite.name.length === 0 ||
          suitePath === undefined
        ) {
          errors.push(
            "Vitest returned a test suite without a reconstructible native parent/name path.",
          );
          catalogComplete = false;
        } else {
          catalogSuites.push({
            file: relative(root, modulePath).split("\\").join("/"),
            path: suitePath,
          });
        }
        const suiteErrors = safeCall(suite.errors, suiteValue);
        if (!Array.isArray(suiteErrors)) {
          errors.push(
            "Vitest returned a test suite without a readable error list.",
          );
          catalogComplete = false;
          continue;
        }
        for (const error of suiteErrors) {
          errors.push(errorMessage(error));
          catalogComplete = false;
        }
      }
    }

    const allTests = safeCall(module.children?.allTests, module.children);
    if (allTests === undefined || !isIterable(allTests)) {
      errors.push(
        "Vitest returned a test module without a complete test list.",
      );
      catalogComplete = false;
      continue;
    }
    for (const testValue of allTests) {
      if (!isRecord(testValue)) {
        errors.push("Vitest returned an unreadable test record.");
        catalogComplete = false;
        continue;
      }
      const test = testValue as TestCaseLike;
      const fullName =
        typeof test.fullName === "string"
          ? test.fullName
          : typeof test.name === "string"
            ? test.name
            : undefined;
      const name = typeof test.name === "string" ? test.name : undefined;
      const suitePath = nativeSuitePath(testValue, false);
      if (
        typeof modulePath !== "string" ||
        typeof fullName !== "string" ||
        typeof name !== "string" ||
        name.length === 0 ||
        suitePath === undefined
      ) {
        errors.push(
          "Vitest returned a test without a stable file path or title.",
        );
        catalogComplete = false;
        continue;
      }

      const file = relative(root, modulePath).split("\\").join("/");
      const identity = testIdentity(file, suitePath, name);
      catalogTests.push({ identity, file, suitePath, name });
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
        identity,
        status,
        attemptCount,
        ...(message === undefined ? {} : { message }),
        ...(activity.observations.length === 0
          ? {}
          : { observations: activity.observations }),
        ...(activity.reads.length === 0 ? {} : { reads: activity.reads }),
      });
    }
  }

  for (const requestedFile of requestedFiles) {
    if (!discoveredFiles.has(resolve(requestedFile))) {
      errors.push(
        `Vitest did not return declared file ${requestedFile} in native discovery results.`,
      );
      catalogComplete = false;
    }
  }

  markDuplicateIdentities(tests);
  if (reason === "interrupted") {
    errors.push(
      "Vitest was interrupted before completing the single test run.",
    );
  } else if (reason !== "passed" && reason !== "failed") {
    errors.push(
      "Vitest did not report an interpretable terminal state for the single run.",
    );
  }
  return {
    version,
    completed: reason === "passed" || reason === "failed",
    tests,
    catalog: {
      completeness: catalogComplete ? "complete" : "partial",
      suites: catalogSuites,
      tests: catalogTests,
    },
    errors: uniqueMessages(errors),
  };
}

/** Merges the Vitest reporter receipt with the child process exit status into local run evidence. */
export function mapVitestRun(
  receiptValue: unknown,
  processResult: VitestProcessResult,
): VitestRunResult {
  const issues: VitestIssue[] = [];
  const supportedVersions = new Set(["4.1.11", "5.0.3"]);
  const receipt = parseReceipt(receiptValue);
  if (receipt === undefined) {
    issues.push({
      code: "vitest-receipt-incomplete",
      message:
        "Vitest did not produce a complete, structurally valid close receipt.",
    });
  }
  if (receipt !== undefined && !supportedVersions.has(receipt.version)) {
    issues.push({
      code: "vitest-version-unsupported",
      message: `Vitest ${receipt.version} has not been verified.`,
    });
  }
  for (const closeError of receipt?.closeErrors ?? []) {
    issues.push({
      code: "vitest-close-failed",
      message: closeError,
    });
  }
  if (processResult.signal !== null) {
    issues.push({
      code: "vitest-process-interrupted",
      message: `Vitest process received signal ${processResult.signal}.`,
    });
  }
  if (processResult.error !== undefined) {
    issues.push({
      code: "vitest-process-failed",
      message: processResult.error,
    });
  }
  const candidate = receipt?.candidate;
  if (candidate !== undefined) {
    for (const message of candidate.errors) {
      issues.push({ code: "vitest-run-incomplete", message });
    }
    if (!candidate.completed) {
      issues.push({
        code: "vitest-run-incomplete",
        message:
          "Vitest test tree did not report a complete terminal state for the single run.",
      });
    }
  }

  const tests = candidate?.tests ?? [];
  const hasFailedTests = tests.some((test) => test.status === "failed");
  if (processResult.code === 0 && hasFailedTests) {
    issues.push({
      code: "vitest-exit-mismatch",
      message:
        "Vitest reported failed tests, but the native process exited with code 0.",
    });
  } else if (processResult.code === 1 && !hasFailedTests) {
    issues.push({
      code: "vitest-exit-unexplained",
      message:
        "Vitest exited with failure code 1, but no failed test in the complete tree explains the exit.",
    });
  } else if (
    processResult.code !== null &&
    processResult.code !== 0 &&
    processResult.code !== 1
  ) {
    issues.push({
      code: "vitest-exit-abnormal",
      message: `Vitest process exited with abnormal code ${processResult.code}.`,
    });
  } else if (processResult.code === null && processResult.signal === null) {
    issues.push({
      code: "vitest-exit-missing",
      message: "Vitest process did not report an exit status.",
    });
  }

  return {
    complete: issues.length === 0,
    command: { attempted: true, ...processResult },
    tests,
    ...(candidate === undefined ? {} : { discovery: candidate.catalog }),
    issues: uniqueIssues(issues),
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
    !isCandidateCatalog(candidate.catalog) ||
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
      catalog: candidate.catalog,
      errors: candidate.errors,
    },
    closeErrors: value.closeErrors,
  };
}

function isCandidateTest(value: unknown): value is VitestTestRecord {
  return (
    isRecord(value) &&
    isNonEmptyString(value.identity) &&
    isVitestTestStatus(value.status) &&
    isNonNegativeCount(value.attemptCount) &&
    (value.message === undefined || typeof value.message === "string") &&
    (value.observations === undefined ||
      (Array.isArray(value.observations) &&
        value.observations.every(isCandidateObservation))) &&
    (value.reads === undefined ||
      (Array.isArray(value.reads) && value.reads.every(isCandidateRead)))
  );
}

function isCandidateCatalog(value: unknown): value is VitestTestCatalog {
  return (
    isRecord(value) &&
    (value.completeness === "complete" || value.completeness === "partial") &&
    Array.isArray(value.suites) &&
    value.suites.every(
      (suite) =>
        isRecord(suite) &&
        isNonEmptyString(suite.file) &&
        isStringList(suite.path) &&
        suite.path.length > 0 &&
        suite.path.every(isNonEmptyString),
    ) &&
    Array.isArray(value.tests) &&
    value.tests.every(
      (test) =>
        isRecord(test) &&
        isNonEmptyString(test.identity) &&
        isNonEmptyString(test.file) &&
        isStringList(test.suitePath) &&
        test.suitePath.every(isNonEmptyString) &&
        isNonEmptyString(test.name),
    )
  );
}

function nativeSuitePath(
  value: unknown,
  includeCurrent: boolean,
): string[] | undefined {
  let node: unknown;
  if (includeCurrent) {
    node = value;
  } else if (isRecord(value)) {
    node = value.suite ?? value.parent;
  }
  const path: string[] = [];
  const seen = new Set<object>();
  while (node !== undefined && node !== null) {
    if (!isRecord(node) || seen.has(node)) return undefined;
    seen.add(node);
    if (node.type !== "suite") break;
    if (!isNonEmptyString(node.name)) return undefined;
    path.unshift(node.name);
    node = node.suite ?? node.parent;
  }
  return path;
}

function isCandidateObservation(
  value: unknown,
): value is VitestObservationRecord {
  return (
    isRecord(value) &&
    isPositiveCount(value.attempt) &&
    typeof value.key === "string" &&
    value.key.length > 0 &&
    Object.hasOwn(value, "value") &&
    isJsonValue(value.value) &&
    Object.keys(value).every(
      (key) => key === "attempt" || key === "key" || key === "value",
    )
  );
}

function isCandidateRead(value: unknown): value is VitestReadRecord {
  return (
    isRecord(value) &&
    isPositiveCount(value.attempt) &&
    typeof value.referenceId === "string" &&
    value.referenceId.length > 0 &&
    Object.hasOwn(value, "value") &&
    isJsonValue(value.value) &&
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

function isTextRange(value: unknown): value is TextRange {
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

function isVitestTestStatus(value: unknown): value is VitestTestStatus {
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function testIdentity(
  file: string,
  suitePath: readonly string[],
  name: string,
): string {
  return JSON.stringify([file, ...suitePath, name]);
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
      errors.push(`Test ${name} is missing a verifiable setup attempt count.`);
    }
    return 0;
  }
  if (!hasTerminalResult) return metadataCount;
  if (metadataCount === 0) {
    errors.push(`Test ${name} has a terminal status without a proven attempt.`);
    return 0;
  }

  if (
    !isNonNegativeCount(retryCount) ||
    retryCount === Number.MAX_SAFE_INTEGER
  ) {
    errors.push(`Test ${name} is missing a verifiable final retryCount.`);
    return metadataCount;
  }
  const resultCount = retryCount + 1;
  if (metadataCount !== resultCount) {
    errors.push(
      `Test ${name} setup attempt count ${metadataCount} does not match Vitest retryCount ${retryCount}.`,
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
  readonly observations: VitestObservationRecord[];
  readonly reads: VitestReadRecord[];
} {
  const attempts = isRecord(metadata) ? metadata.dockVitestAttempts : undefined;
  if (attemptCount === 0) {
    if (
      attempts !== undefined &&
      (!Array.isArray(attempts) || attempts.length > 0)
    ) {
      errors.push(
        `Test ${name} has attempt activity records without any proven attempt.`,
      );
    }
    return { observations: [], reads: [] };
  }
  if (!Array.isArray(attempts) || attempts.length !== attemptCount) {
    errors.push(
      `Test ${name} active attempt record count does not match native start count.`,
    );
    return { observations: [], reads: [] };
  }

  const observations: VitestObservationRecord[] = [];
  const reads: VitestReadRecord[] = [];
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
      errors.push(
        `Test ${name} has an invalid activity record for attempt ${index + 1}.`,
      );
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
): VitestTestStatus {
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
  return messages.length === 0 ? undefined : messages.join("; ");
}

function markDuplicateIdentities(tests: VitestTestRecord[]): void {
  const counts = new Map<string, number>();
  for (const test of tests) {
    counts.set(test.identity, (counts.get(test.identity) ?? 0) + 1);
  }
  for (let index = 0; index < tests.length; index += 1) {
    const test = tests[index];
    if (test !== undefined && (counts.get(test.identity) ?? 0) > 1) {
      tests[index] = { ...test, status: "duplicate" };
    }
  }
}

function uniqueMessages(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueIssues(values: readonly VitestIssue[]): VitestIssue[] {
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
