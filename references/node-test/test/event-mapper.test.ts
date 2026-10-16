import assert from "node:assert/strict";
import { test } from "node:test";

import { collectNodeRun } from "../src/event-mapper.ts";

test("原生摘要与进程退出码冲突时不形成完整执行记录", () => {
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
          name: "业务状态通过",
          type: "test",
        },
      },
      {
        type: "test:pass",
        data: {
          entryFile: file,
          file,
          testId: 1,
          name: "业务状态通过",
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

test("缺少原生最终摘要时不把零退出码当成成功回执", () => {
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

test("尚未开始的选中测试不计入实际尝试数", () => {
  const record = collectNodeRun([], {
    testRoot: "/consumer",
    files: ["/consumer/test/status.test.mts"],
    selectedTests: [
      { file: "/consumer/test/status.test.mts", name: "尚未运行" },
    ],
    exitCode: 0,
    signal: null,
  });

  assert.equal(record.tests[0]?.started, false);
  assert.equal(record.tests[0]?.attemptCount, 0);
  assert.equal(record.testExecutions, 0);
});

test("原生中断事件或进程信号都使运行记录失效", () => {
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

test("活动测试的观察和读取按原生测试身份保留真实值与位置", () => {
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
          name: "读取并观察当前值",
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
          message: 'dock:observation:{"key":"total","value":17}',
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
            'dock:read:{"referenceId":"business-copy","value":"🧭 active text","range":{"path":"guide.md","start":8,"end":22}}',
        },
      },
      {
        type: "test:pass",
        data: {
          entryFile: file,
          file,
          testId: 4,
          name: "读取并观察当前值",
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
    { key: "total", value: 17 },
  ]);
  assert.deepEqual(record.tests[0]?.reads, [
    {
      referenceId: "business-copy",
      value: "🧭 active text",
      range: { path: "guide.md", start: 8, end: 22 },
    },
  ]);
});

test("同一测试的重复观察保持可见而不被映射层去重", () => {
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
          name: "重复观察",
          type: "test",
        },
      },
      ...[1, 1].map((value) => ({
        type: "test:diagnostic",
        data: {
          entryFile: file,
          file,
          testId: 5,
          message: `dock:observation:{"key":"same","value":${value}}`,
        },
      })),
      {
        type: "test:pass",
        data: {
          entryFile: file,
          file,
          testId: 5,
          name: "重复观察",
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
    { key: "same", value: 1 },
    { key: "same", value: 1 },
  ]);
});
