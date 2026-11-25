import assert from "node:assert/strict";
import { test } from "node:test";

import {
  captureVitestCandidate,
  mapVitestRun,
  testIdentity,
} from "../../src/vitest/event-mapper.ts";

void test("catalog reconstructs nested paths from native parent/name and preserves execution identity", () => {
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

void test("distinct native paths with the same flattened title keep separate execution identities", () => {
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

void test("missing requested file marks catalog partial while preserving discovered entries", () => {
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

void test("native collection errors mark catalog partial to avoid dropping members", () => {
  const requestedFile = "/consumer/test/tree.test.mts";
  const candidate = captureVitestCandidate(
    [
      {
        moduleId: requestedFile,
        errors: () => [],
        children: {
          allSuites: () => [
            { type: "suite", name: "partial group", errors: () => [] },
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
    { file: "test/tree.test.mts", path: ["partial group"] },
  ]);
  assert.deepEqual(candidate.catalog.tests, []);
});

void test("retry count uses setup attempt count and reconciles with final native summary", () => {
  const candidate = captureVitestCandidate(
    [
      {
        moduleId: "/consumer/test/retry.test.mts",
        errors: () => [],
        children: {
          allTests: () => [
            {
              name: "passes on retry",
              fullName: "passes on retry",
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

void test("observations and reads retain native attempt indices without merging prior attempts", () => {
  const candidate = captureVitestCandidate(
    [
      {
        moduleId: "/consumer/test/retry.test.mts",
        errors: () => [],
        children: {
          allTests: () => [
            {
              name: "final attempt missing observation",
              fullName: "final attempt missing observation",
              result: () => ({ state: "passed", errors: [] }),
              meta: () => ({
                dockVitestAttemptCount: 2,
                dockVitestAttempts: [
                  {
                    attempt: 1,
                    observations: [
                      { attempt: 1, key: "result", value: "early value" },
                    ],
                    reads: [
                      {
                        attempt: 1,
                        referenceId: "guide",
                        value: "early read",
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
    { attempt: 1, key: "result", value: "early value" },
  ]);
  assert.deepEqual(record.tests[0]?.reads, [
    {
      attempt: 1,
      referenceId: "guide",
      value: "early read",
      range: { path: "guide.md", start: 0, end: 4 },
    },
  ]);
});

void test("shared teardown errors invalidate the run while unrelated assertion failures remain test statuses", () => {
  const candidate = captureVitestCandidate(
    [
      {
        moduleId: "/consumer/test/shared.test.mts",
        errors: () => [],
        children: {
          allSuites: () => [
            {
              type: "suite",
              name: "shared teardown",
              fullName: "shared teardown",
              errors: () => [{ message: "nested afterAll failed" }],
              state: () => "failed",
            },
          ],
          allTests: () => [
            {
              name: "selected passed",
              fullName: "shared teardown > selected passed",
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
              name: "unrelated failure",
              fullName: "shared teardown > unrelated failure",
              result: () => ({
                state: "failed",
                errors: [{ message: "unrelated assertion failure" }],
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

  assert.deepEqual(candidate.errors, ["nested afterAll failed"]);
  assert.deepEqual(
    candidate.tests.map((entry) => entry.status),
    ["passed", "failed"],
  );
});

void test("explained unrelated assertion failures do not invalidate passing run facts", () => {
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
          identity: JSON.stringify({
            file: "selected.test.mts",
            name: "selected",
          }),
          status: "passed",
          attemptCount: 1,
        },
        {
          identity: JSON.stringify({
            file: "extra.test.mts",
            name: "extra failure",
          }),
          status: "failed",
          attemptCount: 1,
          message: "assertion failed",
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

void test("mismatched terminal event and native command exit code fails run completeness", () => {
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
          identity: JSON.stringify({
            file: "test.test.mts",
            name: "assertion failed",
          }),
          status: "failed",
          attemptCount: 1,
          message: "assertion failed",
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

void test("close failures or missing close receipts invalidate the run record", () => {
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

void test("partial receipts missing run version or close summary expose no test facts", () => {
  const record = mapVitestRun(
    {
      closed: true,
      candidate: {
        version: "4.1.11",
        completed: true,
        catalog: { completeness: "complete", suites: [], tests: [] },
        tests: [
          {
            identity: JSON.stringify({
              file: "test.test.mts",
              name: "passed",
            }),
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
