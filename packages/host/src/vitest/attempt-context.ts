import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";

import { copyJsonValue, type JsonValue } from "@dock/core";

import type {
  Config,
  PluginReadResult,
  ReadableReferenceOf,
  ReferencePlugin,
  ReferenceValue,
} from "../contracts.ts";
import { readReference } from "../read.ts";
import type {
  VitestObservationRecord,
  VitestReadRecord,
} from "./event-mapper.ts";

type AttemptRecord = {
  readonly attempt: number;
  readonly observations: VitestObservationRecord[];
  readonly reads: VitestReadRecord[];
};

type ActiveAttempt = {
  readonly record: AttemptRecord;
  readonly taskId: string;
  readonly signal: AbortSignal;
  active: boolean;
};

type AttemptBridge = {
  readonly current: AsyncLocalStorage<ActiveAttempt>;
  setupInstalled: boolean;
};

type TestMetadata = Record<string, unknown>;

const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };
const bridgeKey = Symbol.for(`@ykdz/dock/vitest/${version}/attempt-context`);

const sharedGlobal = globalThis as typeof globalThis & {
  [bridgeKey]?: AttemptBridge;
};
const bridge = (sharedGlobal[bridgeKey] ??= {
  current: new AsyncLocalStorage<ActiveAttempt>(),
  setupInstalled: false,
});

/** Establishes a cancellable active context for each real test attempt via native aroundEach. */
export function installVitestAttemptCapture(
  aroundEach: typeof import("vitest").aroundEach,
): void {
  aroundEach(async (runTest, context) => {
    const current = bridge.current.getStore();
    if (
      current !== undefined &&
      current.taskId === context.task.id &&
      current.active &&
      !context.signal.aborted
    ) {
      await runTest();
      return;
    }

    const metadata = context.task.meta as TestMetadata;
    const previous = metadata.dockVitestAttemptCount;
    if (
      previous !== undefined &&
      (!Number.isSafeInteger(previous) ||
        typeof previous !== "number" ||
        previous < 0 ||
        previous === Number.MAX_SAFE_INTEGER)
    ) {
      throw new TypeError("Invalid native Vitest attempt count.");
    }
    const attempt = previous === undefined ? 1 : previous + 1;
    const record: AttemptRecord = {
      attempt,
      observations: [],
      reads: [],
    };
    const historyValue = metadata.dockVitestAttempts;
    const history = Array.isArray(historyValue) ? historyValue : [];
    metadata.dockVitestAttemptCount = attempt;
    metadata.dockVitestAttempts = [...history, record];

    const active: ActiveAttempt = {
      record,
      taskId: context.task.id,
      signal: context.signal,
      active: !context.signal.aborted,
    };
    const abort = () => {
      active.active = false;
    };
    context.signal.addEventListener("abort", abort, { once: true });
    try {
      return await bridge.current.run(active, runTest);
    } finally {
      active.active = false;
      context.signal.removeEventListener("abort", abort);
    }
  });
  bridge.setupInstalled = true;
}

/** Records a JSON observation value produced by the current test callback and returns it as-is. */
export function recordVitestObservation<Value extends JsonValue>(
  key: string,
  value: Value,
): Value {
  if (key.length === 0) {
    throw new TypeError("Observation key must be a non-empty string.");
  }
  const cloned = copyJsonValue(value);
  const active = currentAttempt("recordVitestObservation");
  active?.record.observations.push({
    attempt: active.record.attempt,
    key,
    value: cloned,
  });
  return value;
}

/** Reads a reference via the host and attributes the read (`reads`) to the current Vitest `attempt` for diagnostics. */
export async function readReferenceInTest<
  const Plugins extends readonly ReferencePlugin[],
  const Ref extends ReadableReferenceOf<Plugins>,
>(
  config: Config<Plugins>,
  reference: Ref,
): Promise<PluginReadResult<ReferenceValue<Ref>>> {
  const active = currentAttempt("readReferenceInTest");
  const result = await readReference(config, reference);
  if (active !== undefined) {
    assertCurrentAttempt(active, "readReferenceInTest");
    active.record.reads.push({
      attempt: active.record.attempt,
      referenceId: reference.id,
      value: copyJsonValue(result.value),
      ...(result.range === undefined
        ? {}
        : { range: cloneTextRange(result.range) }),
    });
  }
  return result;
}

function currentAttempt(operation: string): ActiveAttempt | undefined {
  const active = bridge.current.getStore();
  if (!bridge.setupInstalled) return undefined;
  if (active === undefined) {
    throw new Error(
      `${operation} must be called inside an active native Vitest test attempt.`,
    );
  }
  assertCurrentAttempt(active, operation);
  return active;
}

function assertCurrentAttempt(active: ActiveAttempt, operation: string): void {
  if (
    bridge.current.getStore() !== active ||
    !active.active ||
    active.signal.aborted
  ) {
    throw new Error(
      `${operation} native Vitest test attempt has already finished or been cancelled.`,
    );
  }
}

function cloneTextRange(range: {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}) {
  if (
    typeof range.path !== "string" ||
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start
  ) {
    throw new TypeError("Invalid read range.");
  }
  return { path: range.path, start: range.start, end: range.end };
}
