import assert from "node:assert/strict";
import { test } from "node:test";

import type { TextRange } from "@dock/core";
import {
  assertTextSelectionStep,
  selectTextRange,
  TextSelectionError,
  type TextSelectionStep,
} from "@dock/text-selection";

function fullRange(path: string, source: string): TextRange {
  return { path, start: 0, end: source.length };
}

void test("quote selects unique UTF-16 ranges and rejects missing, duplicate, overlapping, or empty text", () => {
  const source = "😀prefix\nTARGET\nsuffix\n";
  const selected = selectTextRange(source, fullRange("guide.md", source), {
    kind: "quote",
    text: "TARGET",
  });
  assert.deepEqual(selected, {
    path: "guide.md",
    start: source.indexOf("TARGET"),
    end: source.indexOf("TARGET") + "TARGET".length,
  });
  assert.equal(source.slice(selected.start, selected.end), "TARGET");

  const errorCases: readonly {
    readonly name: string;
    readonly text: string;
    readonly quote: string;
    readonly code: string;
  }[] = [
    {
      name: "missing",
      text: "alpha",
      quote: "beta",
      code: "missing-selection",
    },
    {
      name: "duplicate",
      text: "token token",
      quote: "token",
      code: "ambiguous-selection",
    },
    {
      name: "overlapping",
      text: "ababa",
      quote: "aba",
      code: "ambiguous-selection",
    },
    { name: "empty", text: "alpha", quote: "", code: "invalid-selector" },
  ];

  for (const item of errorCases) {
    assert.throws(
      () =>
        selectTextRange(item.text, fullRange("doc.txt", item.text), {
          kind: "quote",
          text: item.quote,
        }),
      (error: unknown) =>
        error instanceof TextSelectionError && error.code === item.code,
      item.name,
    );
  }
});

void test("match supports full and capture-group hits without stateful index leakage and rejects invalid, empty, missing, or ambiguous regexes", () => {
  const source = "😀env\nport=4173\n";
  const range = fullRange("app.env", source);

  const whole = selectTextRange(source, range, {
    kind: "match",
    pattern: "port=\\d+",
  });
  assert.equal(source.slice(whole.start, whole.end), "port=4173");

  const captureStep: TextSelectionStep = {
    kind: "match",
    pattern: "port=(\\d+)",
    group: 1,
  };
  const firstCapture = selectTextRange(source, range, captureStep);
  const secondCapture = selectTextRange(source, range, captureStep);
  assert.deepEqual(firstCapture, {
    path: "app.env",
    start: source.indexOf("4173"),
    end: source.indexOf("4173") + 4,
  });
  assert.deepEqual(secondCapture, firstCapture);

  const errorCases: readonly {
    readonly name: string;
    readonly text: string;
    readonly step: TextSelectionStep;
    readonly code: string;
  }[] = [
    {
      name: "empty pattern",
      text: "abc",
      step: { kind: "match", pattern: "" },
      code: "invalid-selector",
    },
    {
      name: "negative capture group",
      text: "port=4173",
      step: { kind: "match", pattern: "port=(\\d+)", group: -1 },
      code: "invalid-selector",
    },
    {
      name: "fractional capture group",
      text: "port=4173",
      step: { kind: "match", pattern: "port=(\\d+)", group: 1.5 },
      code: "invalid-selector",
    },
    {
      name: "invalid regex syntax",
      text: "abc",
      step: { kind: "match", pattern: "(" },
      code: "invalid-regex",
    },
    {
      name: "invalid inline regex flag",
      text: "abc",
      step: { kind: "match", pattern: "(?g:abc)" },
      code: "invalid-regex",
    },
    {
      name: "zero-length match",
      text: "bbb",
      step: { kind: "match", pattern: "a*" },
      code: "empty-match",
    },
    {
      name: "missing capture group",
      text: "a",
      step: { kind: "match", pattern: "(a)", group: 2 },
      code: "missing-capture",
    },
    {
      name: "empty capture group",
      text: "b",
      step: { kind: "match", pattern: "(a*)b", group: 1 },
      code: "empty-capture",
    },
    {
      name: "multiple matches",
      text: "a a",
      step: { kind: "match", pattern: "(a)", group: 1 },
      code: "ambiguous-selection",
    },
    {
      name: "overlapping matches",
      text: "ababa",
      step: { kind: "match", pattern: "aba" },
      code: "ambiguous-selection",
    },
    {
      name: "missing match",
      text: "host=localhost",
      step: { kind: "match", pattern: "port=(\\d+)", group: 1 },
      code: "missing-selection",
    },
  ];

  for (const item of errorCases) {
    assert.throws(
      () =>
        selectTextRange(item.text, fullRange("doc.txt", item.text), item.step),
      (error: unknown) =>
        error instanceof TextSelectionError && error.code === item.code,
      item.name,
    );
  }
});

void test("region selects named region bodies across LF/CRLF and rejects missing, duplicate, unclosed, reversed, empty, or invalid markers", () => {
  const crlfSource =
    "😀header\r\n  #region runtime \r\nport=4173\r\nhost=localhost\r\n  #endregion runtime\r\n";
  const selected = selectTextRange(
    crlfSource,
    fullRange("app.env", crlfSource),
    { kind: "region", name: "runtime" },
  );
  assert.equal(
    crlfSource.slice(selected.start, selected.end),
    "port=4173\r\nhost=localhost\r\n",
  );

  const errorCases: readonly {
    readonly name: string;
    readonly text: string;
    readonly regionName: string;
    readonly code: string;
  }[] = [
    {
      name: "missing region",
      text: "#region other\nbody\n#endregion other\n",
      regionName: "runtime",
      code: "missing-region",
    },
    {
      name: "duplicate region",
      text: "#region dup\na\n#endregion dup\n#region dup\nb\n#endregion dup\n",
      regionName: "dup",
      code: "ambiguous-region",
    },
    {
      name: "unclosed region",
      text: "#region open\nbody\n",
      regionName: "open",
      code: "malformed-region",
    },
    {
      name: "reversed endregion before region",
      text: "#endregion open\n#region open\nbody\n",
      regionName: "open",
      code: "malformed-region",
    },
    {
      name: "mismatched region",
      text: "#region open\nbody\n#endregion other\n",
      regionName: "open",
      code: "malformed-region",
    },
    {
      name: "unnamed region",
      text: "#region\nbody\n#endregion\n",
      regionName: "named",
      code: "malformed-region",
    },
    {
      name: "empty region body",
      text: "#region empty\n \t\n#endregion empty\n",
      regionName: "empty",
      code: "empty-region",
    },
    {
      name: "empty region selector name",
      text: "#region ok\nbody\n#endregion ok\n",
      regionName: "",
      code: "invalid-selector",
    },
    {
      name: "padded region selector name",
      text: "#region ok\nbody\n#endregion ok\n",
      regionName: " ok ",
      code: "invalid-selector",
    },
    {
      name: "multiline region selector name",
      text: "#region ok\nbody\n#endregion ok\n",
      regionName: "a\nb",
      code: "invalid-selector",
    },
  ];

  for (const item of errorCases) {
    assert.throws(
      () =>
        selectTextRange(item.text, fullRange("doc.txt", item.text), {
          kind: "region",
          name: item.regionName,
        }),
      (error: unknown) =>
        error instanceof TextSelectionError && error.code === item.code,
      item.name,
    );
  }
});

void test("chained narrowing preserves original UTF-16 offsets and rejects widening or invalid input ranges", () => {
  const source = [
    "😀outside port=9999",
    "#region outer",
    "outer-only",
    "#region settings",
    "host=localhost",
    "port=4173",
    "#endregion settings",
    "after",
    "#endregion outer",
    "",
  ].join("\n");

  const outer = selectTextRange(source, fullRange("settings.env", source), {
    kind: "region",
    name: "outer",
  });
  const settings = selectTextRange(source, outer, {
    kind: "region",
    name: "settings",
  });
  const portLine = selectTextRange(source, settings, {
    kind: "quote",
    text: "port=4173",
  });
  const portValue = selectTextRange(source, portLine, {
    kind: "match",
    pattern: "port=(\\d+)",
    group: 1,
  });

  assert.deepEqual(portValue, {
    path: "settings.env",
    start: source.indexOf("4173"),
    end: source.indexOf("4173") + 4,
  });
  assert.equal(source.slice(portValue.start, portValue.end), "4173");

  assert.throws(
    () =>
      selectTextRange(source, settings, {
        kind: "quote",
        text: "outside",
      }),
    (error: unknown) =>
      error instanceof TextSelectionError && error.code === "missing-selection",
  );

  for (const badRange of [
    { path: "settings.env", start: -1, end: 2 },
    { path: "settings.env", start: 5, end: 3 },
    { path: "settings.env", start: 0, end: source.length + 1 },
    { path: "settings.env", start: 0.5, end: 2 },
  ]) {
    assert.throws(
      () =>
        selectTextRange(source, badRange, {
          kind: "quote",
          text: "port=4173",
        }),
      (error: unknown) =>
        error instanceof TextSelectionError && error.code === "invalid-range",
    );
  }
});

void test("assertTextSelectionStep accepts valid steps and rejects malformed step objects", () => {
  const validSteps: readonly TextSelectionStep[] = [
    { kind: "quote", text: "hello" },
    { kind: "match", pattern: "port=(\\d+)" },
    { kind: "match", pattern: "port=(\\d+)", group: 1 },
    { kind: "region", name: "runtime" },
  ];
  for (const step of validSteps) {
    assertTextSelectionStep(step);
  }

  const invalidSteps: readonly unknown[] = [
    null,
    "quote",
    [],
    { kind: "unknown" },
    { kind: "quote" },
    { kind: "quote", text: 42 },
    { kind: "quote", text: "ok", extra: true },
    { kind: "match" },
    { kind: "match", pattern: 42 },
    { kind: "match", pattern: "a", group: -1 },
    { kind: "match", pattern: "a", group: 1.5 },
    { kind: "match", pattern: "a", group: "1" },
    { kind: "match", pattern: "a", gropu: 1 },
    { kind: "region" },
    { kind: "region", name: 42 },
    { kind: "region", name: "env", extra: true },
  ];
  for (const step of invalidSteps) {
    assert.throws(() => assertTextSelectionStep(step), TypeError);
  }
});
