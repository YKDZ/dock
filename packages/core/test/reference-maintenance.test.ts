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
