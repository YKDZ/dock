import { AsyncLocalStorage } from "node:async_hooks";

import {
  readReference,
  type Config,
  type ExecutionObservationRecord,
  type ExecutionReadRecord,
  type JsonValue,
  type PluginReadResult,
  type ReadableReferenceOf,
  type ReferencePlugin,
  type ReferenceValue,
} from "@dock/sdk";

type AttemptRecord = {
  readonly attempt: number;
  readonly observations: ExecutionObservationRecord[];
  readonly reads: ExecutionReadRecord[];
};

type ActiveAttempt = {
  readonly record: AttemptRecord;
  readonly signal: AbortSignal;
  active: boolean;
};

type AttemptBridge = {
  readonly current: AsyncLocalStorage<ActiveAttempt>;
  setupInstalled: boolean;
};

type TestMetadata = Record<string, unknown>;

const bridgeKey = Symbol.for("@dock/reference-vitest/0.0.0/attempt-context");

const sharedGlobal = globalThis as typeof globalThis & {
  [bridgeKey]?: AttemptBridge;
};
const bridge = (sharedGlobal[bridgeKey] ??= {
  current: new AsyncLocalStorage<ActiveAttempt>(),
  setupInstalled: false,
});

/** 用原生 aroundEach 为每次实际测试尝试建立可取消活动上下文。 */
export function installVitestAttemptCapture(
  aroundEach: typeof import("vitest").aroundEach,
): void {
  if (bridge.setupInstalled) return;
  aroundEach(async (runTest, context) => {
    const metadata = context.task.meta as TestMetadata;
    const previous = metadata.dockVitestAttemptCount;
    if (
      previous !== undefined &&
      (!Number.isSafeInteger(previous) ||
        typeof previous !== "number" ||
        previous < 0 ||
        previous === Number.MAX_SAFE_INTEGER)
    ) {
      throw new TypeError("Vitest 原生尝试计数无效。");
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

/** 记录并原样返回当前业务回调产生的 JSON 观察值。 */
export function recordVitestObservation<Value extends JsonValue>(
  key: string,
  value: Value,
): Value {
  if (key.length === 0) throw new TypeError("观察键必须是非空文本。");
  const cloned = cloneStrictJson(value, new Set());
  const active = currentAttempt("记录观察");
  active?.record.observations.push({
    attempt: active.record.attempt,
    key,
    value: cloned,
  });
  return value;
}

/** 经 SDK 读取当前引用，并将真实读取归属到当前测试尝试。 */
export async function readReferenceInTest<
  const Plugins extends readonly ReferencePlugin[],
  const Ref extends ReadableReferenceOf<Plugins>,
>(
  config: Config<Plugins>,
  reference: Ref,
): Promise<PluginReadResult<ReferenceValue<Ref>>> {
  const active = currentAttempt("测试内读取引用");
  const result = await readReference(config, reference);
  if (active !== undefined) {
    assertCurrentAttempt(active, "测试内读取引用");
    active.record.reads.push({
      attempt: active.record.attempt,
      referenceId: reference.id,
      value: cloneStrictJson(result.value, new Set()),
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
    throw new Error(`${operation} 必须在当前 Vitest 原生测试尝试内调用。`);
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
    throw new Error(`${operation} 的 Vitest 原生测试尝试已结束或取消。`);
  }
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
        throw new TypeError("观察数组必须连续且不能包含额外属性。");
      }
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
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
    throw new TypeError("读取范围无效。");
  }
  return { path: range.path, start: range.start, end: range.end };
}
