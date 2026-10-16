import { relative, resolve } from "node:path";

import type {
  ExecutionObservationRecord,
  ExecutionReadRecord,
  ExecutionRunRecord,
  ExecutionTestRecord,
  ExecutionTestStatus,
  JsonValue,
} from "@dock/sdk";

import {
  nodeObservationMessagePrefix,
  nodeReadMessagePrefix,
} from "./test-context.ts";
import type { NodeEvent, NodeSelectedTest } from "./types.ts";

type NodeTestNode = {
  readonly key: string;
  readonly entryFile: string;
  readonly file: string;
  readonly testId: string | number;
  readonly parentId?: string | number;
  readonly name: string;
  readonly type: string;
  readonly line?: number;
  readonly column?: number;
  runnerStarted: boolean;
  started: boolean;
  readonly observations: ExecutionObservationRecord[];
  readonly reads: ExecutionReadRecord[];
  terminal?: {
    readonly status: ExecutionTestStatus;
    readonly message?: string;
  };
};

export type NodeRunCompletion = {
  readonly testRoot: string;
  readonly files: readonly string[];
  readonly namePattern?: string;
  readonly selectedTests: readonly NodeSelectedTest[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly processError?: string;
  readonly protocolError?: string;
};

/** 将 Node 24.21 TestsStream 事件和进程关闭结果映射为 SDK 通用执行记录。 */
export function collectNodeRun(
  events: readonly NodeEvent[],
  completion: NodeRunCompletion,
): ExecutionRunRecord {
  const nodes = new Map<string, NodeTestNode>();
  const errors: { code: string; message: string }[] = [];
  const finalSummaries: Record<string, unknown>[] = [];
  let interrupted = false;
  let invalidActivity = false;

  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === "test:summary" && data.entryFile === undefined) {
      finalSummaries.push(data);
    }
    if (event.type === "test:interrupted") {
      interrupted = true;
      errors.push({
        code: "node-test-interrupted",
        message: "Node 原生测试在完整结束前被中断。",
      });
    }

    if (event.type === "test:enqueue") {
      const node = nodeFromEvent(data, completion.testRoot);
      if (node !== undefined) nodes.set(node.key, node);
      continue;
    }

    const activity =
      event.type === "test:diagnostic"
        ? parseActivityMessage(data.message)
        : undefined;
    const node = nodeForEvent(nodes, data, activity?.testFullName);
    if (node === undefined) {
      if (activity !== undefined) {
        invalidActivity = true;
        errors.push({
          code: "node-test-activity-unattributed",
          message: "Node 测试活动记录没有对应的原生测试身份。",
        });
      }
      if (event.type === "test:fail") {
        errors.push({
          code: "node-test-unattributed-failure",
          message: failureMessage(data),
        });
      }
      continue;
    }

    if (event.type === "test:start") node.runnerStarted = true;
    if (event.type === "test:diagnostic" && data.message === "dock:started") {
      node.started = true;
    }
    if (activity?.kind === "invalid") {
      invalidActivity = true;
      errors.push({
        code: "node-test-activity-record-invalid",
        message: `测试 ${node.name} 的 Dock 活动记录无效：${activity.message}`,
      });
    } else if (activity?.kind === "observation") {
      node.started = true;
      node.observations.push(activity.record);
    } else if (activity?.kind === "read") {
      node.started = true;
      node.reads.push(activity.record);
    }
    if (event.type === "test:pass" || event.type === "test:fail") {
      const status = terminalStatus(event.type, data);
      node.terminal = {
        status,
        ...(status === "passed" ? {} : { message: failureMessage(data) }),
      };
      if (status === "passed" || status === "failed") node.started = true;
      const details = isRecord(data.details) ? data.details : undefined;
      const failure =
        details !== undefined && isRecord(details.error)
          ? details.error
          : undefined;
      if (
        event.type === "test:fail" &&
        details?.type === "suite" &&
        failure?.failureType === "hookFailed"
      ) {
        errors.push({
          code: "node-test-hook-failed",
          message: `Node 测试套件 ${node.name} 的共同收尾失败：${failureMessage(data)}`,
        });
      }
    }
  }

  const tests = [...nodes.values()]
    .filter((node) => node.type === "test")
    .map((node): ExecutionTestRecord => {
      const status =
        node.terminal?.status ?? (node.runnerStarted ? "not-run" : "filtered");
      return {
        id: testIdentity(
          relativePath(completion.testRoot, node.file),
          fullName(node, nodes),
        ),
        status,
        started: node.started,
        attemptCount: node.started ? 1 : 0,
        observations: node.observations,
        reads: node.reads,
        ...(node.terminal?.message === undefined
          ? {}
          : { message: node.terminal.message }),
      };
    });
  markDuplicateIdentities(tests);
  appendUnreportedSelections(tests, completion);

  const finalSummary =
    finalSummaries.length === 1 ? finalSummaries[0] : undefined;
  let lifecycle: ExecutionRunRecord["lifecycle"] = "complete";
  if (interrupted) lifecycle = "incomplete";
  if (invalidActivity) lifecycle = "incomplete";
  if (completion.processError !== undefined) {
    lifecycle = "incomplete";
    errors.push({
      code: "node-test-start-failed",
      message: completion.processError,
    });
  }
  if (completion.protocolError !== undefined) {
    lifecycle = "incomplete";
    errors.push({
      code: "node-test-event-stream-invalid",
      message: completion.protocolError,
    });
  }
  if (completion.signal !== null) {
    lifecycle = "incomplete";
    errors.push({
      code: "node-test-interrupted",
      message: `Node 测试进程收到信号 ${completion.signal}。`,
    });
  }
  if (completion.exitCode === null) {
    lifecycle = "incomplete";
    errors.push({
      code: "node-test-exit-missing",
      message: "Node 测试进程没有可解释的退出码。",
    });
  }
  if (finalSummary === undefined) {
    lifecycle = "incomplete";
    errors.push({
      code: "node-test-summary-missing",
      message: "Node 原生测试没有唯一的最终结束事件。",
    });
  }

  const counts = finalSummary?.counts;
  if (
    finalSummary !== undefined &&
    (typeof finalSummary.success !== "boolean" || !isRecord(counts))
  ) {
    lifecycle = "incomplete";
    errors.push({
      code: "node-test-summary-invalid",
      message: "Node 原生最终结束事件缺少有效状态计数。",
    });
  }
  if (
    finalSummary !== undefined &&
    completion.exitCode !== null &&
    isRecord(counts)
  ) {
    const failed = numericCount(counts.failed);
    const cancelled = numericCount(counts.cancelled);
    const expectedExitCode = failed > 0 || cancelled > 0 ? 1 : 0;
    const expectedSuccess = expectedExitCode === 0;
    if (finalSummary.success !== expectedSuccess) {
      lifecycle = "incomplete";
      errors.push({
        code: "node-test-summary-mismatch",
        message: "Node 原生最终摘要的成功状态与测试终态计数不符。",
      });
    }
    if (completion.exitCode !== expectedExitCode) {
      lifecycle = "incomplete";
      errors.push({
        code: "node-test-exit-mismatch",
        message: `Node 测试退出码 ${completion.exitCode} 与终态事件要求的退出码 ${expectedExitCode} 不符。`,
      });
    }
  }

  return {
    lifecycle,
    commandAttempts: 1,
    testExecutions: tests.reduce((total, test) => total + test.attemptCount, 0),
    tests,
    errors: uniqueErrors(errors),
    ...(completion.exitCode === null && completion.signal === null
      ? {}
      : {
          commandResult: {
            exitCode: completion.exitCode,
            signal: completion.signal,
          },
        }),
  };
}

/** 用于无法从可靠原生进程固定制造的退出码与事件冲突测试。 */
function nodeFromEvent(
  data: Record<string, unknown>,
  testRoot: string,
): NodeTestNode | undefined {
  if (
    (typeof data.testId !== "number" && typeof data.testId !== "string") ||
    typeof data.file !== "string" ||
    typeof data.name !== "string" ||
    typeof data.type !== "string"
  ) {
    return undefined;
  }
  const entryFile =
    typeof data.entryFile === "string" ? data.entryFile : data.file;
  const key = nodeKey(entryFile, data.testId);
  return {
    key,
    entryFile,
    file: resolve(testRoot, data.file),
    testId: data.testId,
    ...(typeof data.parentId === "number" || typeof data.parentId === "string"
      ? { parentId: data.parentId }
      : {}),
    name: data.name,
    type: data.type,
    ...(Number.isSafeInteger(data.line) ? { line: data.line as number } : {}),
    ...(Number.isSafeInteger(data.column)
      ? { column: data.column as number }
      : {}),
    runnerStarted: false,
    started: false,
    observations: [],
    reads: [],
  };
}

type ParsedActivityMessage =
  | {
      readonly kind: "observation";
      readonly testFullName: string;
      readonly record: ExecutionObservationRecord;
    }
  | {
      readonly kind: "read";
      readonly testFullName: string;
      readonly record: ExecutionReadRecord;
    }
  | {
      readonly kind: "invalid";
      readonly message: string;
      readonly testFullName?: string;
    };

function parseActivityMessage(
  value: unknown,
): ParsedActivityMessage | undefined {
  if (typeof value !== "string") return undefined;
  const kind = value.startsWith(nodeObservationMessagePrefix)
    ? "observation"
    : value.startsWith(nodeReadMessagePrefix)
      ? "read"
      : undefined;
  if (kind === undefined) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(
      value.slice(
        kind === "observation"
          ? nodeObservationMessagePrefix.length
          : nodeReadMessagePrefix.length,
      ),
    ) as unknown;
  } catch (error) {
    return {
      kind: "invalid",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const testFullName =
    isRecord(payload) && typeof payload.testFullName === "string"
      ? payload.testFullName
      : undefined;
  const invalid = (message: string): ParsedActivityMessage => ({
    kind: "invalid",
    message,
    ...(testFullName === undefined ? {} : { testFullName }),
  });
  if (testFullName === undefined) {
    return invalid("活动记录缺少原生测试名称。");
  }

  if (kind === "observation") {
    if (
      !isRecord(payload) ||
      typeof payload.key !== "string" ||
      payload.key.length === 0 ||
      !Object.hasOwn(payload, "value") ||
      Object.keys(payload).some(
        (key) => key !== "key" && key !== "value" && key !== "testFullName",
      )
    ) {
      return invalid("观察记录必须包含键和值。");
    }
    return {
      kind,
      testFullName,
      record: { key: payload.key, value: payload.value as JsonValue },
    };
  }

  if (
    !isRecord(payload) ||
    typeof payload.referenceId !== "string" ||
    payload.referenceId.length === 0 ||
    !Object.hasOwn(payload, "value") ||
    Object.keys(payload).some(
      (key) =>
        key !== "referenceId" &&
        key !== "value" &&
        key !== "range" &&
        key !== "testFullName",
    ) ||
    (payload.range !== undefined && !isTextRange(payload.range))
  ) {
    return invalid("读取记录必须包含有效引用和值。");
  }
  return {
    kind,
    testFullName,
    record: {
      referenceId: payload.referenceId,
      value: payload.value as JsonValue,
      ...(payload.range === undefined ? {} : { range: payload.range }),
    },
  };
}

function isTextRange(value: unknown): value is ExecutionReadRecord["range"] {
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

function nodeForEvent(
  nodes: Map<string, NodeTestNode>,
  data: Record<string, unknown>,
  testFullName?: string,
): NodeTestNode | undefined {
  if (
    (typeof data.testId === "number" || typeof data.testId === "string") &&
    typeof data.entryFile === "string"
  ) {
    return nodes.get(nodeKey(data.entryFile, data.testId));
  }

  if (
    typeof data.entryFile !== "string" ||
    typeof data.file !== "string" ||
    !Number.isSafeInteger(data.line) ||
    !Number.isSafeInteger(data.column)
  ) {
    return undefined;
  }
  const matches = [...nodes.values()].filter(
    (node) =>
      node.type === "test" &&
      node.entryFile === data.entryFile &&
      node.file === resolve(data.file as string) &&
      node.line === data.line &&
      node.column === data.column,
  );
  const candidates =
    testFullName === undefined
      ? matches
      : matches.filter((node) => fullName(node, nodes) === testFullName);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function nodeKey(file: string, testId: string | number): string {
  return `${file}\0${String(testId)}`;
}

function terminalStatus(
  eventType: string,
  data: Record<string, unknown>,
): ExecutionTestStatus {
  if (data.skip !== undefined && data.skip !== false) return "skipped";
  if (data.todo !== undefined && data.todo !== false) return "todo";
  if (eventType === "test:pass") return "passed";
  const error =
    isRecord(data.details) && isRecord(data.details.error)
      ? data.details.error
      : undefined;
  return typeof error?.failureType === "string" &&
    /cancel|abort/i.test(error.failureType)
    ? "cancelled"
    : "failed";
}

function fullName(
  node: NodeTestNode,
  nodes: Map<string, NodeTestNode>,
  seen = new Set<string>(),
): string {
  if (seen.has(node.key)) return "<循环测试父级>";
  seen.add(node.key);
  if (
    node.parentId === undefined ||
    node.parentId === 0 ||
    node.parentId === "0"
  ) {
    return node.name;
  }
  const parent = nodes.get(nodeKey(node.entryFile, node.parentId));
  if (
    parent === undefined ||
    (parent.type === "test" && parent.name.startsWith("/"))
  ) {
    return node.name;
  }
  return `${fullName(parent, nodes, seen)} > ${node.name}`;
}

function relativePath(root: string, file: string): string {
  return relative(root, resolve(file)).split("\\").join("/");
}

function testIdentity(file: string, name: string): string {
  return JSON.stringify({ file, name });
}

export { testIdentity };

function markDuplicateIdentities(tests: ExecutionTestRecord[]): void {
  const counts = new Map<string, number>();
  for (const test of tests) counts.set(test.id, (counts.get(test.id) ?? 0) + 1);
  for (let index = 0; index < tests.length; index++) {
    const test = tests[index]!;
    if ((counts.get(test.id) ?? 0) > 1) {
      tests[index] = {
        ...test,
        status: "duplicate",
        message: `测试身份 ${test.id} 在同一运行中出现多次。`,
      };
    }
  }
}

function appendUnreportedSelections(
  tests: ExecutionTestRecord[],
  completion: NodeRunCompletion,
): void {
  const existing = new Set(tests.map((test) => test.id));
  for (const selected of completion.selectedTests) {
    const file = relativePath(completion.testRoot, selected.file);
    const id = testIdentity(file, selected.name);
    if (existing.has(id)) continue;
    const status = !completion.files.includes(selected.file)
      ? "not-run"
      : completion.namePattern !== undefined &&
          !new RegExp(completion.namePattern).test(selected.name)
        ? "filtered"
        : "not-run";
    tests.push({ id, status, started: false, attemptCount: 0 });
    existing.add(id);
  }
}

function failureMessage(data: Record<string, unknown>): string {
  const details = isRecord(data.details) ? data.details : undefined;
  const error =
    details !== undefined && isRecord(details.error)
      ? details.error
      : undefined;
  if (typeof error?.message === "string") return error.message;
  if (typeof error?.cause === "string") return error.cause;
  if (isRecord(error?.cause) && typeof error.cause.message === "string") {
    return error.cause.message;
  }
  if (typeof error?.failureType === "string") return error.failureType;
  return typeof data.name === "string" ? data.name : "Node 原生测试失败。";
}

function numericCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function uniqueErrors(
  errors: readonly { readonly code: string; readonly message: string }[],
): { code: string; message: string }[] {
  const seen = new Set<string>();
  return errors.filter((error) => {
    const identity = `${error.code}\0${error.message}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
