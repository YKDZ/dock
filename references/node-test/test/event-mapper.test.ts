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
});
