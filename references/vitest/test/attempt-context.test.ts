import assert from "node:assert/strict";
import test from "node:test";

import {
  installVitestAttemptCapture,
  recordVitestObservation,
} from "../src/attempt-context.ts";

test("重复安装围绕钩子只记录同一测试的一次真实尝试", async () => {
  const handlers: ((
    runTest: () => Promise<void>,
    context: never,
  ) => Promise<void>)[] = [];
  const aroundEach = ((
    handler: (runTest: () => Promise<void>, context: never) => Promise<void>,
  ) => {
    handlers.push(handler);
  }) as unknown as typeof import("vitest").aroundEach;
  installVitestAttemptCapture(aroundEach);
  installVitestAttemptCapture(aroundEach);

  assert.equal(handlers.length, 2);
  const metadata: Record<string, unknown> = {};
  const context = {
    signal: new AbortController().signal,
    task: { id: "same-test", meta: metadata },
  } as never;
  const innermost = async () => {
    recordVitestObservation("value", "actual");
  };
  const inner = async () => await handlers[1](innermost, context);
  await handlers[0](inner, context);

  assert.equal(metadata.dockVitestAttemptCount, 1);
  assert.deepEqual(metadata.dockVitestAttempts, [
    {
      attempt: 1,
      observations: [{ attempt: 1, key: "value", value: "actual" }],
      reads: [],
    },
  ]);
  assert.throws(
    () => recordVitestObservation("value", "late"),
    /必须在当前 Vitest 原生测试尝试内调用/,
  );

  const controller = new AbortController();
  const cancelledMetadata: Record<string, unknown> = {};
  const cancelledContext = {
    signal: controller.signal,
    task: { id: "cancelled-test", meta: cancelledMetadata },
  } as never;
  await handlers[0](async () => {
    controller.abort();
    assert.throws(
      () => recordVitestObservation("value", "cancelled"),
      /已结束或取消/,
    );
  }, cancelledContext);
  assert.deepEqual(cancelledMetadata.dockVitestAttempts, [
    { attempt: 1, observations: [], reads: [] },
  ]);
});
