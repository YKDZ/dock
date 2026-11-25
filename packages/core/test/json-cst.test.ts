import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertJsonValue,
  canonicalJson,
  cstToJsonValue,
  JsonSyntaxError,
  parseJsonDocument,
} from "@dock/core";

void test("parseJsonDocument parses RFC 8259 values with exact 1-based spans and preserves duplicate keys", () => {
  const source = [
    "{",
    '  "version": 3,',
    '  "version": 4,',
    '  "escaped": "a\\nb\\u0041\\ud83d\\ude00",',
    '  "nums": [-0, 1.25e-2, 0],',
    '  "flags": [true, false, null]',
    "}",
  ].join("\n");

  const root = parseJsonDocument(source);
  assert.equal(root.kind, "object");
  assert.equal(root.span.start.line, 1);
  assert.equal(root.span.start.column, 1);
  assert.equal(root.span.end.line, 7);
  assert.equal(root.span.end.column, 2);

  assert.equal(root.properties.length, 5);
  assert.equal(root.properties[0]?.key, "version");
  assert.equal(root.properties[0]?.keySpan.start.line, 2);
  assert.equal(root.properties[0]?.keySpan.start.column, 3);
  assert.equal(root.properties[1]?.key, "version");
  assert.equal(root.properties[1]?.keySpan.start.line, 3);

  const escaped = root.properties[2]?.value;
  assert.equal(escaped?.kind, "string");
  if (escaped?.kind === "string") {
    assert.equal(escaped.value, "a\nbA\u{1F600}");
  }

  const nums = root.properties[3]?.value;
  assert.equal(nums?.kind, "array");
  if (nums?.kind === "array") {
    assert.equal(nums.items[0]?.kind, "number");
    if (nums.items[0]?.kind === "number") {
      assert.equal(Object.is(nums.items[0].value, -0), true);
      assert.equal(nums.items[0].raw, "-0");
    }
    assert.equal(nums.items[1]?.kind, "number");
    if (nums.items[1]?.kind === "number") {
      assert.equal(nums.items[1].value, 0.0125);
    }
  }
});

void test("parseJsonDocument handles CRLF line endings and rejects non-RFC-8259 syntax with line and column", () => {
  const crlf = '{\r\n  "a": 1,\r\n  "b": 2\r\n}';
  const doc = parseJsonDocument(crlf);
  assert.equal(doc.kind, "object");
  if (doc.kind === "object") {
    assert.equal(doc.properties[1]?.keySpan.start.line, 3);
    assert.equal(doc.properties[1]?.keySpan.start.column, 3);
  }

  const invalidCases: readonly {
    readonly input: string;
    readonly line: number;
    readonly column: number;
  }[] = [
    { input: "", line: 1, column: 1 },
    { input: "   \n  ", line: 2, column: 3 },
    { input: '{"a": 1,}', line: 1, column: 9 },
    { input: "{'a': 1}", line: 1, column: 2 },
    { input: "{a: 1}", line: 1, column: 2 },
    { input: '{"a": +1}', line: 1, column: 7 },
    { input: '{"a": 01}', line: 1, column: 8 },
    { input: '{"a": 1.}', line: 1, column: 9 },
    { input: '{"a": 1e}', line: 1, column: 9 },
    { input: '{"a": 1e9999}', line: 1, column: 7 },
    { input: '{"a": "line\nbreak"}', line: 1, column: 12 },
    { input: '{"a": "\\x20"}', line: 1, column: 8 },
    { input: '{"a": "\\u123"}', line: 1, column: 8 },
    { input: '{"a": 1} trailing', line: 1, column: 10 },
    { input: "[1, 2,]", line: 1, column: 7 },
    { input: '{"a": 1\n  "b": 2}', line: 2, column: 3 },
  ];

  for (const testCase of invalidCases) {
    assert.throws(
      () => parseJsonDocument(testCase.input),
      (error: unknown) => {
        assert.ok(
          error instanceof JsonSyntaxError,
          `Expected JsonSyntaxError for ${JSON.stringify(testCase.input)}`,
        );
        assert.equal(
          error.line,
          testCase.line,
          `Line mismatch for ${JSON.stringify(testCase.input)}: ${error.message}`,
        );
        assert.equal(
          error.column,
          testCase.column,
          `Column mismatch for ${JSON.stringify(testCase.input)}: ${error.message}`,
        );
        return true;
      },
    );
  }
});

void test("cstToJsonValue preserves __proto__ as own data property and rejects lone surrogates", () => {
  const protoNode = parseJsonDocument(
    '{"__proto__":{"polluted":true},"ok":"yes"}',
  );
  const converted = cstToJsonValue(protoNode) as Record<string, unknown>;
  assertJsonValue(converted);
  assert.equal(Object.getPrototypeOf(converted), Object.prototype);
  assert.equal(Object.hasOwn(converted, "__proto__"), true);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(converted, "__proto__")?.value,
    {
      polluted: true,
    },
  );
  assert.equal(
    canonicalJson(converted as never),
    '{"__proto__":{"polluted":true},"ok":"yes"}',
  );

  const loneHigh = parseJsonDocument('{"bad":"\\uD800"}');
  assert.throws(() => cstToJsonValue(loneHigh), TypeError);

  const loneLow = parseJsonDocument('["\\uDC00"]');
  assert.throws(() => cstToJsonValue(loneLow), TypeError);
});
