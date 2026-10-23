import assert from "node:assert/strict";
import { test } from "node:test";

import { check, updateBaseline } from "@ykdz/dock-core";
import type {
  BindingDefinition,
  CheckInput,
  ReferenceDefinition,
  ReferenceResult,
} from "@ykdz/dock-core";

const references: ReferenceDefinition[] = [
  {
    id: "doc-paragraph",
    target: { path: "docs/env.md", format: "markdown" },
    selection: {
      steps: [
        { kind: "section", heading: "Env Variables" },
        { kind: "node", type: "paragraph", contains: "highest priority" },
      ],
    },
    note: "initial note",
  },
  {
    id: "doc-table-cell",
    target: { path: "docs/env.md", format: "markdown" },
    selection: {
      steps: [
        {
          kind: "table-cell",
          row: { column: "Command", value: "vite build" },
          column: "Mode",
        },
      ],
    },
  },
  {
    id: "code-symbol",
    target: { path: "src/env.ts", language: "typescript" },
    selection: {
      steps: [{ kind: "symbol", name: ["loadEnv"], declaration: "function" }],
    },
  },
  {
    id: "ordered-output",
    target: { path: "src/output.ts", kind: "selected-result" },
    selection: { steps: [{ kind: "output", name: "attempts" }] },
  },
];

const binding: BindingDefinition = {
  id: "env-contract",
  references: [
    "doc-paragraph",
    "doc-table-cell",
    "code-symbol",
    "ordered-output",
  ],
  note: "initial binding note",
};

const facts: ReferenceResult[] = [
  {
    referenceId: "doc-paragraph",
    value: "Existing env vars have the highest priority.",
  },
  { referenceId: "doc-table-cell", value: '"production"' },
  { referenceId: "code-symbol", value: "function loadEnv()" },
  { referenceId: "ordered-output", value: ["first", "second"] },
];

function updated() {
  const reportInput: CheckInput = { references, bindings: [binding], facts };
  const outcome = updateBaseline({ ...reportInput, scope: [binding.id] });
  assert.equal(outcome.status, "updated");
  if (outcome.status !== "updated") throw new Error("有效关联应可更新基线。");
  return outcome.baseline;
}

void test("备注、对象键顺序和关联引用集合顺序不改变基线定义", () => {
  const baseline = updated();
  const currentReferences: ReferenceDefinition[] = [
    {
      id: "doc-paragraph",
      target: { format: "markdown", path: "docs/env.md" },
      selection: {
        steps: [
          { heading: "Env Variables", kind: "section" },
          { contains: "highest priority", type: "paragraph", kind: "node" },
        ],
      },
      note: "updated note",
    },
    {
      id: "doc-table-cell",
      target: { format: "markdown", path: "docs/env.md" },
      selection: {
        steps: [
          {
            column: "Mode",
            row: { value: "vite build", column: "Command" },
            kind: "table-cell",
          },
        ],
      },
    },
    {
      id: "code-symbol",
      target: { language: "typescript", path: "src/env.ts" },
      selection: {
        steps: [{ declaration: "function", name: ["loadEnv"], kind: "symbol" }],
      },
    },
    {
      id: "ordered-output",
      target: { kind: "selected-result", path: "src/output.ts" },
      selection: { steps: [{ name: "attempts", kind: "output" }] },
    },
  ];
  const currentBinding: BindingDefinition = {
    id: "env-contract",
    references: [
      "doc-table-cell",
      "doc-paragraph",
      "ordered-output",
      "code-symbol",
    ],
    note: "updated binding note",
  };

  const result = check({
    references: currentReferences,
    bindings: [currentBinding],
    facts,
    baseline,
  }).bindings[0]!;

  assert.equal(result.consistency, "consistent");
  assert.deepEqual(result.changes, []);
});

void test("选择步骤定义与有序结果内容保留顺序并产生可解释差异", () => {
  const baseline = updated();
  const changedSteps = references.map((reference) =>
    reference.id === "doc-paragraph"
      ? {
          ...reference,
          selection: {
            steps: [
              { kind: "node", type: "paragraph", contains: "highest priority" },
              { kind: "section", heading: "Env Variables" },
            ],
          },
        }
      : reference,
  );
  const definitionChange = check({
    references: changedSteps,
    bindings: [binding],
    facts,
    baseline,
  }).bindings[0]!;

  assert.equal(definitionChange.consistency, "inconsistent");
  assert.deepEqual(definitionChange.changes, [
    {
      kind: "reference-definition",
      referenceId: "doc-paragraph",
      before: references[0],
      after: changedSteps[0],
    },
  ]);

  const outputChange = check({
    references,
    bindings: [binding],
    facts: facts.map((fact) =>
      fact.referenceId === "ordered-output"
        ? { ...fact, value: ["second", "first"] }
        : fact,
    ),
    baseline,
  }).bindings[0]!;

  assert.deepEqual(outputChange.changes, [
    {
      kind: "fact",
      referenceId: "ordered-output",
      before: ["first", "second"],
      after: ["second", "first"],
    },
  ]);
});

void test("旧事实与旧定义的变化说明和输入基线双向独立", () => {
  const baseline = updated();
  const currentReferences = references.map((reference) =>
    reference.id === "doc-paragraph"
      ? { ...reference, target: { path: "docs/new-env.md" } }
      : reference,
  );
  currentReferences.push({ id: "extra", target: "extra.json" });
  const input: CheckInput = {
    references: currentReferences,
    bindings: [{ ...binding, references: [...binding.references, "extra"] }],
    facts: [
      ...facts.map((fact) =>
        fact.referenceId === "ordered-output"
          ? { referenceId: "ordered-output", value: ["updated", "output"] }
          : fact,
      ),
      { referenceId: "extra", value: "extra" },
    ],
    baseline,
  };
  const baselineBeforeCheck = JSON.stringify(baseline);
  const result = check(input).bindings[0]!;
  assert.equal(JSON.stringify(baseline), baselineBeforeCheck);
  const bindingChange = result.changes.find(
    (change) => change.kind === "binding-definition",
  );
  const referenceChange = result.changes.find(
    (change) => change.kind === "reference-definition",
  );
  const factChange = result.changes.find((change) => change.kind === "fact");
  assert.ok(bindingChange?.kind === "binding-definition");
  assert.ok(referenceChange?.kind === "reference-definition");
  assert.ok(factChange?.kind === "fact" && "before" in factChange);
  if (
    bindingChange?.kind !== "binding-definition" ||
    referenceChange?.kind !== "reference-definition" ||
    factChange?.kind !== "fact" ||
    !("before" in factChange)
  ) {
    return;
  }

  const oldBinding = baseline.bindings["env-contract"]!;
  const oldReference = oldBinding.references["doc-paragraph"]!;
  const oldFact = oldBinding.references["ordered-output"]!;
  oldBinding.definition.references[0] = "from-input";
  (oldReference.definition.target as { path: string }).path = "from-input";
  (oldFact.value as string[])[0] = "from-input";
  assert.deepEqual(bindingChange.before.references, binding.references);
  assert.equal(
    (referenceChange.before.target as { path: string }).path,
    "docs/env.md",
  );
  assert.deepEqual(factChange.before, ["first", "second"]);

  bindingChange.before.references[0] = "from-report";
  (referenceChange.before.target as { path: string }).path = "from-report";
  (factChange.before as string[])[0] = "from-report";
  assert.equal(oldBinding.definition.references[0], "from-input");
  assert.equal(
    (oldReference.definition.target as { path: string }).path,
    "from-input",
  );
  assert.equal((oldFact.value as string[])[0], "from-input");
});

void test("取消跟踪说明与输入基线双向独立", () => {
  const baseline = updated();
  const outcome = updateBaseline({
    references: [],
    bindings: [],
    facts: [],
    baseline,
    declarationCompleteness: "complete",
    scope: [binding.id],
  });
  assert.equal(outcome.status, "updated");
  if (outcome.status !== "updated") return;
  assert.equal(Object.hasOwn(outcome.baseline.bindings, binding.id), false);

  const removal = outcome.report.bindings[0]!;
  assert.ok("untracked" in removal && removal.untracked === true);
  if (!("untracked" in removal) || removal.untracked !== true) return;
  const before = removal.changes[0].before;
  const oldDefinition = baseline.bindings[binding.id]!.definition;
  oldDefinition.references[0] = "from-input";
  assert.equal(before.references[0], binding.references[0]);
  before.references[0] = "from-report";
  assert.equal(oldDefinition.references[0], "from-input");
});

void test("更新所得基线与当前输入和报告双向独立", () => {
  const baseline = updated();
  const currentReferences = references.map((reference) =>
    reference.id === "doc-paragraph"
      ? { ...reference, target: { path: "docs/new-env.md" } }
      : reference,
  );
  const currentFacts = facts.map((fact) =>
    fact.referenceId === "ordered-output"
      ? { referenceId: "ordered-output", value: ["updated", "output"] }
      : fact,
  );
  const outcome = updateBaseline({
    references: currentReferences,
    bindings: [binding],
    facts: currentFacts,
    baseline,
  });
  assert.equal(outcome.status, "updated");
  if (outcome.status !== "updated") return;

  const report = outcome.report.bindings[0]!;
  assert.ok("current" in report);
  if (!("current" in report)) return;
  const reportedReference = report.current.references["doc-paragraph"]!;
  const reportedOutput = report.current.references["ordered-output"]!;
  const storedBinding = outcome.baseline.bindings[binding.id]!;
  const storedReference = storedBinding.references["doc-paragraph"]!;
  const storedOutput = storedBinding.references["ordered-output"]!;

  (currentReferences[0]!.target as { path: string }).path = "input.json";
  const inputOutput = currentFacts[3]!;
  assert.ok("value" in inputOutput);
  if (!("value" in inputOutput)) return;
  (inputOutput.value as string[])[0] = "input";
  assert.equal(
    (storedReference.definition.target as { path: string }).path,
    "docs/new-env.md",
  );
  assert.equal((storedOutput.value as string[])[0], "updated");
  assert.equal(
    (reportedReference.definition.target as { path: string }).path,
    "docs/new-env.md",
  );
  assert.equal((reportedOutput.value as string[])[0], "updated");

  (reportedReference.definition.target as { path: string }).path =
    "report.json";
  (reportedOutput.value as string[])[0] = "report";
  assert.equal(
    (storedReference.definition.target as { path: string }).path,
    "docs/new-env.md",
  );
  assert.equal((storedOutput.value as string[])[0], "updated");

  (storedReference.definition.target as { path: string }).path =
    "baseline.json";
  (storedOutput.value as string[])[0] = "baseline";
  assert.equal(
    (reportedReference.definition.target as { path: string }).path,
    "report.json",
  );
  assert.equal((reportedOutput.value as string[])[0], "report");
});
