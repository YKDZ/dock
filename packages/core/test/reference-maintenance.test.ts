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
  documents: ["doc-paragraph", "doc-table-cell"],
  references: ["code-symbol", "ordered-output"],
  note: "initial binding note",
};

const facts: ReferenceFact[] = [
  {
    referenceId: "doc-paragraph",
    value: "Existing env vars have the highest priority.",
  },
  { referenceId: "doc-table-cell", value: '"production"' },
  { referenceId: "code-symbol", value: "function loadEnv()" },
  { referenceId: "ordered-output", value: ["first", "second"] },
];

function accepted() {
  const report = check({ references, bindings: [binding], facts });
  const outcome = accept(report, undefined, [binding.id]);
  assert.equal(outcome.status, "accepted");
  if (outcome.status !== "accepted") throw new Error("有效关联应可接受。");
  return outcome.baseline;
}

void test("备注、对象键顺序和关联端点集合顺序不改变已接受定义", () => {
  const baseline = accepted();
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
    documents: ["doc-table-cell", "doc-paragraph"],
    references: ["ordered-output", "code-symbol"],
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
  const baseline = accepted();
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
