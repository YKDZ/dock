import assert from "node:assert/strict";
import { test } from "node:test";

import {
  captureVitestCandidate,
  mapVitestRun,
  testIdentity,
} from "../src/event-mapper.ts";

test("目录从原生 parent/name 恢复嵌套路径并保留执行身份", () => {
  const outer = {
    type: "suite",
    name: "outer > label",
    errors: () => [],
  };
  const inner = {
    type: "suite",
    name: "inner",
    parent: outer,
    errors: () => [],
  };
  const nativeTest = {
    type: "test",
    name: "case",
    fullName: "outer > label > inner > case",
    suite: inner,
    result: () => ({ state: "passed", errors: [] }),
    meta: () => ({
      dockVitestAttemptCount: 1,
      dockVitestAttempts: [{ attempt: 1, observations: [], reads: [] }],
    }),
    diagnostic: () => ({ retryCount: 0 }),
    options: { mode: "run" },
  };
  const requestedFile = "/consumer/test/tree.test.mts";
  const candidate = captureVitestCandidate(
    [
      {
        moduleId: requestedFile,
        errors: () => [],
        children: {
          allSuites: () => [outer, inner],
          allTests: () => [nativeTest],
        },
      },
    ],
    [],
    "passed",
    "4.1.11",
    "/consumer",
    [requestedFile],
  );

  assert.deepEqual(candidate.catalog, {
    completeness: "complete",
    suites: [
      { file: "test/tree.test.mts", path: ["outer > label"] },
      { file: "test/tree.test.mts", path: ["outer > label", "inner"] },
    ],
    tests: [
      {
        identity: testIdentity(
          "test/tree.test.mts",
          ["outer > label", "inner"],
          "case",
        ),
        file: "test/tree.test.mts",
        suitePath: ["outer > label", "inner"],
        name: "case",
      },
    ],
  });
  assert.equal(
    candidate.tests[0]?.identity,
    candidate.catalog.tests[0]?.identity,
  );
});

test("展开标题相同的不同原生路径仍有独立执行身份", () => {
  const outer = { type: "suite", name: "outer", errors: () => [] };
  const flat = {
    type: "suite",
    name: "nested > child",
    suite: outer,
    errors: () => [],
  };
  const nested = {
    type: "suite",
    name: "nested",
    suite: outer,
    errors: () => [],
  };
  const nestedChild = {
    type: "suite",
    name: "child",
    suite: nested,
    errors: () => [],
  };
  const makeTest = (suite: object, value: number) => ({
    type: "test",
    name: "same",
    fullName: "outer > nested > child > same",
    suite,
    result: () => ({ state: "passed", errors: [] }),
    meta: () => ({
      dockVitestAttemptCount: 1,
      dockVitestAttempts: [
        {
          attempt: 1,
          observations: [{ attempt: 1, key: "count", value }],
          reads: [],
        },
      ],
    }),
    diagnostic: () => ({ retryCount: 0 }),
    options: { mode: "run" },
  });
  const requestedFile = "/consumer/test/collision.test.mts";
  const candidate = captureVitestCandidate(
    [
      {
        moduleId: requestedFile,
        errors: () => [],
        children: {
          allSuites: () => [outer, flat, nested, nestedChild],
          allTests: () => [makeTest(flat, 1), makeTest(nestedChild, 2)],
        },
      },
    ],
    [],
    "passed",
    "4.1.11",
    "/consumer",
    [requestedFile],
  );

  assert.deepEqual(
    candidate.tests.map((test) => test.status),
    ["passed", "passed"],
  );
  assert.deepEqual(
    candidate.catalog.tests.map((test) => test.suitePath),
    [
      ["outer", "nested > child"],
      ["outer", "nested", "child"],
    ],
  );
  assert.notEqual(candidate.tests[0]?.identity, candidate.tests[1]?.identity);
});

test("缺少请求文件会标记部分目录并保留已有发现", () => {
  const requestedFile = "/consumer/test/tree.test.mts";
  const candidate = captureVitestCandidate(
    [
      {
        moduleId: requestedFile,
        errors: () => [],
        children: { allSuites: () => [], allTests: () => [] },
      },
    ],
    [],
    "passed",
    "5.0.3",
    "/consumer",
    [requestedFile, "/consumer/test/missing.test.mts"],
  );
  const record = mapVitestRun(
    {
      version: "5.0.3",
      closed: true,
      closeErrors: [],
      candidate,
    },
    { code: 0, signal: null },
  );

  assert.equal(candidate.catalog.completeness, "partial");
  assert.deepEqual(candidate.catalog.tests, []);
  assert.equal(record.discovery?.completeness, "partial");
  assert.equal(record.complete, false);
});

test("原生收集错误会把目录标为部分，避免据此删除成员", () => {
  const requestedFile = "/consumer/test/tree.test.mts";
  const candidate = captureVitestCandidate(
    [
      {
        moduleId: requestedFile,
        errors: () => [],
        children: {
          allSuites: () => [
            { type: "suite", name: "部分组", errors: () => [] },
          ],
          allTests: () => [],
        },
      },
    ],
    [{ message: "suite collection failed" }],
    "failed",
    "5.0.3",
    "/consumer",
    [requestedFile],
  );

  assert.equal(candidate.catalog.completeness, "partial");
  assert.deepEqual(candidate.catalog.suites, [
    { file: "test/tree.test.mts", path: ["部分组"] },
  ]);
  assert.deepEqual(candidate.catalog.tests, []);
});

test("retry 次数使用 setup 实际开始数并与最终原生摘要核对", () => {
  const candidate = captureVitestCandidate(
    [
      {
        moduleId: "/consumer/test/retry.test.mts",
        errors: () => [],
        children: {
          allTests: () => [
            {
              name: "重试通过",
              fullName: "重试通过",
              result: () => ({ state: "passed", errors: [] }),
              meta: () => ({
                dockVitestAttemptCount: 2,
                dockVitestAttempts: [
                  { attempt: 1, observations: [], reads: [] },
                  { attempt: 2, observations: [], reads: [] },
                ],
              }),
              diagnostic: () => ({ retryCount: 1 }),
              options: { mode: "run" },
            },
          ],
          allSuites: () => [],
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

test("观察与读取保留原生尝试序号且不合并历史记录", () => {
  const candidate = captureVitestCandidate(
    [
      {
        moduleId: "/consumer/test/retry.test.mts",
        errors: () => [],
        children: {
          allTests: () => [
            {
              name: "最终尝试缺少观察",
              fullName: "最终尝试缺少观察",
              result: () => ({ state: "passed", errors: [] }),
              meta: () => ({
                dockVitestAttemptCount: 2,
                dockVitestAttempts: [
                  {
                    attempt: 1,
                    observations: [
                      { attempt: 1, key: "result", value: "早期值" },
                    ],
                    reads: [
                      {
                        attempt: 1,
                        referenceId: "guide",
                        value: "早期读取",
                        range: { path: "guide.md", start: 0, end: 4 },
                      },
                    ],
                  },
                  { attempt: 2, observations: [], reads: [] },
                ],
              }),
              diagnostic: () => ({ retryCount: 1 }),
              options: { mode: "run" },
            },
          ],
          allSuites: () => [],
        },
      },
    ],
    [],
    "passed",
    "5.0.3",
    "/consumer",
  );
  const record = mapVitestRun(
    {
      version: "5.0.3",
      closed: true,
      closeErrors: [],
      candidate,
    },
    { code: 0, signal: null },
  );

  assert.equal(
    record.tests.reduce((total, test) => total + test.attemptCount, 0),
    2,
  );
  assert.deepEqual(record.tests[0]?.observations, [
    { attempt: 1, key: "result", value: "早期值" },
  ]);
  assert.deepEqual(record.tests[0]?.reads, [
    {
      attempt: 1,
      referenceId: "guide",
      value: "早期读取",
      range: { path: "guide.md", start: 0, end: 4 },
    },
  ]);
});

test("共同收尾错误使运行无效，无关断言失败仍只作为测试状态", () => {
  const candidate = captureVitestCandidate(
    [
      {
        moduleId: "/consumer/test/shared.test.mts",
        errors: () => [],
        children: {
          allSuites: () => [
            {
              type: "suite",
              name: "共同收尾",
              fullName: "共同收尾",
              errors: () => [{ message: "嵌套 afterAll 失败" }],
              state: () => "failed",
            },
          ],
          allTests: () => [
            {
              name: "选定通过",
              fullName: "共同收尾 > 选定通过",
              result: () => ({ state: "passed", errors: undefined }),
              meta: () => ({
                dockVitestAttemptCount: 1,
                dockVitestAttempts: [
                  { attempt: 1, observations: [], reads: [] },
                ],
              }),
              diagnostic: () => ({ retryCount: 0 }),
              options: { mode: "run" },
            },
            {
              name: "无关失败",
              fullName: "共同收尾 > 无关失败",
              result: () => ({
                state: "failed",
                errors: [{ message: "无关纯断言失败" }],
              }),
              meta: () => ({
                dockVitestAttemptCount: 1,
                dockVitestAttempts: [
                  { attempt: 1, observations: [], reads: [] },
                ],
              }),
              diagnostic: () => ({ retryCount: 0 }),
              options: { mode: "run" },
            },
          ],
        },
      },
    ],
    [],
    "failed",
    "4.1.11",
    "/consumer",
  );

  assert.deepEqual(candidate.errors, ["嵌套 afterAll 失败"]);
  assert.deepEqual(
    candidate.tests.map((entry) => entry.status),
    ["passed", "failed"],
  );
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
      catalog: { completeness: "complete", suites: [], tests: [] },
      tests: [
        {
          identity: JSON.stringify({ file: "selected.test.mts", name: "选中" }),
          status: "passed",
          attemptCount: 1,
        },
        {
          identity: JSON.stringify({
            file: "extra.test.mts",
            name: "额外失败",
          }),
          status: "failed",
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

  assert.equal(record.complete, true);
  assert.deepEqual(record.issues, []);
  assert.deepEqual(
    record.tests.map((entry) => entry.status),
    ["passed", "failed"],
  );
  assert.equal(
    record.tests.reduce((total, test) => total + test.attemptCount, 0),
    2,
  );
  assert.deepEqual(record.command, {
    attempted: true,
    code: 1,
    signal: null,
  });
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
      catalog: { completeness: "complete", suites: [], tests: [] },
      tests: [
        {
          identity: JSON.stringify({ file: "test.test.mts", name: "断言失败" }),
          status: "failed",
          attemptCount: 1,
          message: "断言失败",
        },
      ],
    },
  };
  const record = mapVitestRun(receipt, { code: 0, signal: null });

  assert.equal(record.complete, false);
  assert.ok(
    record.issues.some((error) => error.code === "vitest-exit-mismatch"),
  );
  assert.deepEqual(record.command, {
    attempted: true,
    code: 0,
    signal: null,
  });
});

test("close 失败或缺少完整关闭收据使运行记录无效", () => {
  const complete = {
    version: "4.1.11",
    completed: true,
    tests: [],
    catalog: { completeness: "complete", suites: [], tests: [] },
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

  assert.equal(closeFailure.complete, false);
  assert.equal(
    closeFailure.issues.some((error) => error.code === "vitest-close-failed"),
    true,
  );
  assert.deepEqual(closeFailure.command, {
    attempted: true,
    code: 0,
    signal: null,
  });
  assert.equal(missingClose.complete, false);
});

test("缺少运行版本或关闭摘要的部分收据不暴露测试事实", () => {
  const record = mapVitestRun(
    {
      closed: true,
      candidate: {
        version: "4.1.11",
        completed: true,
        catalog: { completeness: "complete", suites: [], tests: [] },
        tests: [
          {
            identity: JSON.stringify({ file: "test.test.mts", name: "已通过" }),
            status: "passed",
            attemptCount: 1,
          },
        ],
        errors: [],
      },
    },
    { code: 0, signal: null },
  );

  assert.equal(record.complete, false);
  assert.equal(record.tests.length, 0);
  assert.ok(
    record.issues.some((error) => error.code === "vitest-receipt-incomplete"),
  );
});
