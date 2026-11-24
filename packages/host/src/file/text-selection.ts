import type { TextRange } from "../core/index.ts";

export type TextSelectionStep =
  | { readonly kind: "quote"; readonly text: string }
  | {
      readonly kind: "match";
      readonly pattern: string;
      readonly group?: number;
    }
  | { readonly kind: "region"; readonly name: string };

export class TextSelectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TextSelectionError";
    this.code = code;
  }
}

/** Validates a shared plain text selection step's allowed fields and value types. */
export function assertTextSelectionStep(
  value: unknown,
): asserts value is TextSelectionStep {
  if (!isPlainRecord(value) || typeof value.kind !== "string") {
    throw new TypeError(
      "Text selection step must be a plain object with a kind.",
    );
  }

  switch (value.kind) {
    case "quote": {
      assertAllowedKeys(value, ["kind", "text"], "quote");
      if (typeof value.text !== "string") {
        throw new TypeError(
          'Quote selection step requires string field "text".',
        );
      }
      return;
    }
    case "match": {
      assertAllowedKeys(value, ["kind", "pattern", "group"], "match");
      if (typeof value.pattern !== "string") {
        throw new TypeError(
          'Match selection step requires string field "pattern".',
        );
      }
      if (
        Object.hasOwn(value, "group") &&
        (typeof value.group !== "number" ||
          !Number.isInteger(value.group) ||
          value.group < 0)
      ) {
        throw new TypeError(
          'Match selection step field "group" must be a non-negative integer.',
        );
      }
      return;
    }
    case "region": {
      assertAllowedKeys(value, ["kind", "name"], "region");
      if (typeof value.name !== "string") {
        throw new TypeError(
          'Region selection step requires string field "name".',
        );
      }
      return;
    }
    default:
      throw new TypeError(
        `Unsupported text selection step kind: ${JSON.stringify(value.kind)}.`,
      );
  }
}

/** Narrows an existing UTF-16 range within source text by one step and returns the new range. */
export function selectTextRange(
  source: string,
  input: TextRange,
  step: TextSelectionStep,
): TextRange {
  assertInputRange(source, input);
  const current = source.slice(input.start, input.end);

  switch (step.kind) {
    case "quote":
      return selectQuote(input, current, step.text);
    case "match":
      return selectMatch(input, current, step.pattern, step.group ?? 0);
    case "region":
      return selectRegion(input, current, step.name);
    default:
      return fail("invalid-selector", "Unsupported plain text selection step.");
  }
}

function selectQuote(
  input: TextRange,
  current: string,
  quoted: string,
): TextRange {
  if (quoted.length === 0) {
    return fail("invalid-selector", "Quoted text cannot be empty.");
  }
  const start = current.indexOf(quoted);
  if (start < 0) {
    return fail("missing-selection", "Specified text was not found.");
  }
  if (current.indexOf(quoted, start + 1) >= 0) {
    return fail("ambiguous-selection", "Specified text is not unique.");
  }
  return range(input, start, start + quoted.length);
}

function selectMatch(
  input: TextRange,
  current: string,
  pattern: string,
  group: number,
): TextRange {
  if (pattern.length === 0 || !Number.isInteger(group) || group < 0) {
    return fail(
      "invalid-selector",
      "Invalid regular expression or capture group.",
    );
  }

  let expression: RegExp;
  try {
    expression = new RegExp(pattern, "dg");
  } catch {
    return fail("invalid-regex", "Invalid regular expression.");
  }

  let selected: TextRange | undefined;
  for (
    let found = expression.exec(current);
    found !== null;
    found = expression.exec(current)
  ) {
    if (found[0].length === 0) {
      return fail("empty-match", "Regular expression produced an empty match.");
    }
    const capture = found.indices?.[group];
    if (capture === undefined) {
      return fail(
        "missing-capture",
        `Regular expression did not provide capture group ${group}.`,
      );
    }
    if (capture[0] === capture[1]) {
      return fail(
        "empty-capture",
        `Regular expression capture group ${group} is empty.`,
      );
    }
    if (selected !== undefined) {
      return fail(
        "ambiguous-selection",
        "Regular expression match is not unique.",
      );
    }
    selected = range(input, capture[0], capture[1]);
    expression.lastIndex = found.index + 1;
  }

  if (selected === undefined) {
    return fail(
      "missing-selection",
      "No text matching the regular expression was found.",
    );
  }
  return selected;
}

function selectRegion(
  input: TextRange,
  current: string,
  name: string,
): TextRange {
  if (name.length === 0 || name !== name.trim() || /[\r\n]/u.test(name)) {
    return fail(
      "invalid-selector",
      "Region name must be non-empty single-line text.",
    );
  }

  const openRegions: { readonly name: string; readonly start: number }[] = [];
  let selected: TextRange | undefined;
  let occurrences = 0;
  let offset = 0;

  for (const line of current.match(/.*(?:\r\n|[\r\n]|$)/gu) ?? []) {
    const content = line.replace(/(?:\r\n|[\r\n])$/u, "");
    const marker =
      /^[ \t]*#[ \t]*(region|endregion)(?:[ \t]+(.*?))?[ \t]*$/u.exec(content);

    if (marker !== null) {
      const markerName = marker[2]?.trim();
      if (markerName === undefined || markerName.length === 0) {
        return fail("malformed-region", "Region marker must specify a name.");
      }
      if (marker[1] === "region") {
        if (markerName === name && ++occurrences > 1) {
          return fail("ambiguous-region", `Duplicate region ${name}.`);
        }
        openRegions.push({
          name: markerName,
          start: input.start + offset + line.length,
        });
      } else {
        const opened = openRegions.pop();
        if (opened === undefined || opened.name !== markerName) {
          return fail(
            "malformed-region",
            `End marker for region ${markerName} has no matching start marker.`,
          );
        }
        if (markerName === name) {
          const end = input.start + offset;
          if (
            opened.start === end ||
            current.slice(opened.start - input.start, end - input.start).trim()
              .length === 0
          ) {
            return fail("empty-region", `Region ${name} body is empty.`);
          }
          selected = { path: input.path, start: opened.start, end };
        }
      }
    }

    offset += line.length;
  }

  if (openRegions.length > 0) {
    const opened = openRegions.at(-1)!;
    return fail("malformed-region", `Unclosed region ${opened.name}.`);
  }
  if (selected === undefined) {
    return fail("missing-region", `Region ${name} not found.`);
  }
  return selected;
}

function assertInputRange(source: string, input: TextRange): void {
  if (
    typeof input.path !== "string" ||
    !Number.isInteger(input.start) ||
    !Number.isInteger(input.end) ||
    input.start < 0 ||
    input.end < input.start ||
    input.end > source.length
  ) {
    return fail(
      "invalid-range",
      "Input range is not a valid UTF-16 interval within source text.",
    );
  }
}

function range(
  input: TextRange,
  relativeStart: number,
  relativeEnd: number,
): TextRange {
  return {
    path: input.path,
    start: input.start + relativeStart,
    end: input.start + relativeEnd,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  stepKind: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new TypeError(
        `Unexpected field "${key}" in ${stepKind} selection step.`,
      );
    }
  }
}

function fail(code: string, message: string): never {
  throw new TextSelectionError(code, message);
}
