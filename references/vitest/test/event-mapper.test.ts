import assert from "node:assert/strict";
import { test } from "node:test";

import { captureVitestCandidate, mapVitestRun } from "../src/event-mapper.ts";

test("retry 次数使用 setup 实际开始数并与最终原生摘要核对", () => {
  const candidate = captureVitestCandidate(
    [
      {
        moduleId: "/consumer/test/retry.test.mts",
        errors: () => [],
        children: {
          allTests: () => [
            {
              fullName: "重试通过",
              result: () => ({ state: "passed", errors: [] }),
              meta: () => ({ dockVitestAttemptCount: 2 }),
              diagnostic: () => ({ retryCount: 1 }),
              options: { mode: "run" },
            },
          ],
        },
      },
    ],
    [],
    "passed",
    "4.1.11",
    "/consumer",
  );

  assert.equal(candidate.completed, true);
  assert.deepEqual(candidate.errors, []);
  assert.equal(candidate.tests[0]?.status, "passed");
  assert.equal(candidate.tests[0]?.attemptCount, 2);
});

test("可解释的无关断言失败不使已通过测试的运行事实无效", () => {
  const receipt = {
    version: "5.0.3",
    closed: true,
    closeErrors: [],
    candidate: {
      version: "5.0.3",
      completed: true,
      errors: [],
      tests: [
        {
          id: JSON.stringify({ file: "selected.test.mts", name: "选中" }),
          status: "passed",
          started: true,
          attemptCount: 1,
        },
        {
          id: JSON.stringify({ file: "extra.test.mts", name: "额外失败" }),
          status: "failed",
          started: true,
          attemptCount: 1,
          message: "断言失败",
        },
      ],
    },
  };

  const record = mapVitestRun(receipt, {
    code: 1,
    signal: null,
  });

  assert.equal(record.lifecycle, "complete");
  assert.deepEqual(record.errors, []);
  assert.deepEqual(
    record.tests.map((entry) => entry.status),
    ["passed", "failed"],
  );
  assert.equal(record.testExecutions, 2);
  assert.deepEqual(record.commandResult, { exitCode: 1, signal: null });
});

test("终态事件与原生命令结果冲突时不形成完整运行", () => {
  const receipt = {
    version: "4.1.11",
    closed: true,
    closeErrors: [],
    candidate: {
      version: "4.1.11",
      completed: true,
      errors: [],
      tests: [
        {
          id: JSON.stringify({ file: "test.test.mts", name: "断言失败" }),
          status: "failed",
          started: true,
          attemptCount: 1,
          message: "断言失败",
        },
      ],
    },
  };
  const record = mapVitestRun(receipt, { code: 0, signal: null });

  assert.equal(record.lifecycle, "incomplete");
  assert.ok(
    record.errors.some((error) => error.code === "vitest-exit-mismatch"),
  );
  assert.deepEqual(record.commandResult, { exitCode: 0, signal: null });
});

test("close 失败或缺少完整关闭收据使运行记录无效", () => {
  const complete = {
    version: "4.1.11",
    completed: true,
    tests: [],
    errors: [],
  };
  const closeFailure = mapVitestRun(
    {
      version: "4.1.11",
      closed: true,
      candidate: complete,
      closeErrors: ["teardown failed"],
    },
    { code: 0, signal: null },
  );
  const missingClose = mapVitestRun(
    {
      version: "4.1.11",
      closed: false,
      candidate: complete,
      closeErrors: [],
    },
    { code: 0, signal: null },
  );

  assert.equal(closeFailure.lifecycle, "incomplete");
  assert.equal(
    closeFailure.errors.some((error) => error.code === "vitest-close-failed"),
    true,
  );
  assert.deepEqual(closeFailure.commandResult, { exitCode: 0, signal: null });
  assert.equal(missingClose.lifecycle, "incomplete");
});

test("缺少运行版本或关闭摘要的部分收据不暴露测试事实", () => {
  const record = mapVitestRun(
    {
      closed: true,
      candidate: {
        version: "4.1.11",
        completed: true,
        tests: [
          {
            id: JSON.stringify({ file: "test.test.mts", name: "已通过" }),
            status: "passed",
            started: true,
            attemptCount: 1,
          },
        ],
        errors: [],
      },
    },
    { code: 0, signal: null },
  );

  assert.equal(record.lifecycle, "incomplete");
  assert.equal(record.tests.length, 0);
  assert.ok(
    record.errors.some((error) => error.code === "vitest-receipt-incomplete"),
  );
});
