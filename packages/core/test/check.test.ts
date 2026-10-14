import assert from "node:assert/strict";
import { test } from "node:test";

import { accept, check } from "@dock/core";
import type {
  BindingDefinition,
  ReferenceDefinition,
  ReferenceFact,
} from "@dock/core";

const references: ReferenceDefinition[] = [
  {
    id: "preview-port-doc",
    target: { path: "docs/config/preview-options.md" },
    selection: { kind: "text", value: "- **Default:** `4173`" },
  },
  {
    id: "preview-port-file",
    target: { path: "config/preview.txt" },
    selection: { kind: "line", value: "port=4173" },
  },
  {
    id: "preview-port-exists",
    target: { path: "config/preview.txt" },
    selection: { kind: "exists" },
  },
];

const bindings: BindingDefinition[] = [
  {
    id: "preview-port",
    documents: ["preview-port-doc"],
    references: ["preview-port-exists", "preview-port-file"],
  },
];

const facts: ReferenceFact[] = [
  {
    referenceId: "preview-port-doc",
    value: "- **Default:** `4173`",
    range: { path: "docs/config/preview-options.md", start: 441, end: 462 },
  },
  { referenceId: "preview-port-file", value: "port=4173" },
  { referenceId: "preview-port-exists", value: true },
];

void test("无基线的有效关联报告新增差异，显式接受后相同事实一致", () => {
  const initial = check({ references, bindings, facts });
  const first = initial.bindings[0]!;

  assert.equal(first.consistency, "inconsistent");
  assert.equal(first.changes[0]?.kind, "binding-added");
  assert.deepEqual(first.current?.references["preview-port-doc"]?.range, {
    path: "docs/config/preview-options.md",
    start: 441,
    end: 462,
  });

  const accepted = accept(initial, undefined, ["preview-port"]);
  assert.equal(accepted.status, "accepted");
  if (accepted.status !== "accepted") return;

  const unchanged = check({
    references,
    bindings,
    facts,
    baseline: accepted.baseline,
  });
  assert.equal(unchanged.bindings[0]?.consistency, "consistent");
  assert.deepEqual(unchanged.bindings[0]?.changes, []);
});

void test("必需引用缺少、重复或返回错误时整条关联无法判定或接受", () => {
  const initial = check({ references, bindings, facts });
  const accepted = accept(initial, undefined, ["preview-port"]);
  assert.equal(accepted.status, "accepted");
  if (accepted.status !== "accepted") return;

  const missing = check({
    references,
    bindings,
    facts: facts.filter((fact) => fact.referenceId !== "preview-port-file"),
    baseline: accepted.baseline,
  });
  const missingResult = missing.bindings[0]!;
  if (!("errors" in missingResult)) throw new Error("缺失引用应产生核对错误。");
  assert.deepEqual(
    missingResult.errors.map((error) => [error.referenceId, error.code]),
    [["preview-port-file", "missing-evidence"]],
  );

  const baselineBeforeRejection = JSON.stringify(accepted.baseline);
  const rejected = accept(missing, accepted.baseline, ["preview-port"]);
  assert.equal(rejected.status, "rejected");
  assert.equal(JSON.stringify(accepted.baseline), baselineBeforeRejection);

  const duplicate = check({
    references,
    bindings,
    facts: [...facts, facts[1]!],
    baseline: accepted.baseline,
  });
  const duplicateResult = duplicate.bindings[0]!;
  if (!("errors" in duplicateResult))
    throw new Error("重复事实应产生核对错误。");
  assert.equal(duplicateResult.errors[0]?.code, "ambiguous-evidence");

  const failed = check({
    references,
    bindings,
    facts: [
      facts[0]!,
      facts[2]!,
      {
        referenceId: "preview-port-file",
        error: { code: "missing-file", message: "配置文件无法读取。" },
      },
    ],
    baseline: accepted.baseline,
  });
  const failedResult = failed.bindings[0]!;
  if (!("errors" in failedResult))
    throw new Error("引用读取错误应产生核对错误。");
  assert.equal(failedResult.errors[0]?.code, "missing-file");
});

void test("关联的两端都必须声明至少一个引用", () => {
  assert.throws(
    () =>
      check({
        references,
        bindings: [{ ...bindings[0]!, documents: [] }],
        facts,
      }),
    { name: "TypeError" },
  );
  assert.throws(
    () =>
      check({
        references,
        bindings: [{ ...bindings[0]!, references: [] }],
        facts,
      }),
    { name: "TypeError" },
  );
});

void test("当前位置变化不制造差异；事实、引用定义和关联关系分别留下解释", () => {
  const first = check({ references, bindings, facts });
  const accepted = accept(first, undefined, ["preview-port"]);
  assert.equal(accepted.status, "accepted");
  if (accepted.status !== "accepted") return;

  const moved = check({
    references: references.map((reference) => ({
      ...reference,
      note: "位置仍可更新",
    })),
    bindings: [{ ...bindings[0]!, note: "备注不参与比较" }],
    facts: facts.map((fact) =>
      fact.referenceId === "preview-port-doc"
        ? {
            ...fact,
            range: {
              ...fact.range!,
              start: fact.range!.start + 80,
              end: fact.range!.end + 80,
            },
          }
        : fact,
    ),
    baseline: accepted.baseline,
  });
  assert.equal(moved.bindings[0]?.consistency, "consistent");
  if ("current" in moved.bindings[0]!) {
    assert.equal(
      moved.bindings[0].current.references["preview-port-doc"]?.range?.start,
      521,
    );
  }

  const changedFact = check({
    references,
    bindings,
    facts: facts.map((fact) =>
      fact.referenceId === "preview-port-doc"
        ? { ...fact, value: "- **Default:** `4174`" }
        : fact,
    ),
    baseline: accepted.baseline,
  });
  assert.deepEqual(changedFact.bindings[0]?.changes, [
    {
      kind: "fact",
      referenceId: "preview-port-doc",
      before: "- **Default:** `4173`",
      after: "- **Default:** `4174`",
    },
  ]);

  const changedRightFact = check({
    references,
    bindings,
    facts: facts.map((fact) =>
      fact.referenceId === "preview-port-file"
        ? { ...fact, value: "port=4174" }
        : fact,
    ),
    baseline: accepted.baseline,
  });
  assert.deepEqual(
    changedRightFact.bindings[0]?.changes.map((change) =>
      change.kind === "fact" ? change.referenceId : change.kind,
    ),
    ["preview-port-file"],
  );

  const bothEndsChanged = check({
    references,
    bindings,
    facts: facts.map((fact) => {
      if (fact.referenceId === "preview-port-doc")
        return { ...fact, value: "- **Default:** `4174`" };
      if (fact.referenceId === "preview-port-file")
        return { ...fact, value: "port=4174" };
      return fact;
    }),
    baseline: accepted.baseline,
  });
  assert.deepEqual(
    bothEndsChanged.bindings[0]?.changes.map((change) =>
      change.kind === "fact" ? change.referenceId : change.kind,
    ),
    ["preview-port-doc", "preview-port-file"],
  );

  const reverted = check({
    references,
    bindings,
    facts,
    baseline: accepted.baseline,
  });
  assert.equal(reverted.bindings[0]?.consistency, "consistent");
  assert.deepEqual(reverted.bindings[0]?.changes, []);

  const changedDefinition = check({
    references: references.map((reference) =>
      reference.id === "preview-port-file"
        ? { ...reference, target: { path: "config/copied-preview.txt" } }
        : reference,
    ),
    bindings,
    facts,
    baseline: accepted.baseline,
  });
  assert.equal(changedDefinition.bindings[0]?.consistency, "inconsistent");
  assert.ok(
    changedDefinition.bindings[0]?.changes.some(
      (change) =>
        change.kind === "reference-definition" &&
        change.referenceId === "preview-port-file",
    ),
  );

  const withCondition = check({
    references: [
      ...references,
      {
        id: "preview-port-condition",
        target: { path: "docs/config/preview-options.md" },
        selection: { kind: "text", value: "If the port is occupied" },
      },
    ],
    bindings: [
      {
        ...bindings[0]!,
        documents: ["preview-port-doc", "preview-port-condition"],
      },
    ],
    facts: [
      ...facts,
      {
        referenceId: "preview-port-condition",
        value: "If the port is occupied",
      },
    ],
    baseline: accepted.baseline,
  });
  assert.ok(
    withCondition.bindings[0]?.changes.some(
      (change) => change.kind === "binding-definition",
    ),
  );
  assert.ok(
    withCondition.bindings[0]?.changes.some(
      (change) =>
        change.kind === "reference-added" &&
        change.referenceId === "preview-port-condition",
    ),
  );
});
