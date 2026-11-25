import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertBaseline,
  BaselineValidationError,
  check,
  cstToJsonValue,
  JsonSyntaxError,
  parseBaselineJson,
  type Baseline,
} from "@dock/core";

void test("parseBaselineJson accepts valid V3 baselines with stable IDs containing spaces/dots and custom plugin business fields", () => {
  const bindingsFixture: Record<string, unknown> = {
    "cli policy.v1": {
      definition: {
        id: "cli policy.v1",
        note: "Checks CLI output and suite members",
        references: ["cli exit code", "suite.members"],
      },
      references: {
        "cli exit code": {
          definition: {
            id: "cli exit code",
            target: { path: "README.md", section: "Exit codes" },
            selection: { kind: "quote", text: "exit 1" },
          },
          value: {
            exitCode: 1,
            businessMeta: { severity: "blocking", tags: ["cli", "docs"] },
          },
        },
        "suite.members": {
          definition: {
            id: "suite.members",
            target: "tests/cli.test.ts",
          },
          valueKind: "member-collection",
          value: [
            {
              id: "test/cli failure",
              value: {
                status: "passed",
                durationMs: 12,
                customPayload: { retries: 0 },
              },
            },
          ],
        },
      },
    },
  };
  const protoValue: Record<string, unknown> = { ok: true };
  Object.defineProperty(protoValue, "__proto__", {
    value: "safe",
    enumerable: true,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(bindingsFixture, "__proto__", {
    value: {
      definition: {
        id: "__proto__",
        references: ["toString"],
      },
      references: {
        toString: {
          definition: { id: "toString", target: "proto.txt" },
          value: protoValue,
        },
      },
    },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  const raw = JSON.stringify(
    {
      version: 3,
      bindings: bindingsFixture,
    },
    null,
    2,
  );

  const baseline = parseBaselineJson(raw);
  assert.equal(baseline.version, 3);
  assert.deepEqual(
    baseline.bindings["cli policy.v1"]?.references["cli exit code"]?.value,
    {
      exitCode: 1,
      businessMeta: { severity: "blocking", tags: ["cli", "docs"] },
    },
  );
  assert.deepEqual(
    baseline.bindings["cli policy.v1"]?.references["suite.members"]?.value,
    [
      {
        id: "test/cli failure",
        value: {
          status: "passed",
          durationMs: 12,
          customPayload: { retries: 0 },
        },
      },
    ],
  );
  assert.equal(Object.hasOwn(baseline.bindings, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(baseline.bindings), null);
});

void test("parseBaselineJson distinguishes missing required reference facts from unexpected extra reference facts", () => {
  const missingRefRaw = JSON.stringify(
    {
      version: 3,
      bindings: {
        "doc-binding": {
          definition: { id: "doc-binding", references: ["ref-a", "ref-b"] },
          references: {
            "ref-a": {
              definition: { id: "ref-a", target: "a.txt" },
              value: "a",
            },
          },
        },
      },
    },
    null,
    2,
  );

  assert.throws(
    () => parseBaselineJson(missingRefRaw),
    (error: unknown) => {
      assert.ok(error instanceof BaselineValidationError);
      assert.equal(error.issues.length, 1);
      assert.equal(error.issues[0]?.code, "missing-reference-fact");
      assert.match(error.issues[0].path, /doc-binding/);
      assert.match(error.issues[0].path, /ref-b/);
      assert.match(error.issues[0].message, /missing required reference fact/i);
      assert.match(error.issues[0].message, /doc-binding/);
      assert.match(error.issues[0].message, /ref-b/);
      return true;
    },
  );

  const extraRefRaw = JSON.stringify(
    {
      version: 3,
      bindings: {
        "doc-binding": {
          definition: { id: "doc-binding", references: ["ref-a"] },
          references: {
            "ref-a": {
              definition: { id: "ref-a", target: "a.txt" },
              value: "a",
            },
            "ref-extra": {
              definition: { id: "ref-extra", target: "extra.txt" },
              value: "extra",
            },
          },
        },
      },
    },
    null,
    2,
  );

  assert.throws(
    () => parseBaselineJson(extraRefRaw),
    (error: unknown) => {
      assert.ok(error instanceof BaselineValidationError);
      assert.equal(error.issues.length, 1);
      assert.equal(error.issues[0]?.code, "unexpected-reference-fact");
      assert.match(error.issues[0].path, /doc-binding/);
      assert.match(error.issues[0].path, /ref-extra/);
      assert.match(error.issues[0].message, /unexpected reference fact/i);
      assert.doesNotMatch(error.issues[0].message, /missing required/i);
      assert.match(error.issues[0].message, /doc-binding/);
      assert.match(error.issues[0].message, /ref-extra/);
      return true;
    },
  );
});

void test("parseBaselineJson reports unknown fields and raw duplicate keys across Dock-owned records and member-collection items in one pass", () => {
  const corruptedRaw = [
    "{",
    '  "version": 3,',
    '  "rootExtra": true,',
    '  "bindings": {',
    '    "b1": {',
    '      "definition": {',
    '        "id": "b1",',
    '        "id": "b1",',
    '        "references": ["r1"],',
    '        "defExtra": 1',
    "      },",
    '      "bindingExtra": 2,',
    '      "references": {',
    '        "r1": {',
    '          "definition": {',
    '            "id": "r1",',
    '            "target": "file.txt",',
    '            "refDefExtra": true',
    "          },",
    '          "value": "ok",',
    '          "value": "dup",',
    '          "vaule": "typo"',
    "        }",
    "      }",
    "    },",
    '    "b2": {',
    '      "definition": { "id": "b2", "references": ["mc"] },',
    '      "references": {',
    '        "mc": {',
    '          "definition": { "id": "mc", "target": "suite.ts" },',
    '          "valueKind": "member-collection",',
    '          "value": [',
    '            { "id": "m1", "id": "m1", "value": { "custom": 1 }, "extraMemberField": true }',
    "          ]",
    "        }",
    "      }",
    "    }",
    "  }",
    "}",
  ].join("\n");

  assert.throws(
    () => parseBaselineJson(corruptedRaw),
    (error: unknown) => {
      assert.ok(error instanceof BaselineValidationError);
      const codesAndPaths = error.issues.map((issue) => [
        issue.code,
        issue.path,
      ]);
      assert.deepEqual(codesAndPaths, [
        ["unknown-field", "$.rootExtra"],
        ["duplicate-key", '$.bindings["b1"].definition.id'],
        ["unknown-field", '$.bindings["b1"].definition.defExtra'],
        ["unknown-field", '$.bindings["b1"].bindingExtra'],
        [
          "unknown-field",
          '$.bindings["b1"].references["r1"].definition.refDefExtra',
        ],
        ["duplicate-key", '$.bindings["b1"].references["r1"].value'],
        ["unknown-field", '$.bindings["b1"].references["r1"].vaule'],
        ["duplicate-key", '$.bindings["b2"].references["mc"].value[0].id'],
        [
          "unknown-field",
          '$.bindings["b2"].references["mc"].value[0].extraMemberField',
        ],
      ]);
      // Duplicate key "value" should appear once, not twice.
      assert.equal(
        error.issues.filter(
          (issue) =>
            issue.code === "duplicate-key" &&
            issue.path === '$.bindings["b1"].references["r1"].value',
        ).length,
        1,
      );
      return true;
    },
  );
});

void test("parseBaselineJson supports duplicate binding/reference keys, triple duplicate keys reported once, legacy version 2, and validateTargetDefinition hook", () => {
  const dupMapKeys = [
    "{",
    '  "version": 3,',
    '  "bindings": {',
    '    "b1": { "definition": { "id": "b1", "references": ["r1"] }, "references": { "r1": { "definition": { "id": "r1", "target": "a" }, "value": 1 } } },',
    '    "b1": { "definition": { "id": "b1", "references": ["r1"] }, "references": { "r1": { "definition": { "id": "r1", "target": "a" }, "value": 1 } } },',
    '    "b1": { "definition": { "id": "b1", "references": ["r1"] }, "references": { "r1": { "definition": { "id": "r1", "target": "a" }, "value": 1 } } },',
    '    "b2": { "definition": { "id": "b2", "references": ["r1"] }, "references": { "r1": { "definition": { "id": "r1", "target": "a" }, "value": 1 }, "r1": { "definition": { "id": "r1", "target": "b" }, "value": 2 } } }',
    "  }",
    "}",
  ].join("\n");

  assert.throws(
    () => parseBaselineJson(dupMapKeys),
    (error: unknown) => {
      assert.ok(error instanceof BaselineValidationError);
      assert.deepEqual(
        error.issues.map((issue) => [issue.code, issue.path]),
        [
          ["duplicate-key", '$.bindings["b1"]'],
          ["duplicate-key", '$.bindings["b2"].references["r1"]'],
        ],
      );
      return true;
    },
  );

  const legacyRaw = JSON.stringify({ version: 2, bindings: {} });
  assert.throws(
    () => parseBaselineJson(legacyRaw),
    (error: unknown) => {
      assert.ok(error instanceof BaselineValidationError);
      assert.equal(error.issues[0]?.code, "invalid-version");
      assert.match(
        error.message,
        /Unsupported baseline version 2; expected version 3\./,
      );
      return true;
    },
  );

  assert.throws(() => parseBaselineJson("{invalid"), JsonSyntaxError);

  const hostTargetRaw = JSON.stringify({
    version: 3,
    bindings: {
      b1: {
        definition: { id: "b1", references: ["r1"] },
        references: {
          r1: {
            definition: {
              id: "r1",
              target: {
                pluginId: "p1",
                target: { customBusinessField: 42 },
                fileInfo: null,
                extraWrapper: true,
              },
            },
            value: "ok",
          },
        },
      },
    },
  });

  assert.throws(
    () =>
      parseBaselineJson(hostTargetRaw, {
        validateTargetDefinition(node, path, reportIssue) {
          if (node.kind !== "object") {
            reportIssue({
              path,
              code: "invalid-type",
              message: "Target wrapper must be an object.",
              line: node.span.start.line,
            });
            return undefined;
          }
          for (const prop of node.properties) {
            if (
              prop.key !== "pluginId" &&
              prop.key !== "target" &&
              prop.key !== "fileInfo"
            ) {
              reportIssue({
                path: `${path}.${prop.key}`,
                code: "unknown-field",
                message: `Unknown field ${JSON.stringify(prop.key)} at ${path}.${prop.key}.`,
                line: prop.keySpan.start.line,
              });
            }
          }
          return cstToJsonValue(node);
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof BaselineValidationError);
      assert.equal(error.issues.length, 1);
      assert.equal(error.issues[0]?.code, "unknown-field");
      assert.equal(
        error.issues[0]?.path,
        '$.bindings["b1"].references["r1"].definition.target.extraWrapper',
      );
      return true;
    },
  );
});

void test("assertBaseline validates in-memory objects for unknown fields, missing vs extra references, multiple issues, and zero getter invocations", () => {
  const validWithCustomFields: Baseline = {
    version: 3,
    bindings: {
      "cli binding": {
        definition: { id: "cli binding", references: ["plain", "collection"] },
        references: {
          plain: {
            definition: { id: "plain", target: "a.txt" },
            value: { customBusinessField: "preserved", nested: [1, 2] },
          },
          collection: {
            definition: { id: "collection", target: "suite.ts" },
            valueKind: "member-collection",
            value: [
              {
                id: "m1",
                value: { customMemberField: true, status: "passed" },
              },
            ],
          },
        },
      },
    },
  };
  assertBaseline(validWithCustomFields);

  const report = check({
    references: [
      { id: "plain", target: "a.txt" },
      { id: "collection", target: "suite.ts" },
    ],
    bindings: [{ id: "cli binding", references: ["plain", "collection"] }],
    facts: [
      {
        referenceId: "plain",
        value: { customBusinessField: "preserved", nested: [1, 2] },
      },
      {
        referenceId: "collection",
        collection: {
          completeness: "complete",
          members: [
            {
              id: "m1",
              value: { customMemberField: true, status: "passed" },
            },
          ],
        },
      },
    ],
    baseline: validWithCustomFields,
  });
  assert.equal(report.bindings[0]?.consistency, "consistent");

  let getterCalls = 0;
  const withGetter = Object.defineProperty(
    structuredClone(validWithCustomFields),
    "extraAccessor",
    {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "leaked";
      },
    },
  );
  assert.throws(() => assertBaseline(withGetter), BaselineValidationError);
  assert.equal(getterCalls, 0);

  const multiBad = {
    version: 3,
    extraRoot: 1,
    bindings: {
      b1: {
        definition: { id: "b1", references: ["r1", "rMissing"], extraDef: 1 },
        references: {
          r1: {
            definition: { id: "r1", target: "a" },
            value: "ok",
            vaule: "typo",
          },
          rExtra: {
            definition: { id: "rExtra", target: "b" },
            value: "extra",
          },
        },
      },
    },
  } as unknown as Baseline;

  assert.throws(
    () => assertBaseline(multiBad),
    (error: unknown) => {
      assert.ok(error instanceof BaselineValidationError);
      assert.deepEqual(
        error.issues.map((issue) => [issue.code, issue.path]),
        [
          ["unknown-field", "$.extraRoot"],
          ["unknown-field", '$.bindings["b1"].definition.extraDef'],
          ["missing-reference-fact", '$.bindings["b1"].references["rMissing"]'],
          ["unknown-field", '$.bindings["b1"].references["r1"].vaule'],
          [
            "unexpected-reference-fact",
            '$.bindings["b1"].references["rExtra"]',
          ],
        ],
      );
      return true;
    },
  );
});
