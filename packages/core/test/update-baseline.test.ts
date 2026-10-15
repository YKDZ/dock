import assert from "node:assert/strict";
import { test } from "node:test";

import { check, updateBaseline } from "@dock/core";
import type { Baseline, CheckInput, JsonValue } from "@dock/core";

void test("直接建立基线并更新当前有效差异，无须先取得检查报告", () => {
  const input: CheckInput = {
    references: [{ id: "result", target: { kind: "observation" } }],
    bindings: [{ id: "mechanism", references: ["result"] }],
    facts: [{ referenceId: "result", value: { sameReference: true } }],
  };
  const created = updateBaseline(input);
  assert.equal(created.status, "updated");
  if (created.status !== "updated") return;
  assert.equal(created.baseline.version, 2);
  assert.equal(created.report.bindings[0]?.consistency, "inconsistent");

  const current: CheckInput = {
    ...input,
    baseline: created.baseline,
    facts: [{ referenceId: "result", value: { sameReference: false } }],
  };
  const updated = updateBaseline(current);
  assert.equal(updated.status, "updated");
  if (updated.status !== "updated") return;
  assert.deepEqual(updated.report.bindings[0]?.changes, [
    {
      kind: "fact",
      referenceId: "result",
      before: { sameReference: true },
      after: { sameReference: false },
    },
  ]);
  assert.equal(
    check({ ...current, baseline: updated.baseline }).bindings[0]?.consistency,
    "consistent",
  );
  assert.deepEqual(
    created.baseline.bindings.mechanism?.references.result?.value,
    { sameReference: true },
  );
});

void test("不支持或损坏的基线明确失败，不能冒充首次建立", () => {
  const input: CheckInput = {
    references: [{ id: "setting", target: { path: "setting.txt" } }],
    bindings: [{ id: "configuration", references: ["setting"] }],
    facts: [{ referenceId: "setting", value: "current" }],
  };
  const created = updateBaseline(input);
  assert.equal(created.status, "updated");
  if (created.status !== "updated") return;

  const unsupported = {
    ...created.baseline,
    version: 1,
  } as unknown as Baseline;
  const damaged = structuredClone(created.baseline);
  damaged.bindings.configuration!.references.setting!.value = Number.NaN;
  for (const baseline of [unsupported, damaged]) {
    assert.throws(() => check({ ...input, baseline }), TypeError);
    assert.throws(() => updateBaseline({ ...input, baseline }), TypeError);
  }
});

void test("空的更新范围不能隐式清空已有基线", () => {
  const input: CheckInput = {
    references: [{ id: "setting", target: "setting" }],
    bindings: [{ id: "configuration", references: ["setting"] }],
    facts: [{ referenceId: "setting", value: "current" }],
  };
  const created = updateBaseline(input);
  assert.equal(created.status, "updated");
  if (created.status !== "updated") return;
  const before = JSON.stringify(created.baseline);
  const result = updateBaseline({
    references: [],
    bindings: [],
    facts: [],
    baseline: created.baseline,
    scope: [],
  });
  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") return;
  assert.equal(result.errors[0]?.code, "empty-selection");
  assert.equal(JSON.stringify(created.baseline), before);
});

void test("无效事实阻断所选批次，无关关联仍可更新为可重读基线", () => {
  const input: CheckInput = {
    references: [
      { id: "valid", target: "valid" },
      { id: "invalid", target: "invalid" },
    ],
    bindings: [
      { id: "valid-binding", references: ["valid"] },
      { id: "invalid-binding", references: ["invalid"] },
    ],
    facts: [
      { referenceId: "valid", value: 1 },
      { referenceId: "invalid", value: 1 },
    ],
  };
  const initial = updateBaseline(input);
  assert.equal(initial.status, "updated");
  if (initial.status !== "updated") return;
  const before = JSON.stringify(initial.baseline);
  const sparse: JsonValue[] = [];
  sparse.length = 1;
  const invalidValues: JsonValue[] = [NaN, Infinity, { duration: NaN }, sparse];
  for (const value of invalidValues) {
    const current: CheckInput = {
      ...input,
      baseline: initial.baseline,
      facts: [
        { referenceId: "valid", value: 2 },
        { referenceId: "invalid", value },
      ],
    };
    const rejected = updateBaseline(current);
    assert.equal(rejected.status, "rejected");
    if (rejected.status !== "rejected") return;
    assert.deepEqual(
      rejected.errors.map((error) => [
        error.bindingId,
        error.referenceId,
        error.code,
      ]),
      [["invalid-binding", "invalid", "invalid-fact"]],
    );
    assert.equal(
      rejected.report.bindings.find(
        (binding) => binding.bindingId === "invalid-binding",
      )?.consistency,
      undefined,
    );
    assert.equal(JSON.stringify(initial.baseline), before);

    const selected: CheckInput = { ...current, scope: ["valid-binding"] };
    const updated = updateBaseline(selected);
    assert.equal(updated.status, "updated");
    if (updated.status !== "updated") return;
    const roundTripped = JSON.parse(
      JSON.stringify(updated.baseline),
    ) as Baseline;
    assert.equal(
      check({ ...selected, baseline: roundTripped }).bindings[0]?.consistency,
      "consistent",
    );
    assert.equal(
      roundTripped.bindings["invalid-binding"]?.references.invalid?.value,
      1,
    );
  }
});

void test("成员中的无效值保留成员错误，不能形成新基线或伪造成员移除", () => {
  const input: CheckInput = {
    references: [{ id: "group", target: "test-group" }],
    bindings: [{ id: "group-binding", references: ["group"] }],
    facts: [
      {
        referenceId: "group",
        collection: {
          completeness: "complete",
          members: [
            { id: "invalid", value: 1 },
            { id: "valid", value: 1 },
          ],
        },
      },
    ],
  };
  const initial = updateBaseline(input);
  assert.equal(initial.status, "updated");
  if (initial.status !== "updated") return;
  const current: CheckInput = {
    ...input,
    baseline: initial.baseline,
    facts: [
      {
        referenceId: "group",
        collection: {
          completeness: "complete",
          members: [
            { id: "invalid", value: { duration: Infinity } },
            { id: "valid", value: 2 },
          ],
        },
      },
    ],
  };
  const rejected = updateBaseline(current);
  assert.equal(rejected.status, "rejected");
  if (rejected.status !== "rejected") return;
  assert.deepEqual(
    rejected.errors.map((error) => [
      error.referenceId,
      error.memberId,
      error.code,
    ]),
    [["group", "invalid", "invalid-fact"]],
  );
  assert.deepEqual(rejected.report.bindings[0]?.changes, [
    {
      kind: "fact",
      referenceId: "group",
      memberChanges: [
        {
          memberId: "valid",
          beforePresent: true,
          afterPresent: true,
          before: 1,
          after: 2,
        },
      ],
      beforeKind: "member-collection",
      afterKind: "member-collection",
    },
  ]);
});

void test("引用定义中的无效值是证据错误，已存入基线时则是损坏的基线", () => {
  const input: CheckInput = {
    references: [
      { id: "setting", target: { path: "settings" }, selection: ["limit"] },
    ],
    bindings: [{ id: "configuration", references: ["setting"] }],
    facts: [{ referenceId: "setting", value: 1 }],
  };
  const initial = updateBaseline(input);
  assert.equal(initial.status, "updated");
  if (initial.status !== "updated") return;

  const invalidDefinitions = [
    { ...input.references[0]!, target: NaN },
    { ...input.references[0]!, selection: { limit: Infinity } },
  ];
  for (const definition of invalidDefinitions) {
    const current: CheckInput = {
      ...input,
      references: [definition],
      baseline: initial.baseline,
    };
    const rejected = updateBaseline(current);
    assert.equal(rejected.status, "rejected");
    if (rejected.status !== "rejected") return;
    assert.deepEqual(
      rejected.errors.map((error) => [error.referenceId, error.code]),
      [["setting", "invalid-reference-definition"]],
    );
    assert.equal(rejected.report.bindings[0]?.consistency, undefined);

    const damaged = structuredClone(initial.baseline);
    damaged.bindings.configuration!.references.setting!.definition = definition;
    assert.throws(() => check({ ...input, baseline: damaged }), TypeError);
    assert.throws(
      () => updateBaseline({ ...input, baseline: damaged }),
      TypeError,
    );
  }
});
