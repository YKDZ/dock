import type { TextRange } from "@ykdz/dock";

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

/** 在原文件 UTF-16 范围内按单步精确收窄，并返回新的原文范围。 */
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
      return fail("invalid-selector", "不支持的普通文本选择步骤。");
  }
}

function selectQuote(
  input: TextRange,
  current: string,
  quoted: string,
): TextRange {
  if (quoted.length === 0) {
    return fail("invalid-selector", "原文引用不能为空。");
  }
  const start = current.indexOf(quoted);
  if (start < 0) return fail("missing-selection", "找不到指定原文。");
  if (current.indexOf(quoted, start + 1) >= 0) {
    return fail("ambiguous-selection", "指定原文不唯一。");
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
    return fail("invalid-selector", "正则表达式或捕获组无效。");
  }

  let expression: RegExp;
  try {
    expression = new RegExp(pattern, "dg");
  } catch {
    return fail("invalid-regex", "正则表达式无效。");
  }

  let selected: TextRange | undefined;
  for (
    let found = expression.exec(current);
    found !== null;
    found = expression.exec(current)
  ) {
    if (found[0].length === 0) {
      return fail("empty-match", "正则表达式产生空匹配。");
    }
    const capture = found.indices?.[group];
    if (capture === undefined) {
      return fail("missing-capture", `正则表达式未提供捕获组 ${group}。`);
    }
    if (capture[0] === capture[1]) {
      return fail("empty-capture", `正则表达式捕获组 ${group} 为空。`);
    }
    if (selected !== undefined) {
      return fail("ambiguous-selection", "正则表达式匹配不唯一。");
    }
    selected = range(input, capture[0], capture[1]);
    expression.lastIndex = found.index + 1;
  }

  if (selected === undefined) {
    return fail("missing-selection", "找不到符合正则表达式的原文。");
  }
  return selected;
}

function selectRegion(
  input: TextRange,
  current: string,
  name: string,
): TextRange {
  if (name.length === 0 || name !== name.trim() || /[\r\n]/u.test(name)) {
    return fail("invalid-selector", "region 名称必须是非空单行文本。");
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
        return fail("malformed-region", "region 标记必须提供名称。");
      }
      if (marker[1] === "region") {
        if (markerName === name && ++occurrences > 1) {
          return fail("ambiguous-region", `region ${name} 重复。`);
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
            `region ${markerName} 的结束标记没有对应起点。`,
          );
        }
        if (markerName === name) {
          const end = input.start + offset;
          if (
            opened.start === end ||
            current.slice(opened.start - input.start, end - input.start).trim()
              .length === 0
          ) {
            return fail("empty-region", `region ${name} 正文为空。`);
          }
          selected = { path: input.path, start: opened.start, end };
        }
      }
    }

    offset += line.length;
  }

  if (openRegions.length > 0) {
    const opened = openRegions.at(-1)!;
    return fail("malformed-region", `region ${opened.name} 未闭合。`);
  }
  if (selected === undefined) {
    return fail("missing-region", `找不到 region ${name}。`);
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
    return fail("invalid-range", "输入范围不是原文中的有效 UTF-16 区间。");
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

function fail(code: string, message: string): never {
  throw new TextSelectionError(code, message);
}
