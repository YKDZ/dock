import assert from "node:assert/strict";
import { test } from "node:test";

import { checkWithCoverage } from "@dock/core";
import type { CheckInput, CoverageInput } from "@dock/core";

const checkInput: CheckInput = {
  references: [
    { id: "guide-a", target: { path: "docs/guide.md" } },
    { id: "guide-b", target: { path: "docs/guide.md" } },
    { id: "test-a", target: { kind: "test-case", name: "A" } },
    { id: "test-b", target: { kind: "test-case", name: "B" } },
    {
      id: "test-b-output",
      target: { kind: "test-observation", name: "B", key: "output" },
    },
    { id: "shared", target: { kind: "test-case", name: "shared" } },
  ],
  bindings: [
    {
      id: "alpha",
      documents: ["guide-a"],
      references: ["test-a", "shared"],
    },
    {
      id: "beta",
      documents: ["guide-b"],
      references: ["test-b", "test-b-output"],
    },
    {
      id: "gamma",
      documents: ["guide-a"],
      references: ["shared"],
    },
  ],
  facts: [
    {
      referenceId: "guide-a",
      value: "alpha section",
      range: { path: "docs/guide.md", start: 2, end: 8 },
    },
    {
      referenceId: "guide-b",
      value: "beta section",
      range: { path: "docs/guide.md", start: 6, end: 12 },
    },
    {
      referenceId: "test-a",
      error: { code: "test-failed", message: "A 的既有断言失败。" },
    },
    { referenceId: "test-b", value: { status: "passed" } },
    {
      referenceId: "test-b-output",
      error: { code: "test-skipped", message: "B 的选定测试被跳过。" },
    },
    { referenceId: "shared", value: { status: "passed" } },
  ],
  declarationCompleteness: "complete",
  scope: ["alpha", "beta", "gamma"],
};

const coverageInput: CoverageInput = {
  documentInventory: {
    complete: true,
    source: "fixtures/docs/**/*.md",
    exclusions: ["代码、测试、配置、依赖与构建产物不纳入文档集合。"],
    documents: [
      { path: "docs/guide.md", length: 20 },
      { path: "docs/orphan.md", length: 10 },
    ],
  },
  recordsComplete: true,
  actualExecutionCount: 3,
  declarations: [
    {
      bindingId: "alpha",
      referenceId: "guide-a",
      range: { path: "docs/guide.md", start: 2, end: 8 },
    },
    {
      bindingId: "beta",
      referenceId: "guide-b",
      range: { path: "docs/guide.md", start: 6, end: 12 },
    },
    {
      bindingId: "gamma",
      referenceId: "guide-a",
      range: { path: "docs/guide.md", start: 2, end: 8 },
    },
  ],
  readHits: [
    { path: "docs/guide.md", start: 0, end: 10 },
    { path: "docs/guide.md", start: 8, end: 15 },
  ],
  referenceExecutions: [
    { bindingId: "alpha", referenceId: "test-a" },
    { bindingId: "alpha", referenceId: "shared" },
    { bindingId: "beta", referenceId: "test-b" },
    { bindingId: "gamma", referenceId: "shared" },
  ],
  sources: {
    declarations: "当前静态选择器返回的范围。",
    readHits: "同次 Node 测试运行中的 readDocument 记录。",
    bindingExecutions: "同次 Node 测试运行中的已发生右端引用记录。",
  },
};

void test("完整记录发布并集覆盖，保留失败执行并拒绝部分右侧命中", () => {
  const result = checkWithCoverage({ ...checkInput, coverage: coverageInput });
  assert.ok("report" in result);
  if (!("report" in result)) return;

  assert.equal(result.report.bindings[0]?.bindingId, "alpha");
  assert.ok("errors" in result.report.bindings[0]!);
  assert.equal(result.report.bindings[2]?.consistency, "inconsistent");
  assert.deepEqual(result.report.coverage.validationScope, [
    "alpha",
    "beta",
    "gamma",
  ]);
  assert.equal(
    result.report.coverage.documentInventory.source,
    "fixtures/docs/**/*.md",
  );
  assert.equal(result.report.coverage.declaration.coveredUnits, 10);
  assert.equal(result.report.coverage.declaration.totalUnits, 30);
  assert.equal(result.report.coverage.documentInventory.totalUnits, 30);
  assert.deepEqual(result.report.coverage.documentInventory.paths, [
    "docs/guide.md",
    "docs/orphan.md",
  ]);
  assert.deepEqual(result.report.coverage.documentInventory.exclusions, [
    "代码、测试、配置、依赖与构建产物不纳入文档集合。",
  ]);
  assert.equal(result.report.coverage.readHits.coveredUnits, 15);
  assert.equal(result.report.coverage.bindingExecutionHits.coveredUnits, 6);
  assert.deepEqual(result.report.coverage.bindingExecution.hitBindingIds, [
    "alpha",
    "gamma",
  ]);
  assert.deepEqual(result.report.coverage.bindingExecution.unhitBindingIds, [
    "beta",
  ]);
  assert.deepEqual(result.report.coverage.declaration.uncoveredRanges, [
    {
      path: "docs/guide.md",
      ranges: [
        { start: 0, end: 2 },
        { start: 12, end: 20 },
      ],
    },
    { path: "docs/orphan.md", ranges: [{ start: 0, end: 10 }] },
  ]);
  assert.equal(result.report.coverage.actualExecutionCount, 3);
  assert.equal(result.report.coverage.readHitCount, 2);
  assert.equal(result.report.coverage.unit, "utf16-code-unit");
});

void test("采集或声明资料不完整时只返回错误，不发布部分报告", () => {
  const result = checkWithCoverage({
    ...checkInput,
    coverage: { ...coverageInput, recordsComplete: false },
  });
  assert.ok("errors" in result);
  if ("errors" in result) {
    assert.ok(
      result.errors.some((error) => error.code === "incomplete-records"),
    );
  }

  const partialDeclarations = checkWithCoverage({
    ...checkInput,
    declarationCompleteness: "partial",
    coverage: coverageInput,
  });
  assert.ok("errors" in partialDeclarations);
  if ("errors" in partialDeclarations) {
    assert.ok(
      partialDeclarations.errors.some(
        (error) => error.code === "partial-declarations",
      ),
    );
  }

  const invalidRange = checkWithCoverage({
    ...checkInput,
    coverage: {
      ...coverageInput,
      declarations: coverageInput.declarations.map((declaration) =>
        declaration.bindingId === "beta"
          ? { ...declaration, range: { ...declaration.range, end: 21 } }
          : declaration,
      ),
    },
  });
  assert.ok("errors" in invalidRange);
  if ("errors" in invalidRange) {
    assert.ok(
      invalidRange.errors.some(
        (error) => error.code === "invalid-declaration-range",
      ),
    );
  }
});
