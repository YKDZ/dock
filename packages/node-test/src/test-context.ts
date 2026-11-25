import { getTestContext } from "node:test";

import { copyJsonValue, type JsonValue, type TextRange } from "@dock/core";

import type { NodeReadRecord } from "./types.ts";

export const nodeObservationMessagePrefix = "dock:observation:";
export const nodeReadMessagePrefix = "dock:read:";

/** Marks actual callback entry for an active native test, distinguishing cancelled subtests. */
export function beginExecution(): void {
  activeTestContext("beginExecution").diagnostic("dock:started");
}

/** Asserts that the current call is inside an active native test callback. */
export function assertNodeTestActive(operation: string): void {
  activeTestContext(operation);
}

export function recordNodeObservation(key: string, value: unknown): void {
  if (key.length === 0) {
    throw new TypeError("Observation key must be a non-empty string.");
  }
  const jsonValue = copyJsonValue(value);
  logActivity(
    nodeObservationMessagePrefix,
    { key, value: jsonValue },
    "recordObservation",
  );
}

export function recordNodeRead(
  record: Omit<NodeReadRecord, "attempt" | "value"> & {
    readonly value: unknown;
  },
): void {
  if (record.referenceId.length === 0) {
    throw new TypeError("Read record must include a reference ID.");
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
    "recordRead",
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
    throw new Error(
      `${operation} must be called inside an active Node native test callback.`,
    );
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
    throw new TypeError("Read range is invalid.");
  }
  return { path: value.path, start: value.start, end: value.end };
}
