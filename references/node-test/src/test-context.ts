import { getTestContext } from "node:test";

import type { ExecutionReadRecord, JsonValue, TextRange } from "@dock/sdk";

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
  const jsonValue = cloneStrictJson(value, new Set());
  logActivity(
    nodeObservationMessagePrefix,
    { key, value: jsonValue },
    "记录观察",
  );
}

export function recordNodeRead(
  record: Omit<ExecutionReadRecord, "value"> & { readonly value: unknown },
): void {
  if (record.referenceId.length === 0) {
    throw new TypeError("读取记录必须包含引用身份。");
  }
  const value = cloneStrictJson(record.value, new Set());
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

function cloneStrictJson(value: unknown, active: Set<object>): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("观察值包含非有限数。");
    return value;
  }
  if (typeof value !== "object" || active.has(value)) {
    throw new TypeError("观察值必须是无循环的 JSON 值。");
  }

  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        Object.getOwnPropertySymbols(value).length > 0 ||
        Object.keys(value).length !== value.length ||
        Object.getOwnPropertyNames(value).length !== value.length + 1
      ) {
        throw new TypeError("观察数组必须是连续且没有额外属性的 JSON 数组。");
      }
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new TypeError("观察数组不能包含空位或访问器属性。");
        }
        result.push(cloneStrictJson(descriptor.value, active));
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    const keys = Object.keys(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length > 0 ||
      Object.getOwnPropertyNames(value).length !== keys.length
    ) {
      throw new TypeError("观察对象必须是没有额外属性的普通 JSON 对象。");
    }
    const result: Record<string, JsonValue> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError("观察对象不能包含访问器属性。");
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: cloneStrictJson(descriptor.value, active),
        writable: true,
      });
    }
    return result;
  } finally {
    active.delete(value);
  }
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
