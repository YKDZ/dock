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

void test("接受只确认仍与已审阅报告相同的当前状态", () => {
  const first = check({ references, bindings, facts });
  const created = accept(first, undefined, ["preview-port"], first);
  assert.equal(created.status, "accepted");
  if (created.status !== "accepted") return;

  const baseline = created.baseline;
  const reviewed = check({ references, bindings, facts, baseline });
  assert.equal(reviewed.bindings[0]?.consistency, "consistent");

  const changedDocument = check({
    references,
    bindings,
    facts: facts.map((fact) =>
      fact.referenceId === "preview-port-doc"
        ? { ...fact, value: "- **Default:** `4174`" }
        : fact,
    ),
    baseline,
  });
  const changedRightSource = check({
    references,
    bindings,
    facts: facts.map((fact) =>
      fact.referenceId === "preview-port-file"
        ? { ...fact, value: "port=4174" }
        : fact,
    ),
    baseline,
  });
  const changedBinding = check({
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
        documents: [...bindings[0]!.documents, "preview-port-condition"],
      },
    ],
    facts: [
      ...facts,
      {
        referenceId: "preview-port-condition",
        value: "If the port is occupied",
      },
    ],
    baseline,
  });

  for (const current of [changedDocument, changedRightSource, changedBinding]) {
    const stale = accept(reviewed, baseline, ["preview-port"], current);
    assert.equal(stale.status, "rejected");
    if (stale.status === "rejected")
      assert.ok(stale.errors.some((error) => error.code === "stale-review"));

    const refreshed = accept(current, baseline, ["preview-port"], current);
    assert.equal(refreshed.status, "accepted");
  }

  const freshError = check({
    references,
    bindings,
    facts: [
      ...facts.filter((fact) => fact.referenceId !== "preview-port-file"),
      {
        referenceId: "preview-port-file",
        error: { code: "read-failed", message: "配置文件读取失败。" },
      },
    ],
    baseline,
  });
  const rejectedEvidence = accept(
    reviewed,
    baseline,
    ["preview-port"],
    freshError,
  );
  assert.equal(rejectedEvidence.status, "rejected");
  if (rejectedEvidence.status === "rejected")
    assert.ok(
      rejectedEvidence.errors.some((error) => error.code === "read-failed"),
    );
});

void test("核对后被替换的基线不能用于接受旧报告", () => {
  const first = check({ references, bindings, facts });
  const created = accept(first, undefined, ["preview-port"], first);
  assert.equal(created.status, "accepted");
  if (created.status !== "accepted") return;

  const baseline = created.baseline;
  const reviewed = check({ references, bindings, facts, baseline });
  const replacement = structuredClone(baseline);
  replacement.bindings["preview-port"]!.references["preview-port-file"]!.value =
    "port=4000";
  const current = check({
    references,
    bindings,
    facts,
    baseline: replacement,
  });
  const rejected = accept(reviewed, replacement, ["preview-port"], current);
  assert.equal(rejected.status, "rejected");
  if (rejected.status === "rejected")
    assert.ok(
      rejected.errors.some(
        (error) => error.code === "reviewed-baseline-changed",
      ),
    );
});

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

  const accepted = accept(initial, undefined, ["preview-port"], initial);
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
  const accepted = accept(initial, undefined, ["preview-port"], initial);
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
  const rejected = accept(
    missing,
    accepted.baseline,
    ["preview-port"],
    missing,
  );
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
  const emptyDocuments = check({
    references,
    bindings: [{ ...bindings[0]!, documents: [] }],
    facts,
    scope: ["preview-port"],
  });
  assert.equal(
    "errors" in emptyDocuments.bindings[0]!,
    true,
    "无效关联只应阻止本条关联产生业务结果。",
  );

  const emptyReferences = check({
    references,
    bindings: [{ ...bindings[0]!, references: [] }],
    facts,
    scope: ["preview-port"],
  });
  assert.equal("errors" in emptyReferences.bindings[0]!, true);
});

void test("完整成员清单按稳定 ID 比较，接受增删后可再次核对", () => {
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
      documents: ["preview-doc"],
      references: ["preview-group"],
    },
  ];
  const initialFacts: ReferenceFact[] = [
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
  const initial = check({
    references: groupReferences,
    bindings: groupBindings,
    facts: initialFacts,
  });
  const created = accept(initial, undefined, ["preview-policy"], initial);
  assert.equal(created.status, "accepted");
  if (created.status !== "accepted") return;

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

  const changedFacts: ReferenceFact[] = [
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
  const changed = check({
    references: groupReferences,
    bindings: groupBindings,
    facts: changedFacts,
    baseline,
  });
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
  const accepted = accept(changed, baseline, ["preview-policy"], changed);
  assert.equal(accepted.status, "accepted");
  if (accepted.status !== "accepted") return;

  const afterAccept = check({
    references: groupReferences,
    bindings: groupBindings,
    facts: changedFacts,
    baseline: accepted.baseline,
  });
  assert.equal(afterAccept.bindings[0]?.consistency, "consistent");

  const removedFacts: ReferenceFact[] = [
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
  const removed = check({
    references: groupReferences,
    bindings: groupBindings,
    facts: removedFacts,
    baseline: accepted.baseline,
  });
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
  const acceptedRemoval = accept(
    removed,
    accepted.baseline,
    ["preview-policy"],
    removed,
  );
  assert.equal(acceptedRemoval.status, "accepted");
  if (acceptedRemoval.status !== "accepted") return;
  const restored = check({
    references: groupReferences,
    bindings: groupBindings,
    facts: removedFacts,
    baseline: acceptedRemoval.baseline,
  });
  assert.equal(restored.bindings[0]?.consistency, "consistent");
});

void test("partial 成员发现不推断增删，完整发现的失败成员仍可显示差异但不能接受", () => {
  const groupReferences: ReferenceDefinition[] = [
    { id: "preview-doc", target: { path: "docs/preview.md" } },
    { id: "preview-group", target: { kind: "test-group", path: ["preview"] } },
  ];
  const groupBindings: BindingDefinition[] = [
    {
      id: "preview-policy",
      documents: ["preview-doc"],
      references: ["preview-group"],
    },
  ];
  const initial: ReferenceFact[] = [
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
  const reviewed = check({
    references: groupReferences,
    bindings: groupBindings,
    facts: initial,
  });
  const created = accept(reviewed, undefined, ["preview-policy"], reviewed);
  assert.equal(created.status, "accepted");
  if (created.status !== "accepted") return;

  const partial = check({
    references: groupReferences,
    bindings: groupBindings,
    facts: [
      initial[0]!,
      {
        referenceId: "preview-group",
        collection: {
          completeness: "partial",
          members: [{ id: "test/keeps-query", value: ["query"] }],
        },
      },
    ],
    baseline: created.baseline,
  });
  const partialResult = partial.bindings[0]!;
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
    accept(partial, created.baseline, ["preview-policy"], partial).status,
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

  const failedMember = check({
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
              },
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
  });
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
    accept(failedMember, created.baseline, ["preview-policy"], failedMember)
      .status,
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
      documents: ["preview-doc"],
      references: ["preview-group"],
    },
  ];
  const scalarFacts: ReferenceFact[] = [
    { referenceId: "preview-doc", value: "Preview policy" },
    {
      referenceId: "preview-group",
      value: [{ id: "test/keeps-query", value: ["beforeEach", "query"] }],
    },
  ];
  const scalar = check({
    references: groupReferences,
    bindings: groupBindings,
    facts: scalarFacts,
  });
  const created = accept(scalar, undefined, ["preview-policy"], scalar);
  assert.equal(created.status, "accepted");
  if (created.status !== "accepted") return;

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
  const staleReview = accept(
    scalar,
    created.baseline,
    ["preview-policy"],
    asCollection,
  );
  assert.equal(staleReview.status, "rejected");
  if (staleReview.status === "rejected") {
    assert.ok(
      staleReview.errors.some((error) => error.code === "stale-review"),
    );
  }

  const collection = check({
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
  });
  const acceptedCollection = accept(
    collection,
    undefined,
    ["preview-policy"],
    collection,
  );
  assert.equal(acceptedCollection.status, "accepted");
  if (acceptedCollection.status !== "accepted") return;

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
    baseline: acceptedCollection.baseline,
  });
  assert.equal(orderedChange.bindings[0]?.changes[0]?.kind, "fact");
});

void test("当前位置变化不制造差异；事实、引用定义和关联关系分别留下解释", () => {
  const first = check({ references, bindings, facts });
  const accepted = accept(first, undefined, ["preview-port"], first);
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

void test("局部错误只阻止依赖它的关联，批次接受全拒绝且单选不连带确认共享引用", () => {
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
      documents: ["alpha-doc"],
      references: ["shared-setting", "alpha-target"],
    },
    {
      id: "beta",
      documents: ["beta-doc"],
      references: ["shared-setting", "beta-target"],
    },
  ];
  const originalFacts: ReferenceFact[] = [
    { referenceId: "alpha-doc", value: "alpha claim" },
    { referenceId: "beta-doc", value: "beta claim" },
    { referenceId: "shared-setting", value: "v1" },
    { referenceId: "alpha-target", value: "alpha target" },
    { referenceId: "beta-target", value: "beta target" },
  ];
  const initial = check({
    references: scopedReferences,
    bindings: scopedBindings,
    facts: originalFacts,
    declarationCompleteness: "complete",
    scope: ["alpha", "beta"],
  });
  const firstAcceptance = accept(
    initial,
    undefined,
    ["alpha", "beta"],
    initial,
  );
  assert.equal(firstAcceptance.status, "accepted");
  if (firstAcceptance.status !== "accepted") return;

  const changedFacts: ReferenceFact[] = [
    {
      referenceId: "alpha-doc",
      error: { code: "missing-file", message: "alpha 文档暂时无法读取。" },
    },
    { referenceId: "beta-doc", value: "beta claim" },
    { referenceId: "shared-setting", value: "v2" },
    { referenceId: "alpha-target", value: "alpha target" },
    { referenceId: "beta-target", value: "beta target" },
  ];
  const report = check({
    references: scopedReferences,
    bindings: scopedBindings,
    facts: changedFacts,
    baseline: firstAcceptance.baseline,
    declarationCompleteness: "complete",
    scope: ["alpha", "beta"],
  });
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

  const unchangedBaseline = JSON.stringify(firstAcceptance.baseline);
  const rejectedBatch = accept(
    report,
    firstAcceptance.baseline,
    ["alpha", "beta"],
    report,
  );
  assert.equal(rejectedBatch.status, "rejected");
  assert.equal(JSON.stringify(firstAcceptance.baseline), unchangedBaseline);

  const acceptedOnlyBeta = accept(
    report,
    firstAcceptance.baseline,
    ["beta"],
    report,
  );
  assert.equal(acceptedOnlyBeta.status, "accepted");
  if (acceptedOnlyBeta.status !== "accepted") return;
  assert.equal(
    acceptedOnlyBeta.baseline.bindings.alpha?.references["shared-setting"]
      ?.value,
    "v1",
  );
  assert.equal(
    acceptedOnlyBeta.baseline.bindings.beta?.references["shared-setting"]
      ?.value,
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
    baseline: acceptedOnlyBeta.baseline,
    declarationCompleteness: "complete",
    scope: ["alpha", "beta"],
  });
  assert.deepEqual(
    afterRepair.bindings.map((result) =>
      "errors" in result ? "error" : result.consistency,
    ),
    ["inconsistent", "consistent"],
  );

  const unrelatedFault = check({
    references: scopedReferences,
    bindings: [
      { ...scopedBindings[0]!, references: ["undeclared-setting"] },
      scopedBindings[1]!,
    ],
    facts: repairedFacts,
    baseline: acceptedOnlyBeta.baseline,
    declarationCompleteness: "partial",
    scope: ["alpha", "beta"],
  });
  const alphaFault = unrelatedFault.bindings[0]!;
  assert.ok("errors" in alphaFault);
  if ("errors" in alphaFault)
    assert.equal(alphaFault.errors[0]?.code, "undeclared-reference");
  assert.equal(unrelatedFault.bindings[1]?.consistency, "consistent");
  assert.equal(
    accept(unrelatedFault, acceptedOnlyBeta.baseline, ["beta"], unrelatedFault)
      .status,
    "accepted",
  );

  const sharedReferenceFailure = check({
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
    baseline: acceptedOnlyBeta.baseline,
    declarationCompleteness: "complete",
    scope: ["alpha", "beta"],
  });
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
    accept(
      sharedReferenceFailure,
      acceptedOnlyBeta.baseline,
      ["beta"],
      sharedReferenceFailure,
    ).status,
    "rejected",
  );
});

void test("局部声明不证明取消跟踪；完整声明删除基线无需读取旧目标", () => {
  const initial = check({
    references,
    bindings: [
      bindings[0]!,
      {
        id: "preview-port-copy",
        documents: ["preview-port-doc"],
        references: ["preview-port-file"],
      },
    ],
    facts,
    declarationCompleteness: "complete",
    scope: ["preview-port", "preview-port-copy"],
  });
  const accepted = accept(
    initial,
    undefined,
    ["preview-port", "preview-port-copy"],
    initial,
  );
  assert.equal(accepted.status, "accepted");
  if (accepted.status !== "accepted") return;

  const partial = check({
    references,
    bindings: [bindings[0]!],
    facts,
    baseline: accepted.baseline,
    declarationCompleteness: "partial",
    scope: ["preview-port"],
  });
  assert.deepEqual(partial.declaration, {
    completeness: "partial",
    bindingIds: ["preview-port"],
  });
  assert.deepEqual(partial.scope, ["preview-port"]);
  assert.deepEqual(
    partial.bindings.map((result) => result.bindingId),
    ["preview-port"],
  );

  const omittedFromPartial = check({
    references,
    bindings: [bindings[0]!],
    facts,
    baseline: accepted.baseline,
    declarationCompleteness: "partial",
    scope: ["preview-port-copy"],
  });
  const omission = omittedFromPartial.bindings[0]!;
  assert.ok("errors" in omission);
  if ("errors" in omission)
    assert.equal(omission.errors[0]?.code, "incomplete-declaration");
  assert.equal(
    accept(
      omittedFromPartial,
      accepted.baseline,
      ["preview-port-copy"],
      omittedFromPartial,
    ).status,
    "rejected",
  );

  const cancelled = check({
    references: [],
    bindings: [bindings[0]!],
    facts: [],
    baseline: accepted.baseline,
    declarationCompleteness: "complete",
    scope: ["preview-port-copy"],
  });
  const removal = cancelled.bindings[0]!;
  assert.equal("untracked" in removal, true);
  if ("untracked" in removal) {
    assert.equal(removal.consistency, "inconsistent");
    assert.equal(removal.changes[0]?.kind, "binding-removed");
  }

  const cancellationAcceptance = accept(
    cancelled,
    accepted.baseline,
    ["preview-port-copy"],
    cancelled,
  );
  assert.equal(cancellationAcceptance.status, "accepted");
  if (cancellationAcceptance.status !== "accepted") return;
  assert.equal(
    Object.hasOwn(
      cancellationAcceptance.baseline.bindings,
      "preview-port-copy",
    ),
    false,
  );
  assert.equal(
    Object.hasOwn(cancellationAcceptance.baseline.bindings, "preview-port"),
    true,
  );

  const afterCancellation = check({
    references,
    bindings: [bindings[0]!],
    facts,
    baseline: cancellationAcceptance.baseline,
    declarationCompleteness: "complete",
    scope: ["preview-port"],
  });
  assert.equal(afterCancellation.bindings[0]?.consistency, "consistent");
  assert.deepEqual(
    afterCancellation.bindings.map((result) => result.bindingId),
    ["preview-port"],
  );
});
