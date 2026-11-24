import assert from "node:assert/strict";
import { test } from "node:test";

import { collectNodeRun } from "../../src/node-test/event-mapper.ts";

void test("returns incomplete run record when native summary conflicts with process exit code", () => {
  const file = "/consumer/test/status.test.mts";
  const record = collectNodeRun(
    [
      {
        type: "test:enqueue",
        data: {
          entryFile: file,
          file,
          testId: 1,
          parentId: 0,
          name: "business status passed",
          type: "test",
        },
      },
      {
        type: "test:pass",
        data: {
          entryFile: file,
          file,
          testId: 1,
          name: "business status passed",
        },
      },
      {
        type: "test:summary",
        data: {
          success: true,
          counts: { failed: 0, cancelled: 0 },
        },
      },
    ],
    {
      testRoot: "/consumer",
      files: [file],
      selectedTests: [],
      exitCode: 1,
      signal: null,
    },
  );

  assert.equal(record.lifecycle, "incomplete");
  assert.equal(
    record.errors.some((error) => error.code === "node-test-exit-mismatch"),
    true,
  );
  assert.deepEqual(record.commandResult, { exitCode: 1, signal: null });
  assert.equal(record.tests[0]?.attemptCount, 1);
  assert.equal(record.testExecutions, 1);
});

void test("does not treat zero exit code as complete when native final summary is missing", () => {
  const record = collectNodeRun([], {
    testRoot: "/consumer",
    files: [],
    selectedTests: [],
    exitCode: 0,
    signal: null,
  });

  assert.equal(record.lifecycle, "incomplete");
  assert.equal(
    record.errors.some((error) => error.code === "node-test-summary-missing"),
    true,
  );
  assert.deepEqual(record.commandResult, { exitCode: 0, signal: null });
});

void test("does not count unstarted selected tests in actual attempt count", () => {
  const record = collectNodeRun([], {
    testRoot: "/consumer",
    files: ["/consumer/test/status.test.mts"],
    selectedTests: [
      { file: "/consumer/test/status.test.mts", name: "not yet started" },
    ],
    exitCode: 0,
    signal: null,
  });

  assert.equal(record.tests[0]?.started, false);
  assert.equal(record.tests[0]?.attemptCount, 0);
  assert.equal(record.testExecutions, 0);
});

void test("invalidates run record on native interrupted event or process signal", () => {
  const interruptedEvent = collectNodeRun([{ type: "test:interrupted" }], {
    testRoot: "/consumer",
    files: [],
    selectedTests: [],
    exitCode: 1,
    signal: null,
  });
  const interruptedProcess = collectNodeRun([], {
    testRoot: "/consumer",
    files: [],
    selectedTests: [],
    exitCode: null,
    signal: "SIGTERM",
  });

  for (const record of [interruptedEvent, interruptedProcess]) {
    assert.equal(record.lifecycle, "incomplete");
    assert.equal(
      record.errors.some((error) => error.code === "node-test-interrupted"),
      true,
    );
  }
  assert.deepEqual(interruptedProcess.commandResult, {
    exitCode: null,
    signal: "SIGTERM",
  });
});

void test("preserves recorded observations and reads with locations by native test identity", () => {
  const file = "/consumer/test/observations.test.mts";
  const record = collectNodeRun(
    [
      {
        type: "test:enqueue",
        data: {
          entryFile: file,
          file,
          testId: 4,
          parentId: 0,
          name: "read and record current value",
          type: "test",
          line: 28,
          column: 1,
        },
      },
      {
        type: "test:diagnostic",
        data: {
          entryFile: file,
          file,
          line: 28,
          column: 1,
          message:
            'dock:observation:{"key":"total","value":17,"testFullName":"read and record current value"}',
        },
      },
      {
        type: "test:diagnostic",
        data: {
          entryFile: file,
          file,
          line: 28,
          column: 1,
          message:
            'dock:read:{"referenceId":"business-copy","value":"🧭 active text","range":{"path":"guide.md","start":8,"end":22},"testFullName":"read and record current value"}',
        },
      },
      {
        type: "test:pass",
        data: {
          entryFile: file,
          file,
          testId: 4,
          name: "read and record current value",
        },
      },
      {
        type: "test:summary",
        data: {
          success: true,
          counts: { failed: 0, cancelled: 0 },
        },
      },
    ],
    {
      testRoot: "/consumer",
      files: [file],
      selectedTests: [],
      exitCode: 0,
      signal: null,
    },
  );

  assert.equal(record.lifecycle, "complete");
  assert.deepEqual(record.tests[0]?.observations, [
    { attempt: 1, key: "total", value: 17 },
  ]);
  assert.deepEqual(record.tests[0]?.reads, [
    {
      attempt: 1,
      referenceId: "business-copy",
      value: "🧭 active text",
      range: { path: "guide.md", start: 8, end: 22 },
    },
  ]);
});

void test("keeps duplicate observations visible without deduplication in event mapper", () => {
  const file = "/consumer/test/observations.test.mts";
  const record = collectNodeRun(
    [
      {
        type: "test:enqueue",
        data: {
          entryFile: file,
          file,
          testId: 5,
          parentId: 0,
          name: "duplicate observations",
          type: "test",
        },
      },
      ...[1, 1].map((value) => ({
        type: "test:diagnostic",
        data: {
          entryFile: file,
          file,
          testId: 5,
          message: `dock:observation:{"key":"same","value":${value},"testFullName":"duplicate observations"}`,
        },
      })),
      {
        type: "test:pass",
        data: {
          entryFile: file,
          file,
          testId: 5,
          name: "duplicate observations",
        },
      },
      {
        type: "test:summary",
        data: {
          success: true,
          counts: { failed: 0, cancelled: 0 },
        },
      },
    ],
    {
      testRoot: "/consumer",
      files: [file],
      selectedTests: [],
      exitCode: 0,
      signal: null,
    },
  );

  assert.deepEqual(record.tests[0]?.observations, [
    { attempt: 1, key: "same", value: 1 },
    { attempt: 1, key: "same", value: 1 },
  ]);
});

void test("attributes activities at the same source location by native test full name", () => {
  const file = "/consumer/test/loop.test.mts";
  const source = {
    entryFile: file,
    file,
    line: 4,
    column: 3,
  };
  const record = collectNodeRun(
    [
      ...[
        { testId: 1, name: "alpha", value: 1 },
        { testId: 2, name: "beta", value: 2 },
      ].flatMap(({ testId, name, value }) => [
        {
          type: "test:enqueue",
          data: {
            ...source,
            testId,
            parentId: 0,
            name,
            type: "test",
          },
        },
        {
          type: "test:diagnostic",
          data: {
            ...source,
            message: `dock:observation:{"key":"amount","value":${value},"testFullName":"${name}"}`,
          },
        },
        {
          type: "test:pass",
          data: { ...source, testId, name },
        },
      ]),
      {
        type: "test:summary",
        data: {
          success: true,
          counts: { tests: 2, failed: 0, cancelled: 0 },
        },
      },
    ],
    {
      testRoot: "/consumer",
      files: [file],
      selectedTests: [
        { file, name: "alpha" },
        { file, name: "beta" },
      ],
      exitCode: 0,
      signal: null,
    },
  );

  assert.equal(record.lifecycle, "complete");
  assert.deepEqual(
    record.tests.map((test) => test.observations),
    [
      [{ attempt: 1, key: "amount", value: 1 }],
      [{ attempt: 1, key: "amount", value: 2 }],
    ],
  );
});

void test("falls back to cyclic test parent marker when parent references form a cycle", () => {
  const file = "/consumer/test/cyclic.test.mts";
  const record = collectNodeRun(
    [
      {
        type: "test:enqueue",
        data: {
          entryFile: file,
          file,
          testId: 1,
          parentId: 2,
          name: "child",
          type: "test",
        },
      },
      {
        type: "test:enqueue",
        data: {
          entryFile: file,
          file,
          testId: 2,
          parentId: 1,
          name: "parent",
          type: "suite",
        },
      },
      {
        type: "test:pass",
        data: {
          entryFile: file,
          file,
          testId: 1,
          name: "child",
        },
      },
      {
        type: "test:summary",
        data: {
          success: true,
          counts: { failed: 0, cancelled: 0 },
        },
      },
    ],
    {
      testRoot: "/consumer",
      files: [file],
      selectedTests: [],
      exitCode: 0,
      signal: null,
    },
  );

  assert.equal(record.lifecycle, "complete");
  assert.equal(
    record.tests[0]?.id,
    JSON.stringify({
      file: "test/cyclic.test.mts",
      name: "<cyclic test parent> > parent > child",
    }),
  );
});
