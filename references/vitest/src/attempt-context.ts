import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";

import {
  copyJsonValue,
  readReference,
  type Config,
  type ExecutionObservationRecord,
  type ExecutionReadRecord,
  type JsonValue,
  type PluginReadResult,
  type ReadableReferenceOf,
  type ReferencePlugin,
  type ReferenceValue,
} from "@ykdz/dock";

type AttemptRecord = {
  readonly attempt: number;
  readonly observations: ExecutionObservationRecord[];
  readonly reads: ExecutionReadRecord[];
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
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };
const bridgeKey = Symbol.for(
  `@ykdz/dock-reference-vitest/${version}/attempt-context`,
);

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

/** 记录并原样返回当前业务回调产生的 JSON 观察值。 */
export function recordVitestObservation<Value extends JsonValue>(
  key: string,
  value: Value,
): Value {
  if (key.length === 0) throw new TypeError("观察键必须是非空文本。");
  const cloned = copyJsonValue(value);
  const active = currentAttempt("记录观察");
  active?.record.observations.push({
    attempt: active.record.attempt,
    key,
    value: cloned,
  });
  return value;
}

/** 经宿主读取当前引用，并将真实读取归属到当前测试尝试。 */
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
