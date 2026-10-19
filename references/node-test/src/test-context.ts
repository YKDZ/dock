import { getTestContext } from "node:test";

import {
  copyJsonValue,
  type ExecutionReadRecord,
  type JsonValue,
  type TextRange,
} from "@ykdz/dock";

export const nodeObservationMessagePrefix = "dock:observation:";
export const nodeReadMessagePrefix = "dock:read:";

/** 在活动的原生测试回调入口记录真实开始，尤其用于区分取消的子测试。 */
export function beginExecution(): void {
  activeTestContext("beginExecution").diagnostic("dock:started");
}

/** 要求当前调用仍处于原生测试回调的活动期。 */
export function assertNodeTestActive(operation: string): void {
  activeTestContext(operation);
}

export function recordNodeObservation(key: string, value: unknown): void {
  if (key.length === 0) throw new TypeError("观察键必须是非空文本。");
  const jsonValue = copyJsonValue(value);
  logActivity(
    nodeObservationMessagePrefix,
    { key, value: jsonValue },
    "记录观察",
  );
}

export function recordNodeRead(
  record: Omit<ExecutionReadRecord, "attempt" | "value"> & {
    readonly value: unknown;
  },
): void {
  if (record.referenceId.length === 0) {
    throw new TypeError("读取记录必须包含引用身份。");
  }
  const value = copyJsonValue(record.value);
  const range =
    record.range === undefined ? undefined : cloneTextRange(record.range);
  logActivity(
    nodeReadMessagePrefix,
    {
      referenceId: record.referenceId,
      value,
      ...(range === undefined ? {} : { range }),
    },
    "记录读取",
  );
}

function logActivity(
  prefix: string,
  record: Record<string, JsonValue>,
  operation: string,
): void {
  const context = activeTestContext(operation);
  context.diagnostic(
    `${prefix}${JSON.stringify({ ...record, testFullName: context.fullName })}`,
  );
}

function activeTestContext(operation: string) {
  const context = getTestContext();
  if (context === undefined || !("test" in context) || context.signal.aborted) {
    throw new Error(`${operation} 必须在活动的 Node 原生测试回调内调用。`);
  }
  return context;
}

function cloneTextRange(value: TextRange): TextRange {
  if (
    typeof value.path !== "string" ||
    !Number.isSafeInteger(value.start) ||
    !Number.isSafeInteger(value.end) ||
    value.start < 0 ||
    value.end < value.start
  ) {
    throw new TypeError("读取范围无效。");
  }
  return { path: value.path, start: value.start, end: value.end };
}
