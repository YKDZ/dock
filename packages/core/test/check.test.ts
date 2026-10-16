import assert from "node:assert/strict";
import { test } from "node:test";

import { check, updateBaseline } from "@dock/core";
import type {
  BindingCheckResult,
  BindingDefinition,
  CheckError,
  CheckInput,
  DeclarationCompleteness,
  MemberDiscoveryCompleteness,
  ReferenceDefinition,
  ReferenceMemberResult,
  ReferenceResult,
  TextRange,
} from "@dock/core";

const references: ReferenceDefinition[] = [
  {
    id: "preview-port-doc",
    target: { path: "docs/config/preview-options.md" },
    selection: { kind: "text", value: "- **Default:** `4173`" },
  },
  {
    id: "preview-port-file",
    target: { path: "config/preview.txt", processor: "file" },
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
    references: [
      "preview-port-doc",
      "preview-port-exists",
      "preview-port-file",
    ],
  },
];

const previewRange: TextRange = {
  path: "docs/config/preview-options.md",
  start: 441,
  end: 462,
};
const facts: ReferenceResult[] = [
  {
    referenceId: "preview-port-doc",
    value: "- **Default:** `4173`",
    range: previewRange,
  },
  { referenceId: "preview-port-file", value: "port=4173" },
  { referenceId: "preview-port-exists", value: true },
];

void test("非空引用集合直接核对单个测试和无文档的测试组合", () => {
  const reportInput: CheckInput = {
    references: [
      { id: "first-test", target: { kind: "test", id: "first" } },
      { id: "second-test", target: { kind: "test", id: "second" } },
    ],
    bindings: [
      { id: "one-test", references: ["first-test"] },
      { id: "two-tests", references: ["first-test", "second-test"] },
    ],
    facts: [
      { referenceId: "first-test", value: { status: "passed" } },
      { referenceId: "second-test", value: { status: "passed" } },
    ],
  };
  const report = check(reportInput);

  assert.deepEqual(
    report.bindings.map((binding) => binding.consistency),
    ["inconsistent", "inconsistent"],
  );
  assert.deepEqual(report.bindings[1]?.current?.definition.references, [
    "first-test",
    "second-test",
  ]);
});

void test("空集合、重复身份及未声明的必需引用不能取得关联结果", () => {
  for (const [ids, code] of [
    [[], "invalid-binding-definition"],
    [["preview-port-file", "preview-port-file"], "invalid-binding-definition"],
    [["unknown"], "undeclared-reference"],
  ] as const) {
    const input: CheckInput = {
      references,
      bindings: [{ id: "invalid", references: [...ids] }],
      facts,
    };
    const result = check(input).bindings[0]!;
    assert.equal(result.consistency, undefined);
    assert.equal(result.errors?.[0]?.code, code);
    assert.equal(updateBaseline(input).status, "rejected");
  }

  const repeatedBinding: BindingDefinition = {
    id: "repeated-binding",
    references: ["preview-port-file"],
  };
  for (const repeatedBindings of [
    [repeatedBinding, repeatedBinding],
    [{ ...repeatedBinding }, { ...repeatedBinding }],
  ]) {
    assert.throws(
      () => check({ references, bindings: repeatedBindings, facts }),
      /关联 ID 重复：repeated-binding/u,
    );
  }
});

void test("无基线的有效关联报告新增差异，显式更新基线后相同事实一致", () => {
  const initialInput: CheckInput = { references, bindings, facts };
  const initial = check(initialInput);
  const first = initial.bindings[0]!;

  assert.equal(first.consistency, "inconsistent");
  assert.equal(first.changes[0]?.kind, "binding-added");
  assert.deepEqual(first.current?.references["preview-port-doc"]?.range, {
    path: "docs/config/preview-options.md",
    start: 441,
    end: 462,
  });

  const updated = updateBaseline({ ...initialInput, scope: ["preview-port"] });
  assert.equal(updated.status, "updated");
  if (updated.status !== "updated") return;

  const unchanged = check({
    references,
    bindings,
    facts,
    baseline: updated.baseline,
  });
  assert.equal(unchanged.bindings[0]?.consistency, "consistent");
  assert.deepEqual(unchanged.bindings[0]?.changes, []);
});

void test("必需引用缺少、重复或返回错误时整条关联无法判定或更新基线", () => {
  const initialInput: CheckInput = { references, bindings, facts };
  const updated = updateBaseline({ ...initialInput, scope: ["preview-port"] });
  assert.equal(updated.status, "updated");
  if (updated.status !== "updated") return;

  const missingInput: CheckInput = {
    references,
    bindings,
    facts: facts.filter((fact) => fact.referenceId !== "preview-port-file"),
    baseline: updated.baseline,
  };
  const missing = check(missingInput);
  const missingResult = missing.bindings[0]!;
  if (!("errors" in missingResult)) throw new Error("缺失引用应产生核对错误。");
  assert.deepEqual(
    missingResult.errors.map((error) => [error.referenceId, error.code]),
    [["preview-port-file", "missing-evidence"]],
  );

  const baselineBeforeRejection = JSON.stringify(updated.baseline);
  const rejected = updateBaseline({
    ...missingInput,
    baseline: updated.baseline,
    scope: ["preview-port"],
  });
  assert.equal(rejected.status, "rejected");
  assert.equal(JSON.stringify(updated.baseline), baselineBeforeRejection);

  const duplicate = check({
    references,
    bindings,
    facts: [...facts, facts[1]!],
    baseline: updated.baseline,
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
    baseline: updated.baseline,
  });
  const failedResult = failed.bindings[0]!;
  if (!("errors" in failedResult))
    throw new Error("引用读取错误应产生核对错误。");
  assert.equal(failedResult.errors[0]?.code, "missing-file");
});

void test("完整成员清单按稳定 ID 比较，更新基线增删后可再次核对", () => {
  const groupReferences: ReferenceDefinition[] = [
    { id: "preview-doc", target: { path: "docs/preview.md" } },
    {
      id: "preview-group",
      target: {
        kind: "test-group",
        project: "web",
        file: "tests/preview.test.ts",
        path: ["preview"],
      },
    },
  ];
  const groupBindings: BindingDefinition[] = [
    {
      id: "preview-policy",
      references: ["preview-doc", "preview-group"],
    },
  ];
  const initialFacts: ReferenceResult[] = [
    { referenceId: "preview-doc", value: "Preview policy" },
    {
      referenceId: "preview-group",
      collection: {
        completeness: "complete",
        members: [
          {
            id: "suite/preview/test/keeps-query",
            value: ["beforeEach", "query"],
          },
          { id: "suite/preview/test/shows-warning", value: ["warning"] },
        ],
      },
    },
  ];
  const initialInput: CheckInput = {
    references: groupReferences,
    bindings: groupBindings,
    facts: initialFacts,
  };
  const created = updateBaseline({
    ...initialInput,
    scope: ["preview-policy"],
  });
  assert.equal(created.status, "updated");
  if (created.status !== "updated") return;

  const baseline = created.baseline;
  const reordered = check({
    references: groupReferences,
    bindings: groupBindings,
    facts: [
      initialFacts[0]!,
      {
        referenceId: "preview-group",
        collection: {
          completeness: "complete",
          members: [
            { id: "suite/preview/test/shows-warning", value: ["warning"] },
            {
              id: "suite/preview/test/keeps-query",
              value: ["beforeEach", "query"],
            },
          ],
        },
      },
    ],
    baseline,
  });
  assert.equal(reordered.bindings[0]?.consistency, "consistent");

  const changedFacts: ReferenceResult[] = [
    initialFacts[0]!,
    {
      referenceId: "preview-group",
      collection: {
        completeness: "complete",
        members: [
          {
            id: "suite/preview/test/keeps-query",
            value: ["beforeEach", "query"],
          },
          { id: "suite/preview/test/shows-warning", value: ["warning"] },
          {
            id: "suite/preview/test/rejects-empty-result",
            value: ["renders", "rejects empty"],
          },
        ],
      },
    },
  ];
  const changedInput: CheckInput = {
    references: groupReferences,
    bindings: groupBindings,
    facts: changedFacts,
    baseline,
  };
  const changed = check(changedInput);
  const changedBinding = changed.bindings[0]!;
  assert.deepEqual(
    changedBinding.changes.map((change) => change.kind),
    ["fact"],
  );
  assert.deepEqual(changedBinding.changes[0], {
    kind: "fact",
    referenceId: "preview-group",
    memberChanges: [
      {
        memberId: "suite/preview/test/rejects-empty-result",
        beforePresent: false,
        afterPresent: true,
        after: ["renders", "rejects empty"],
      },
    ],
    beforeKind: "member-collection",
    afterKind: "member-collection",
  });
  const updated = updateBaseline({
    ...changedInput,
    baseline: baseline,
    scope: ["preview-policy"],
  });
  assert.equal(updated.status, "updated");
  if (updated.status !== "updated") return;

  const afterUpdate = check({
    references: groupReferences,
    bindings: groupBindings,
    facts: changedFacts,
    baseline: updated.baseline,
  });
  assert.equal(afterUpdate.bindings[0]?.consistency, "consistent");

  const removedFacts: ReferenceResult[] = [
    initialFacts[0]!,
    {
      referenceId: "preview-group",
      collection: {
        completeness: "complete",
        members: [
          {
            id: "suite/preview/test/keeps-query",
            value: ["beforeEach", "query"],
          },
          { id: "suite/preview/test/shows-warning", value: ["warning"] },
        ],
      },
    },
  ];
  const removedInput: CheckInput = {
    references: groupReferences,
    bindings: groupBindings,
    facts: removedFacts,
    baseline: updated.baseline,
  };
  const removed = check(removedInput);
  assert.deepEqual(removed.bindings[0]?.changes[0], {
    kind: "fact",
    referenceId: "preview-group",
    memberChanges: [
      {
        memberId: "suite/preview/test/rejects-empty-result",
        beforePresent: true,
        afterPresent: false,
        before: ["renders", "rejects empty"],
      },
    ],
    beforeKind: "member-collection",
    afterKind: "member-collection",
  });
  const updatedRemoval = updateBaseline({
    ...removedInput,
    baseline: updated.baseline,
    scope: ["preview-policy"],
  });
  assert.equal(updatedRemoval.status, "updated");
  if (updatedRemoval.status !== "updated") return;
  const restored = check({
    references: groupReferences,
    bindings: groupBindings,
    facts: removedFacts,
    baseline: updatedRemoval.baseline,
  });
  assert.equal(restored.bindings[0]?.consistency, "consistent");
});

void test("partial 成员发现不推断增删，完整发现的失败成员仍可显示差异但不能更新基线", () => {
  const groupReferences: ReferenceDefinition[] = [
    { id: "preview-doc", target: { path: "docs/preview.md" } },
    { id: "preview-group", target: { kind: "test-group", path: ["preview"] } },
  ];
  const groupBindings: BindingDefinition[] = [
    {
      id: "preview-policy",
      references: ["preview-doc", "preview-group"],
    },
  ];
  const initial: ReferenceResult[] = [
    { referenceId: "preview-doc", value: "Preview policy" },
    {
      referenceId: "preview-group",
      collection: {
        completeness: "complete",
        members: [
          { id: "test/keeps-query", value: ["query"] },
          { id: "test/shows-warning", value: ["warning"] },
        ],
      },
    },
  ];
  const reviewedInput: CheckInput = {
    references: groupReferences,
    bindings: groupBindings,
    facts: initial,
  };
  const created = updateBaseline({
    ...reviewedInput,
    scope: ["preview-policy"],
  });
  assert.equal(created.status, "updated");
  if (created.status !== "updated") return;

  const partialMembers: ReferenceMemberResult[] = [
    { id: "test/keeps-query", value: ["query"] },
  ];
  const partialDiscovery: MemberDiscoveryCompleteness = "partial";
  const partialDeclaration: DeclarationCompleteness = "partial";
  const partialInput: CheckInput = {
    references: groupReferences,
    bindings: groupBindings,
    facts: [
      initial[0]!,
      {
        referenceId: "preview-group",
        collection: {
          completeness: partialDiscovery,
          members: partialMembers,
        },
      },
    ],
    baseline: created.baseline,
    declarationCompleteness: partialDeclaration,
  };
  const partial = check(partialInput);
  const partialResult: BindingCheckResult = partial.bindings[0]!;
  assert.ok("errors" in partialResult);
  if ("errors" in partialResult) {
    assert.deepEqual(partialResult.changes, []);
    assert.ok(
      partialResult.errors.some(
        (error) => error.code === "incomplete-member-discovery",
      ),
    );
  }
  assert.equal(
    updateBaseline({
      ...partialInput,
      baseline: created.baseline,
      scope: ["preview-policy"],
    }).status,
    "rejected",
  );

  const ambiguousMember = check({
    references: groupReferences,
    bindings: groupBindings,
    facts: [
      initial[0]!,
      {
        referenceId: "preview-group",
        collection: {
          completeness: "complete",
          members: [
            { id: "test/keeps-query", value: ["query"] },
            { id: "test/keeps-query", value: ["other"] },
          ],
        },
      },
    ],
    baseline: created.baseline,
  });
  const ambiguousResult = ambiguousMember.bindings[0]!;
  assert.ok("errors" in ambiguousResult);
  if ("errors" in ambiguousResult) {
    assert.deepEqual(ambiguousResult.changes, []);
    assert.ok(
      ambiguousResult.errors.some((error) => error.code === "ambiguous-member"),
    );
  }

  const failedMemberInput: CheckInput = {
    references: groupReferences,
    bindings: groupBindings,
    facts: [
      initial[0]!,
      {
        referenceId: "preview-group",
        collection: {
          completeness: "complete",
          members: [
            { id: "test/keeps-query", value: ["query"] },
            {
              id: "test/shows-warning",
              error: {
                code: "required-output-missing",
                message: "未取得必要观察。",
              } satisfies CheckError,
            },
            {
              id: "test/rejects-empty-result",
              value: ["renders", "rejects empty"],
            },
          ],
        },
      },
    ],
    baseline: created.baseline,
  };
  const failedMember = check(failedMemberInput);
  const failedResult = failedMember.bindings[0]!;
  assert.ok("errors" in failedResult);
  if ("errors" in failedResult) {
    assert.equal("current" in failedResult, false);
    assert.deepEqual(failedResult.changes[0], {
      kind: "fact",
      referenceId: "preview-group",
      memberChanges: [
        {
          memberId: "test/rejects-empty-result",
          beforePresent: false,
          afterPresent: true,
          after: ["renders", "rejects empty"],
        },
      ],
      beforeKind: "member-collection",
      afterKind: "member-collection",
    });
    assert.ok(
      failedResult.errors.some(
        (error) => error.memberId === "test/shows-warning",
      ),
    );
  }
  assert.equal(
    updateBaseline({
      ...failedMemberInput,
      baseline: created.baseline,
      scope: ["preview-policy"],
    }).status,
    "rejected",
  );

  const failedSameMembers = check({
    references: groupReferences,
    bindings: groupBindings,
    facts: [
      initial[0]!,
      {
        referenceId: "preview-group",
        collection: {
          completeness: "complete",
          members: [
            { id: "test/keeps-query", value: ["query"] },
            {
              id: "test/shows-warning",
              error: { code: "test-skipped", message: "测试已跳过。" },
            },
          ],
        },
      },
    ],
    baseline: created.baseline,
  });
  const sameMembersResult = failedSameMembers.bindings[0]!;
  assert.ok("errors" in sameMembersResult);
  if ("errors" in sameMembersResult) {
    assert.deepEqual(sameMembersResult.changes, []);
    assert.ok(
      sameMembersResult.errors.some((error) => error.code === "test-skipped"),
    );
  }

  const damagedBaseline = structuredClone(created.baseline);
  damagedBaseline.bindings["preview-policy"]!.references[
    "preview-group"
  ]!.value = null;
  assert.throws(
    () =>
      check({
        references: groupReferences,
        bindings: groupBindings,
        facts: initial,
        baseline: damagedBaseline,
      }),
    /成员集合基线必须是数组/u,
  );
});

void test("成员内部数组顺序和 scalar 到成员集合的类型变化都进入事实差异", () => {
  const groupReferences: ReferenceDefinition[] = [
    { id: "preview-doc", target: { path: "docs/preview.md" } },
    { id: "preview-group", target: { kind: "test-group", path: ["preview"] } },
  ];
  const groupBindings: BindingDefinition[] = [
    {
      id: "preview-policy",
      references: ["preview-doc", "preview-group"],
    },
  ];
  const scalarFacts: ReferenceResult[] = [
    { referenceId: "preview-doc", value: "Preview policy" },
    {
      referenceId: "preview-group",
      value: [{ id: "test/keeps-query", value: ["beforeEach", "query"] }],
    },
  ];
  const scalarInput: CheckInput = {
    references: groupReferences,
    bindings: groupBindings,
    facts: scalarFacts,
  };
  const created = updateBaseline({ ...scalarInput, scope: ["preview-policy"] });
  assert.equal(created.status, "updated");
  if (created.status !== "updated") return;

  const asCollection = check({
    references: groupReferences,
    bindings: groupBindings,
    facts: [
      scalarFacts[0]!,
      {
        referenceId: "preview-group",
        collection: {
          completeness: "complete",
          members: [{ id: "test/keeps-query", value: ["beforeEach", "query"] }],
        },
      },
    ],
    baseline: created.baseline,
  });
  const typeChange = asCollection.bindings[0]?.changes[0];
  assert.equal(typeChange?.kind, "fact");
  if (typeChange?.kind === "fact") {
    assert.equal(typeChange.beforeKind, undefined);
    assert.equal(typeChange.afterKind, "member-collection");
  }
  const collectionInput: CheckInput = {
    references: groupReferences,
    bindings: groupBindings,
    facts: [
      scalarFacts[0]!,
      {
        referenceId: "preview-group",
        collection: {
          completeness: "complete",
          members: [{ id: "test/keeps-query", value: ["beforeEach", "query"] }],
        },
      },
    ],
  };
  const updatedCollection = updateBaseline({
    ...collectionInput,
    scope: ["preview-policy"],
  });
  assert.equal(updatedCollection.status, "updated");
  if (updatedCollection.status !== "updated") return;

  const orderedChange = check({
    references: groupReferences,
    bindings: groupBindings,
    facts: [
      scalarFacts[0]!,
      {
        referenceId: "preview-group",
        collection: {
          completeness: "complete",
          members: [{ id: "test/keeps-query", value: ["query", "beforeEach"] }],
        },
      },
    ],
    baseline: updatedCollection.baseline,
  });
  assert.equal(orderedChange.bindings[0]?.changes[0]?.kind, "fact");
});

void test("当前位置变化不制造差异；事实、引用定义和关联关系分别留下解释", () => {
  const firstInput: CheckInput = { references, bindings, facts };
  const updated = updateBaseline({ ...firstInput, scope: ["preview-port"] });
  assert.equal(updated.status, "updated");
  if (updated.status !== "updated") return;

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
    baseline: updated.baseline,
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
    baseline: updated.baseline,
  });
  assert.deepEqual(changedFact.bindings[0]?.changes, [
    {
      kind: "fact",
      referenceId: "preview-port-doc",
      before: "- **Default:** `4173`",
      after: "- **Default:** `4174`",
    },
  ]);

  const changedFileFact = check({
    references,
    bindings,
    facts: facts.map((fact) =>
      fact.referenceId === "preview-port-file"
        ? { ...fact, value: "port=4174" }
        : fact,
    ),
    baseline: updated.baseline,
  });
  assert.deepEqual(
    changedFileFact.bindings[0]?.changes.map((change) =>
      change.kind === "fact" ? change.referenceId : change.kind,
    ),
    ["preview-port-file"],
  );

  const multipleFactsChanged = check({
    references,
    bindings,
    facts: facts.map((fact) => {
      if (fact.referenceId === "preview-port-doc")
        return { ...fact, value: "- **Default:** `4174`" };
      if (fact.referenceId === "preview-port-file")
        return { ...fact, value: "port=4174" };
      return fact;
    }),
    baseline: updated.baseline,
  });
  assert.deepEqual(
    multipleFactsChanged.bindings[0]?.changes.map((change) =>
      change.kind === "fact" ? change.referenceId : change.kind,
    ),
    ["preview-port-doc", "preview-port-file"],
  );

  const reverted = check({
    references,
    bindings,
    facts,
    baseline: updated.baseline,
  });
  assert.equal(reverted.bindings[0]?.consistency, "consistent");
  assert.deepEqual(reverted.bindings[0]?.changes, []);

  const changedDefinition = check({
    references: references.map((reference) =>
      reference.id === "preview-port-file"
        ? {
            ...reference,
            target: { path: "config/copied-preview.txt", processor: "file" },
          }
        : reference,
    ),
    bindings,
    facts,
    baseline: updated.baseline,
  });
  assert.equal(changedDefinition.bindings[0]?.consistency, "inconsistent");
  assert.ok(
    changedDefinition.bindings[0]?.changes.some(
      (change) =>
        change.kind === "reference-definition" &&
        change.referenceId === "preview-port-file",
    ),
  );

  const changedProcessor = check({
    references: references.map((reference) =>
      reference.id === "preview-port-file"
        ? {
            ...reference,
            target: { path: "config/preview.txt", processor: "markdown" },
          }
        : reference,
    ),
    bindings,
    facts,
    baseline: updated.baseline,
  });
  assert.ok(
    changedProcessor.bindings[0]?.changes.some(
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
        references: [...bindings[0]!.references, "preview-port-condition"],
      },
    ],
    facts: [
      ...facts,
      {
        referenceId: "preview-port-condition",
        value: "If the port is occupied",
      },
    ],
    baseline: updated.baseline,
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

void test("局部错误只阻止依赖它的关联，批次更新基线全拒绝且单选不连带确认共享引用", () => {
  const scopedReferences: ReferenceDefinition[] = [
    { id: "alpha-doc", target: { path: "docs/alpha.md" } },
    { id: "beta-doc", target: { path: "docs/beta.md" } },
    { id: "shared-setting", target: { path: "config/shared.txt" } },
    { id: "alpha-target", target: { path: "config/alpha.txt" } },
    { id: "beta-target", target: { path: "config/beta.txt" } },
  ];
  const scopedBindings: BindingDefinition[] = [
    {
      id: "alpha",
      references: ["alpha-doc", "shared-setting", "alpha-target"],
    },
    {
      id: "beta",
      references: ["beta-doc", "shared-setting", "beta-target"],
    },
  ];
  const originalFacts: ReferenceResult[] = [
    { referenceId: "alpha-doc", value: "alpha claim" },
    { referenceId: "beta-doc", value: "beta claim" },
    { referenceId: "shared-setting", value: "v1" },
    { referenceId: "alpha-target", value: "alpha target" },
    { referenceId: "beta-target", value: "beta target" },
  ];
  const initialInput: CheckInput = {
    references: scopedReferences,
    bindings: scopedBindings,
    facts: originalFacts,
    declarationCompleteness: "complete",
    scope: ["alpha", "beta"],
  };
  const firstUpdate = updateBaseline({
    ...initialInput,
    scope: ["alpha", "beta"],
  });
  assert.equal(firstUpdate.status, "updated");
  if (firstUpdate.status !== "updated") return;

  const changedFacts: ReferenceResult[] = [
    {
      referenceId: "alpha-doc",
      error: { code: "missing-file", message: "alpha 文档暂时无法读取。" },
    },
    { referenceId: "beta-doc", value: "beta claim" },
    { referenceId: "shared-setting", value: "v2" },
    { referenceId: "alpha-target", value: "alpha target" },
    { referenceId: "beta-target", value: "beta target" },
  ];
  const reportInput: CheckInput = {
    references: scopedReferences,
    bindings: scopedBindings,
    facts: changedFacts,
    baseline: firstUpdate.baseline,
    declarationCompleteness: "complete",
    scope: ["alpha", "beta"],
  };
  const report = check(reportInput);
  assert.deepEqual(report.scope, ["alpha", "beta"]);
  assert.deepEqual(
    report.bindings.map((result) => result.bindingId),
    ["alpha", "beta"],
  );
  const alpha = report.bindings[0]!;
  assert.ok("errors" in alpha);
  if ("errors" in alpha) assert.equal(alpha.errors[0]?.code, "missing-file");
  const beta = report.bindings[1]!;
  assert.equal(beta.consistency, "inconsistent");

  const unchangedBaseline = JSON.stringify(firstUpdate.baseline);
  const rejectedBatch = updateBaseline({
    ...reportInput,
    baseline: firstUpdate.baseline,
    scope: ["alpha", "beta"],
  });
  assert.equal(rejectedBatch.status, "rejected");
  assert.equal(JSON.stringify(firstUpdate.baseline), unchangedBaseline);

  const updatedOnlyBeta = updateBaseline({
    ...reportInput,
    baseline: firstUpdate.baseline,
    scope: ["beta"],
  });
  assert.equal(updatedOnlyBeta.status, "updated");
  if (updatedOnlyBeta.status !== "updated") return;
  assert.equal(
    updatedOnlyBeta.baseline.bindings.alpha?.references["shared-setting"]
      ?.value,
    "v1",
  );
  assert.equal(
    updatedOnlyBeta.baseline.bindings.beta?.references["shared-setting"]?.value,
    "v2",
  );

  const repairedFacts = changedFacts.map((fact) =>
    fact.referenceId === "alpha-doc"
      ? { referenceId: "alpha-doc", value: "alpha claim" }
      : fact,
  );
  const afterRepair = check({
    references: scopedReferences,
    bindings: scopedBindings,
    facts: repairedFacts,
    baseline: updatedOnlyBeta.baseline,
    declarationCompleteness: "complete",
    scope: ["alpha", "beta"],
  });
  assert.deepEqual(
    afterRepair.bindings.map((result) =>
      "errors" in result ? "error" : result.consistency,
    ),
    ["inconsistent", "consistent"],
  );

  const unrelatedFaultInput: CheckInput = {
    references: scopedReferences,
    bindings: [
      { ...scopedBindings[0]!, references: ["undeclared-setting"] },
      scopedBindings[1]!,
    ],
    facts: repairedFacts,
    baseline: updatedOnlyBeta.baseline,
    declarationCompleteness: "partial",
    scope: ["alpha", "beta"],
  };
  const unrelatedFault = check(unrelatedFaultInput);
  const alphaFault = unrelatedFault.bindings[0]!;
  assert.ok("errors" in alphaFault);
  if ("errors" in alphaFault)
    assert.equal(alphaFault.errors[0]?.code, "undeclared-reference");
  assert.equal(unrelatedFault.bindings[1]?.consistency, "consistent");
  assert.equal(
    updateBaseline({
      ...unrelatedFaultInput,
      baseline: updatedOnlyBeta.baseline,
      scope: ["beta"],
    }).status,
    "updated",
  );

  const sharedReferenceFailureInput: CheckInput = {
    references: scopedReferences,
    bindings: scopedBindings,
    facts: repairedFacts.map((fact) =>
      fact.referenceId === "shared-setting"
        ? {
            referenceId: "shared-setting",
            error: { code: "read-failed", message: "共享配置无法读取。" },
          }
        : fact,
    ),
    baseline: updatedOnlyBeta.baseline,
    declarationCompleteness: "complete",
    scope: ["alpha", "beta"],
  };
  const sharedReferenceFailure = check(sharedReferenceFailureInput);
  for (const result of sharedReferenceFailure.bindings) {
    assert.ok("errors" in result);
    if ("errors" in result)
      assert.ok(
        result.errors.some(
          (error) =>
            error.referenceId === "shared-setting" &&
            error.code === "read-failed",
        ),
      );
  }
  assert.equal(
    updateBaseline({
      ...sharedReferenceFailureInput,
      baseline: updatedOnlyBeta.baseline,
      scope: ["beta"],
    }).status,
    "rejected",
  );
});

void test("局部声明不证明取消跟踪；完整声明删除基线无需读取旧目标", () => {
  const initialInput: CheckInput = {
    references,
    bindings: [
      bindings[0]!,
      {
        id: "preview-port-copy",
        references: ["preview-port-doc", "preview-port-file"],
      },
    ],
    facts,
    declarationCompleteness: "complete",
    scope: ["preview-port", "preview-port-copy"],
  };
  const updated = updateBaseline({
    ...initialInput,
    scope: ["preview-port", "preview-port-copy"],
  });
  assert.equal(updated.status, "updated");
  if (updated.status !== "updated") return;

  const partialInput: CheckInput = {
    references,
    bindings: [bindings[0]!],
    facts,
    baseline: updated.baseline,
    declarationCompleteness: "partial",
    scope: ["preview-port"],
  };
  const partial = check(partialInput);
  assert.deepEqual(partial.declaration, {
    completeness: "partial",
    bindingIds: ["preview-port"],
  });
  assert.deepEqual(partial.scope, ["preview-port"]);
  assert.deepEqual(
    partial.bindings.map((result) => result.bindingId),
    ["preview-port"],
  );

  const omittedFromPartialInput: CheckInput = {
    references,
    bindings: [bindings[0]!],
    facts,
    baseline: updated.baseline,
    declarationCompleteness: "partial",
    scope: ["preview-port-copy"],
  };
  const omittedFromPartial = check(omittedFromPartialInput);
  const omission = omittedFromPartial.bindings[0]!;
  assert.ok("errors" in omission);
  if ("errors" in omission)
    assert.equal(omission.errors[0]?.code, "incomplete-declaration");
  assert.equal(
    updateBaseline({
      ...omittedFromPartialInput,
      baseline: updated.baseline,
      scope: ["preview-port-copy"],
    }).status,
    "rejected",
  );

  const cancelledInput: CheckInput = {
    references: [],
    bindings: [bindings[0]!],
    facts: [],
    baseline: updated.baseline,
    declarationCompleteness: "complete",
    scope: ["preview-port-copy"],
  };
  const cancelled = check(cancelledInput);
  const removal = cancelled.bindings[0]!;
  assert.equal("untracked" in removal, true);
  if ("untracked" in removal) {
    assert.equal(removal.consistency, "inconsistent");
    assert.equal(removal.changes[0]?.kind, "binding-removed");
  }

  const cancellationUpdate = updateBaseline({
    ...cancelledInput,
    baseline: updated.baseline,
    scope: ["preview-port-copy"],
  });
  assert.equal(cancellationUpdate.status, "updated");
  if (cancellationUpdate.status !== "updated") return;
  assert.equal(
    Object.hasOwn(cancellationUpdate.baseline.bindings, "preview-port-copy"),
    false,
  );
  assert.equal(
    Object.hasOwn(cancellationUpdate.baseline.bindings, "preview-port"),
    true,
  );

  const afterCancellation = check({
    references,
    bindings: [bindings[0]!],
    facts,
    baseline: cancellationUpdate.baseline,
    declarationCompleteness: "complete",
    scope: ["preview-port"],
  });
  assert.equal(afterCancellation.bindings[0]?.consistency, "consistent");
  assert.deepEqual(
    afterCancellation.bindings.map((result) => result.bindingId),
    ["preview-port"],
  );
});

void test("合法关联和引用 ID 不会被 JSON 基线的继承属性遮蔽", () => {
  const ids = ["constructor", "toString", "__proto__"];
  const references: ReferenceDefinition[] = [
    { id: "guide", target: { path: "docs/guide.md" } },
    ...ids.map((id) => ({ id, target: { path: `${id}.txt` } })),
  ];
  const bindings: BindingDefinition[] = ids.map((id) => ({
    id,
    references: ["guide", id],
  }));
  const facts: ReferenceResult[] = [
    { referenceId: "guide", value: "guide" },
    ...ids.map((referenceId) => ({ referenceId, value: referenceId })),
  ];
  const emptyBaseline = JSON.parse('{"version":2,"bindings":{}}');
  const initialInput: CheckInput = {
    references,
    bindings,
    facts,
    baseline: emptyBaseline,
    declarationCompleteness: "complete",
  };
  const initial = check(initialInput);

  assert.deepEqual(
    initial.bindings.map((result) => result.changes[0]?.kind),
    ["binding-added", "binding-added", "binding-added"],
  );
  const created = updateBaseline({
    ...initialInput,
    baseline: emptyBaseline,
    scope: ids,
  });
  assert.equal(created.status, "updated");
  if (created.status !== "updated") return;

  const roundTripped = JSON.parse(JSON.stringify(created.baseline));
  assert.ok(ids.every((id) => Object.hasOwn(roundTripped.bindings, id)));
  const afterFirstUpdate = check({
    references,
    bindings,
    facts,
    baseline: roundTripped,
    declarationCompleteness: "complete",
  });
  assert.ok(
    afterFirstUpdate.bindings.every(
      (result) => result.consistency === "consistent",
    ),
  );

  const existingReferences: ReferenceDefinition[] = [
    { id: "base", target: { path: "config/base.txt" } },
  ];
  const existingBinding: BindingDefinition = {
    id: "existing",
    references: ["guide", "base"],
  };
  const existingFacts: ReferenceResult[] = [
    { referenceId: "guide", value: "guide" },
    { referenceId: "base", value: "base" },
  ];
  const existingInput: CheckInput = {
    references: [...references.slice(0, 1), ...existingReferences],
    bindings: [existingBinding],
    facts: existingFacts,
  };
  const existingUpdated = updateBaseline({
    ...existingInput,
    scope: ["existing"],
  });
  assert.equal(existingUpdated.status, "updated");
  if (existingUpdated.status !== "updated") return;

  const existingBaseline = JSON.parse(JSON.stringify(existingUpdated.baseline));
  const expandedBinding = {
    ...existingBinding,
    references: ["base", ...ids],
  };
  const expandedInput: CheckInput = {
    references: [...references, ...existingReferences],
    bindings: [expandedBinding],
    facts: [
      ...existingFacts,
      ...ids.map((referenceId) => ({ referenceId, value: referenceId })),
    ],
    baseline: existingBaseline,
  };
  const expanded = check(expandedInput);
  assert.deepEqual(
    expanded.bindings[0]?.changes
      .filter((change) => change.kind === "reference-added")
      .map((change) => change.referenceId)
      .sort(),
    [...ids].sort(),
  );

  const expandedUpdated = updateBaseline({
    ...expandedInput,
    baseline: existingBaseline,
    scope: ["existing"],
  });
  assert.equal(expandedUpdated.status, "updated");
  if (expandedUpdated.status !== "updated") return;
  const expandedRoundTrip = JSON.parse(
    JSON.stringify(expandedUpdated.baseline),
  );
  const rechecked = check({
    references: [...references, ...existingReferences],
    bindings: [expandedBinding],
    facts: [
      ...existingFacts,
      ...ids.map((referenceId) => ({ referenceId, value: referenceId })),
    ],
    baseline: expandedRoundTrip,
  });
  assert.equal(rechecked.bindings[0]?.consistency, "consistent");
});
