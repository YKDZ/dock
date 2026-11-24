import assert from "node:assert/strict";
import { test } from "node:test";

import { check, updateBaseline } from "@ykdz/dock/core";
import type { Baseline, CheckInput, JsonValue } from "@ykdz/dock/core";

void test("creates a baseline directly and updates valid differences without requiring a prior check", () => {
  const input: CheckInput = {
    references: [{ id: "result", target: { kind: "observation" } }],
    bindings: [{ id: "mechanism", references: ["result"] }],
    facts: [{ referenceId: "result", value: { sameReference: true } }],
  };
  const created = updateBaseline(input);
  assert.equal(created.status, "updated");
  if (created.status !== "updated") return;
  assert.equal(created.baseline.version, 3);
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

void test("unsupported or corrupted baselines fail explicitly instead of pretending to be initial setup", () => {
  const input: CheckInput = {
    references: [{ id: "setting", target: { path: "setting.txt" } }],
    bindings: [{ id: "configuration", references: ["setting"] }],
    facts: [{ referenceId: "setting", value: "current" }],
  };
  const created = updateBaseline(input);
  assert.equal(created.status, "updated");
  if (created.status !== "updated") return;

  const unsupportedV1 = {
    ...created.baseline,
    version: 1,
  } as unknown as Baseline;
  const unsupportedV2 = {
    ...created.baseline,
    version: 2,
  } as unknown as Baseline;
  for (const unsupported of [unsupportedV1, unsupportedV2]) {
    const versionPattern = new RegExp(
      `Unsupported baseline version ${String((unsupported as { version: number }).version)}; expected version 3[\\s\\S]*dock baseline update --config`,
    );
    assert.throws(
      () => check({ ...input, baseline: unsupported }),
      versionPattern,
    );
    assert.throws(
      () => updateBaseline({ ...input, baseline: unsupported }),
      versionPattern,
    );
  }
  const damaged = structuredClone(created.baseline);
  damaged.bindings.configuration!.references.setting!.value = Number.NaN;
  assert.throws(() => check({ ...input, baseline: damaged }), TypeError);
  assert.throws(
    () => updateBaseline({ ...input, baseline: damaged }),
    TypeError,
  );
});

void test("empty update scope cannot implicitly clear an existing baseline", () => {
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

void test("invalid facts block the selected batch while unrelated bindings can still update to a readable baseline", () => {
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
    assert.deepEqual(rejected.errors, []);
    const invalidBinding = rejected.report.bindings.find(
      (binding) => binding.bindingId === "invalid-binding",
    );
    assert.ok(invalidBinding && "errors" in invalidBinding);
    assert.deepEqual(
      invalidBinding.errors.map((error) => [error.referenceId, error.code]),
      [["invalid", "invalid-fact"]],
    );
    assert.equal(invalidBinding.consistency, undefined);
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

void test("invalid values inside members preserve member errors without creating a baseline or faking removal", () => {
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
  assert.deepEqual(rejected.errors, []);
  const groupBinding = rejected.report.bindings[0];
  assert.ok(groupBinding && "errors" in groupBinding);
  assert.deepEqual(
    groupBinding.errors.map((error) => [
      error.referenceId,
      error.memberId,
      error.code,
    ]),
    [["group", "invalid", "invalid-fact"]],
  );
  assert.equal(groupBinding.consistency, undefined);
  assert.deepEqual(groupBinding.changes, [
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

void test("invalid values in a reference definition are evidence errors or corrupted baselines when stored", () => {
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
    assert.deepEqual(rejected.errors, []);
    const bindingResult = rejected.report.bindings[0];
    assert.ok(bindingResult && "errors" in bindingResult);
    assert.deepEqual(
      bindingResult.errors.map((error) => [error.referenceId, error.code]),
      [["setting", "invalid-reference-definition"]],
    );
    assert.equal(bindingResult.consistency, undefined);

    const damaged = structuredClone(initial.baseline);
    damaged.bindings.configuration!.references.setting!.definition = definition;
    assert.throws(() => check({ ...input, baseline: damaged }), TypeError);
    assert.throws(
      () => updateBaseline({ ...input, baseline: damaged }),
      TypeError,
    );
  }
});

void test("rejected updates keep binding errors in report.bindings and allow callers to count binding and operation issues once", () => {
  const input: CheckInput = {
    references: [{ id: "suite", target: "suite-target" }],
    bindings: [{ id: "suite-binding", references: ["suite"] }],
    facts: [
      {
        referenceId: "suite",
        collection: {
          completeness: "complete",
          members: [{ id: "a", value: { status: "passed" } }],
        },
      },
    ],
  };
  const initial = updateBaseline(input);
  assert.equal(initial.status, "updated");
  if (initial.status !== "updated") return;
  const savedBaseline = JSON.stringify(initial.baseline);

  const next = updateBaseline({
    ...input,
    baseline: initial.baseline,
    facts: [
      {
        referenceId: "suite",
        collection: {
          completeness: "complete",
          members: [
            {
              id: "a",
              error: {
                code: "missing-observation",
                message: "Observation was not recorded.",
              },
            },
            { id: "b", value: { status: "passed" } },
          ],
        },
      },
    ],
  });
  assert.equal(next.status, "rejected");
  if (next.status !== "rejected") return;
  assert.deepEqual(next.errors, []);
  const suiteBinding = next.report.bindings[0];
  assert.ok(suiteBinding && "errors" in suiteBinding);
  assert.equal(suiteBinding.consistency, undefined);
  assert.deepEqual(suiteBinding.errors, [
    {
      referenceId: "suite",
      memberId: "a",
      code: "missing-observation",
      message: "Observation was not recorded.",
    },
  ]);
  assert.deepEqual(suiteBinding.changes, [
    {
      kind: "fact",
      referenceId: "suite",
      memberChanges: [
        {
          memberId: "b",
          beforePresent: false,
          afterPresent: true,
          after: { status: "passed" },
        },
      ],
      beforeKind: "member-collection",
      afterKind: "member-collection",
    },
  ]);
  assert.equal(JSON.stringify(initial.baseline), savedBaseline);

  assert.deepEqual(collectAllIssues(next), [
    {
      scope: "binding",
      bindingId: "suite-binding",
      code: "missing-observation",
    },
  ]);
  const emptyOutcome = updateBaseline({
    references: [],
    bindings: [],
    facts: [],
    baseline: initial.baseline,
    scope: [],
  });
  assert.deepEqual(collectAllIssues(emptyOutcome), [
    { scope: "operation", code: "empty-selection" },
  ]);
});

function collectAllIssues(outcome: ReturnType<typeof updateBaseline>) {
  if (outcome.status !== "rejected") return [];
  const bindingIssues = outcome.report.bindings.flatMap((binding) =>
    "errors" in binding
      ? binding.errors.map((error) => ({
          scope: "binding" as const,
          bindingId: binding.bindingId,
          code: error.code,
        }))
      : [],
  );
  const operationIssues = outcome.errors.map((error) => ({
    scope: "operation" as const,
    code: error.code,
  }));
  return [...bindingIssues, ...operationIssues];
}

void test("core check and updateBaseline reject accessors across inputs and baselines without evaluating getters", () => {
  let getterCalls = 0;
  const nestedGetter = Object.defineProperty({}, "secret", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "evaluated";
    },
  });
  const topLevelTargetGetter = Object.defineProperty(
    { id: "setting" },
    "target",
    {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { path: "setting.txt" };
      },
    },
  ) as unknown as CheckInput["references"][number];
  const topLevelSelectionGetter = Object.defineProperty(
    { id: "setting", target: { path: "setting.txt" } },
    "selection",
    {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { step: 1 };
      },
    },
  ) as unknown as CheckInput["references"][number];
  const topLevelFactGetter = Object.defineProperty(
    { referenceId: "setting" },
    "value",
    {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { ok: true };
      },
    },
  ) as unknown as CheckInput["facts"][number];
  const topLevelMemberGetter = Object.defineProperty(
    { id: "member" },
    "value",
    {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { ok: true };
      },
    },
  );

  const baseInput: CheckInput = {
    references: [{ id: "setting", target: { path: "setting.txt" } }],
    bindings: [{ id: "configuration", references: ["setting"] }],
    facts: [{ referenceId: "setting", value: { nested: [1, 2] } }],
  };
  const initial = updateBaseline(baseInput);
  assert.equal(initial.status, "updated");
  if (initial.status !== "updated") return;

  for (const definition of [
    topLevelTargetGetter,
    topLevelSelectionGetter,
    { id: "setting", target: { nested: nestedGetter } },
    { id: "setting", target: "ok", selection: { nested: [nestedGetter] } },
  ]) {
    const rejected = updateBaseline({
      ...baseInput,
      references: [definition],
      baseline: initial.baseline,
    });
    assert.equal(rejected.status, "rejected");
    if (rejected.status !== "rejected") return;
    assert.equal(
      rejected.report.bindings[0]?.errors?.[0]?.code,
      "invalid-reference-definition",
    );
  }

  for (const badFact of [
    topLevelFactGetter,
    { referenceId: "setting", value: { nested: [nestedGetter] } },
  ]) {
    const rejected = updateBaseline({
      ...baseInput,
      facts: [badFact],
      baseline: initial.baseline,
    });
    assert.equal(rejected.status, "rejected");
    if (rejected.status !== "rejected") return;
    assert.equal(
      rejected.report.bindings[0]?.errors?.[0]?.code,
      "invalid-fact",
    );
  }

  for (const badMember of [
    topLevelMemberGetter,
    { id: "member", value: { nested: [nestedGetter] } },
  ]) {
    const rejected = updateBaseline({
      ...baseInput,
      facts: [
        {
          referenceId: "setting",
          collection: {
            completeness: "complete",
            members: [
              badMember as CheckInput["facts"][number] extends {
                collection: { members: (infer M)[] };
              }
                ? M
                : never,
            ],
          },
        },
      ],
      baseline: initial.baseline,
    });
    assert.equal(rejected.status, "rejected");
    if (rejected.status !== "rejected") return;
    assert.equal(
      rejected.report.bindings[0]?.errors?.[0]?.code,
      "invalid-fact",
    );
  }

  const corruptedValueBaseline = structuredClone(initial.baseline);
  corruptedValueBaseline.bindings.configuration!.references.setting!.value = {
    nested: nestedGetter as unknown as JsonValue,
  };
  assert.throws(
    () => check({ ...baseInput, baseline: corruptedValueBaseline }),
    TypeError,
  );

  const corruptedMemberBaseline = structuredClone(initial.baseline);
  corruptedMemberBaseline.bindings.configuration!.references.setting!.valueKind =
    "member-collection";
  corruptedMemberBaseline.bindings.configuration!.references.setting!.value = [
    { id: "m1", value: { nested: nestedGetter as unknown as JsonValue } },
  ];
  assert.throws(
    () => check({ ...baseInput, baseline: corruptedMemberBaseline }),
    TypeError,
  );

  const corruptedTopLevelMemberBaseline = structuredClone(initial.baseline);
  corruptedTopLevelMemberBaseline.bindings.configuration!.references.setting!.valueKind =
    "member-collection";
  corruptedTopLevelMemberBaseline.bindings.configuration!.references.setting!.value =
    [topLevelMemberGetter];
  assert.throws(
    () => check({ ...baseInput, baseline: corruptedTopLevelMemberBaseline }),
    TypeError,
  );

  assert.equal(getterCalls, 0);
});
