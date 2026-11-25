import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  installVitestAttemptCapture,
  recordVitestObservation,
} from "../src/attempt-context.ts";
import { vitest, vitestPluginId } from "../src/index.ts";

const packageVersion = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { readonly version: string }
).version;

void test("vitest plugin uses dock:vitest plugin ID", () => {
  assert.equal(vitestPluginId, "dock:vitest");
  assert.equal(vitest.id, "dock:vitest");
});

void test("reinstalling aroundEach hooks records only one real attempt for the same test", async () => {
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
  const inner = async () => await handlers[1]!(innermost, context);
  await handlers[0]!(inner, context);

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
    /must be called inside an active native Vitest test attempt/,
  );

  const controller = new AbortController();
  const cancelledMetadata: Record<string, unknown> = {};
  const cancelledContext = {
    signal: controller.signal,
    task: { id: "cancelled-test", meta: cancelledMetadata },
  } as never;
  await handlers[0]!(async () => {
    controller.abort();
    assert.throws(
      () => recordVitestObservation("value", "cancelled"),
      /has already finished or been cancelled/,
    );
  }, cancelledContext);
  assert.deepEqual(cancelledMetadata.dockVitestAttempts, [
    { attempt: 1, observations: [], reads: [] },
  ]);
  assert.equal(
    Object.hasOwn(
      globalThis,
      Symbol.for(`@boringparts/dock/vitest/${packageVersion}/attempt-context`),
    ),
    true,
  );
});
