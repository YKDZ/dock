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
