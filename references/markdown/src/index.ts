import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { selectTextRange } from "@dock/reference-file";
import type { TextSelectionStep } from "@dock/reference-file";
import {
  createReference,
  definePlugin,
  type JsonValue,
  type PluginContext,
  type PluginReadResult,
  type PluginResult,
  type Reference,
  type ReferenceOptions,
  type ReadableReferencePlugin,
  type TextRange,
} from "@dock/sdk";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { parseFragment } from "parse5";

export const markdownPluginId = "@dock/reference-markdown" as const;

export type MarkdownNodeType =
  | "paragraph"
  | "listItem"
  | "code"
  | "inlineCode"
  | "link"
  | "table";

export type MarkdownNodeSelection =
  | {
      type: "paragraph" | "listItem" | "inlineCode" | "table";
      contains?: string;
    }
  | { type: "code"; contains?: string; language?: string }
  | { type: "link"; contains?: string; url?: string };

export type MarkdownTableCellSelection = {
  column: string;
  row: { column: string; value: string };
};

export type MarkdownSelectionStep =
  | { kind: "section"; heading: string | string[] }
  | { kind: "node"; selector: MarkdownNodeSelection }
  | { kind: "tableCell"; selector: MarkdownTableCellSelection }
  | { kind: "marker"; id: string }
  | TextSelectionStep;

export type MarkdownSelection = {
  kind: "markdown";
  steps: MarkdownSelectionStep[];
};

export type MarkdownReference<
  Id extends string = string,
  Selection extends JsonValue = MarkdownSelection,
> = Reference<typeof markdownPluginId, Id, string, string, Selection>;

export type MarkdownReferenceOptions = Pick<
  ReferenceOptions,
  "note" | "declaredAt"
>;

export type MarkdownReferenceBuilder<
  Selection extends JsonValue = MarkdownSelection,
> = {
  section(
    heading: string | readonly string[],
  ): MarkdownReferenceBuilder<MarkdownSelection>;
  node(
    selector: MarkdownNodeSelection,
  ): MarkdownReferenceBuilder<MarkdownSelection>;
  tableCell(
    selector: MarkdownTableCellSelection,
  ): MarkdownReferenceBuilder<MarkdownSelection>;
  marker(id: string): MarkdownReferenceBuilder<MarkdownSelection>;
  quote(text: string): MarkdownReferenceBuilder<MarkdownSelection>;
  match(
    pattern: string,
    group?: number,
  ): MarkdownReferenceBuilder<MarkdownSelection>;
  region(name: string): MarkdownReferenceBuilder<MarkdownSelection>;
  reference<Id extends string>(
    id: Id,
    options?: MarkdownReferenceOptions,
  ): MarkdownReference<Id, Selection>;
};

export type MarkdownPlugin = ReadableReferencePlugin<
  typeof markdownPluginId,
  MarkdownReference,
  string
> & {
  from(target: string | URL): MarkdownReferenceBuilder<never>;
};

type MarkdownNode = {
  readonly type: string;
  readonly value?: string;
  readonly alt?: string | null;
  readonly lang?: string | null;
  readonly url?: string;
  readonly depth?: number;
  readonly children?: readonly MarkdownNode[];
  readonly position?: {
    readonly start: { readonly offset?: number; readonly line?: number };
    readonly end: { readonly offset?: number };
  };
};

type MarkdownRoot = MarkdownNode & {
  readonly children: readonly MarkdownNode[];
};

type NodeOffsets = { readonly start: number; readonly end: number };

class MarkdownReferenceError extends Error {
  readonly code: string;
  readonly range: TextRange | undefined;

  constructor(
    code: string,
    message: string,
    range?: TextRange,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MarkdownReferenceError";
    this.code = code;
    this.range = range;
  }
}

const implementation = definePlugin({
  id: markdownPluginId,
  validate(reference: MarkdownReference): void {
    try {
      assertMarkdownTarget(reference.target);
      assertMarkdownSelection(reference.selection);
    } catch (error) {
      throw new TypeError(
        `Markdown 引用 ${reference.id} 无效：${errorMessage(error)}`,
        { cause: error },
      );
    }
  },
  fileInfo(reference: MarkdownReference, context: PluginContext): string {
    return resolveTarget(reference.target, context.root);
  },
  async collect(
    reference: MarkdownReference,
    context: PluginContext,
  ): Promise<PluginResult<string>> {
    try {
      const result = await readMarkdownReference(reference, context.root);
      return {
        kind: "value",
        value: result.value,
        ...(result.range === undefined ? {} : { range: result.range }),
      };
    } catch (error) {
      const range =
        error instanceof MarkdownReferenceError ? error.range : undefined;
      return {
        kind: "error",
        error: { code: errorCode(error), message: errorMessage(error) },
        ...(range === undefined ? {} : { range }),
      };
    }
  },
  async read(
    reference: MarkdownReference,
    context: PluginContext,
  ): Promise<PluginReadResult<string>> {
    return await readMarkdownReference(reference, context.root);
  },
});

export const markdown: MarkdownPlugin = {
  ...implementation,
  from(target: string | URL): MarkdownReferenceBuilder<never> {
    assertMarkdownTarget(target);
    return createBuilder<never>(
      target instanceof URL ? target.href : target,
      [],
    );
  },
};

function createBuilder<Selection extends JsonValue>(
  target: string,
  steps: MarkdownSelectionStep[],
): MarkdownReferenceBuilder<Selection> {
  return {
    section(heading): MarkdownReferenceBuilder<MarkdownSelection> {
      const normalizedHeading: string | string[] =
        typeof heading === "string" ? heading : Array.from(heading);
      return createBuilder<MarkdownSelection>(target, [
        ...steps,
        { kind: "section", heading: normalizedHeading },
      ]);
    },
    node(selector): MarkdownReferenceBuilder<MarkdownSelection> {
      return createBuilder<MarkdownSelection>(target, [
        ...steps,
        { kind: "node", selector },
      ]);
    },
    tableCell(selector): MarkdownReferenceBuilder<MarkdownSelection> {
      return createBuilder<MarkdownSelection>(target, [
        ...steps,
        { kind: "tableCell", selector },
      ]);
    },
    marker(id): MarkdownReferenceBuilder<MarkdownSelection> {
      return createBuilder<MarkdownSelection>(target, [
        ...steps,
        { kind: "marker", id },
      ]);
    },
    quote(text): MarkdownReferenceBuilder<MarkdownSelection> {
      return createBuilder<MarkdownSelection>(target, [
        ...steps,
        { kind: "quote", text },
      ]);
    },
    match(pattern, group): MarkdownReferenceBuilder<MarkdownSelection> {
      return createBuilder<MarkdownSelection>(target, [
        ...steps,
        { kind: "match", pattern, ...(group === undefined ? {} : { group }) },
      ]);
    },
    region(name): MarkdownReferenceBuilder<MarkdownSelection> {
      return createBuilder<MarkdownSelection>(target, [
        ...steps,
        { kind: "region", name },
      ]);
    },
    reference<Id extends string>(
      id: Id,
      options: MarkdownReferenceOptions = {},
    ): MarkdownReference<Id, Selection> {
      if (Object.hasOwn(options, "selection")) {
        throw new TypeError("Markdown selection 必须通过公开定位器构造。");
      }
      const selection =
        steps.length === 0 ? undefined : { kind: "markdown", steps };
      return createReference<
        typeof markdownPluginId,
        Id,
        string,
        string,
        Selection
      >(markdownPluginId, id, target, {
        ...(selection === undefined
          ? {}
          : { selection: selection as unknown as Selection }),
        ...(options.note === undefined ? {} : { note: options.note }),
        ...(options.declaredAt === undefined
          ? {}
          : { declaredAt: options.declaredAt }),
      });
    },
  };
}

async function readMarkdownReference(
  reference: MarkdownReference,
  root: string,
): Promise<PluginReadResult<string>> {
  let absolutePath: string;
  try {
    assertMarkdownTarget(reference.target);
    absolutePath = resolveTarget(reference.target, root);
  } catch (error) {
    throw new MarkdownReferenceError(
      "invalid-file-target",
      errorMessage(error),
      undefined,
      { cause: error },
    );
  }

  let source: string;
  const path = displayTarget(absolutePath, root);
  try {
    source = await readFile(absolutePath, "utf8");
  } catch (error) {
    const code = hasCode(error, "ENOENT") ? "missing-file" : "file-read-failed";
    throw new MarkdownReferenceError(
      code,
      `无法读取 Markdown 文件 ${path}：${errorMessage(error)}`,
      undefined,
      { cause: error },
    );
  }

  let current: TextRange = { path, start: 0, end: source.length };
  let selection: MarkdownSelection | undefined;
  try {
    selection = decodeMarkdownSelection(reference.selection);
  } catch (error) {
    throw new MarkdownReferenceError(
      "invalid-selection",
      `Markdown 引用 ${reference.id} 的 selection 无效：${errorMessage(error)}`,
      current,
      { cause: error },
    );
  }

  if (selection !== undefined) {
    for (const step of selection.steps) {
      try {
        current = selectMarkdownRange(source, current, step);
      } catch (error) {
        throw new MarkdownReferenceError(
          errorCode(error),
          errorMessage(error),
          current,
          { cause: error },
        );
      }
    }
  }

  return { value: markdownFact(source, current), range: current };
}

function selectMarkdownRange(
  source: string,
  input: TextRange,
  step: MarkdownSelectionStep,
): TextRange {
  if (step.kind === "marker") {
    return selectMarker(source, input, step.id);
  }
  if (
    step.kind === "quote" ||
    step.kind === "match" ||
    step.kind === "region"
  ) {
    return selectTextRange(source, input, step);
  }

  const current = source.slice(input.start, input.end);
  const root = parseMarkdown(current);
  let offsets: NodeOffsets;
  if (step.kind === "section") {
    offsets = selectSection(current, root, step.heading);
  } else if (step.kind === "node") {
    offsets = selectNode(current, root, step.selector);
  } else if (step.kind === "tableCell") {
    offsets = selectTableCell(current, root, step.selector);
  } else {
    throw new MarkdownReferenceError(
      "invalid-selector",
      "不支持的 Markdown 选择步骤。",
    );
  }

  return {
    path: input.path,
    start: input.start + offsets.start,
    end: input.start + offsets.end,
  };
}

type MarkdownMarker = {
  readonly id: string;
  readonly kind: "start" | "end";
  readonly start: number;
  readonly end: number;
};

type HtmlNode = {
  readonly nodeName: string;
  readonly childNodes?: readonly HtmlNode[];
  readonly content?: HtmlNode;
  readonly sourceCodeLocation?: {
    readonly startOffset: number;
    readonly endOffset: number;
  } | null;
};

function documentMarkers(source: string): MarkdownMarker[] {
  const markers: MarkdownMarker[] = [];
  const nodes = allNodes(parseMarkdown(source));
  const masked: string[] = source
    .split("")
    .map((character) =>
      character === "\r" || character === "\n" ? character : " ",
    );
  for (const node of nodes) {
    if (node.type !== "html") continue;
    const { start, end } = nodeOffsets(source, node);
    for (let offset = start; offset < end; offset++) {
      masked[offset] = source[offset]!;
    }
  }

  // 保留 Markdown 识别出的 HTML 片段，再统一解析，维持段内 script 的 raw-text 上下文。
  const fragment = parseFragment(masked.join(""), {
    sourceCodeLocationInfo: true,
  }) as unknown as HtmlNode;
  const visit = (html: HtmlNode): void => {
    const location = html.sourceCodeLocation;
    if (
      html.nodeName === "#comment" &&
      location !== null &&
      location !== undefined
    ) {
      const markerStart = location.startOffset;
      const markerEnd = location.endOffset;
      const match = /^<!--\s*dock:(start|end)\s+([^\s]+)\s*-->$/u.exec(
        source.slice(markerStart, markerEnd),
      );
      if (match !== null) {
        markers.push({
          id: match[2]!,
          kind: match[1]! as MarkdownMarker["kind"],
          start: markerStart,
          end: markerEnd,
        });
      }
    }
    html.childNodes?.forEach(visit);
    if (html.content !== undefined) visit(html.content);
  };
  visit(fragment);
  return markers.sort((left, right) => left.start - right.start);
}

function markdownFact(source: string, input: TextRange): string {
  let result = "";
  let cursor = input.start;
  for (const marker of documentMarkers(source)) {
    if (marker.end <= input.start || marker.start >= input.end) continue;
    const start = Math.max(input.start, marker.start);
    const end = Math.min(input.end, marker.end);
    result += source.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  return result + source.slice(cursor, input.end);
}

function selectMarker(source: string, input: TextRange, id: string): TextRange {
  if (!nonBlank(id) || /\s/u.test(id)) {
    throw invalidSelector("标记 ID 必须是非空单行文本。");
  }
  const markers = documentMarkers(source).filter((marker) => marker.id === id);
  const opening = one(
    markers.filter((marker) => marker.kind === "start"),
    `标记 ${id} 的起点`,
  );
  const closing = one(
    markers.filter((marker) => marker.kind === "end"),
    `标记 ${id} 的终点`,
  );
  if (opening.end > closing.start) {
    throw invalidSelector(`标记 ${id} 的终点必须位于起点之后。`);
  }
  if (opening.end < input.start || closing.start > input.end) {
    throw new MarkdownReferenceError(
      "missing-selection",
      `标记 ${id} 不在当前选择范围内。`,
    );
  }
  return { path: input.path, start: opening.end, end: closing.start };
}

function parseMarkdown(source: string): MarkdownRoot {
  return fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as unknown as MarkdownRoot;
}

function selectSection(
  source: string,
  root: MarkdownRoot,
  heading: string | readonly string[],
): NodeOffsets {
  if (Array.isArray(heading)) {
    if (heading.length === 0 || heading.some((part) => !nonBlank(part))) {
      throw invalidSelector("标题路径必须包含非空标题。 ");
    }
  } else if (!nonBlank(heading)) {
    throw invalidSelector("标题必须是非空文本。");
  }

  const ancestors: { depth: number; name: string }[] = [];
  const headings = root.children
    .filter((node) => node.type === "heading")
    .map((node) => {
      if (node.depth === undefined) {
        throw invalidMarkdown("Markdown 标题缺少层级。");
      }
      while (ancestors.length > 0 && ancestors.at(-1)!.depth >= node.depth) {
        ancestors.pop();
      }
      ancestors.push({
        depth: node.depth,
        name: normalizeLabel(rendered(node)),
      });
      return {
        node,
        path: ancestors.map((ancestor) => ancestor.name),
      };
    });

  const expected = Array.isArray(heading)
    ? heading.map(normalizeLabel)
    : [normalizeLabel(heading)];
  const matches = headings.filter((item) =>
    Array.isArray(heading)
      ? item.path.length === expected.length &&
        item.path.every((part, index) => part === expected[index])
      : item.path.at(-1) === expected[0],
  );
  const selected = one(matches, "指定标题");
  const selectedDepth = selected.node.depth!;
  const selectedIndex = headings.indexOf(selected);
  const next = headings
    .slice(selectedIndex + 1)
    .find((item) => item.node.depth! <= selectedDepth);
  const selectedPosition = nodeOffsets(source, selected.node);
  const end =
    next === undefined ? source.length : nodeOffsets(source, next.node).start;
  let start = selectedPosition.end;
  let trimmedEnd = end;

  // 只裁掉章节边界空行；首个正文行的缩进与其余原文保持不变。
  start +=
    source.slice(start, trimmedEnd).match(/^(?:[ \t]*(?:\r\n|\r|\n))+/u)?.[0]
      .length ?? 0;
  trimmedEnd -=
    source.slice(start, trimmedEnd).match(/(?:(?:\r\n|\r|\n)[ \t]*)+$/u)?.[0]
      .length ?? 0;
  if (source.slice(start, trimmedEnd).trim().length === 0) {
    throw new MarkdownReferenceError("missing-selection", "指定标题没有正文。");
  }
  return { start, end: trimmedEnd };
}

function selectNode(
  source: string,
  root: MarkdownRoot,
  selector: MarkdownNodeSelection,
): NodeOffsets {
  validateNodeSelector(selector);
  const matches = allNodes(root).filter((node) => {
    if (node.type !== selector.type) return false;
    if (
      selector.contains !== undefined &&
      !rendered(node).includes(selector.contains)
    ) {
      return false;
    }
    if (selector.type === "code" && selector.language !== undefined) {
      if (node.lang !== selector.language) return false;
    }
    if (selector.type === "link" && selector.url !== undefined) {
      if (node.url !== selector.url) return false;
    }
    return true;
  });
  const selected = one(matches, `Markdown ${selector.type} 节点`);
  return nodeOffsets(source, selected);
}

function validateNodeSelector(selector: MarkdownNodeSelection): void {
  if (typeof selector !== "object" || selector === null) {
    throw invalidSelector("Markdown 节点选择必须是对象。");
  }
  if (!isMarkdownNodeType(selector.type)) {
    throw invalidSelector("不支持该 Markdown 节点类型。");
  }
  if (selector.contains !== undefined && !nonBlank(selector.contains)) {
    throw invalidSelector("节点包含文本必须是非空文本。");
  }
  if ("language" in selector) {
    if (selector.type !== "code") {
      throw invalidSelector("language 只能用于代码块。");
    }
    if (!nonBlank(selector.language)) {
      throw invalidSelector("代码语言必须是非空文本。");
    }
  }
  if ("url" in selector) {
    if (selector.type !== "link") {
      throw invalidSelector("url 只能用于链接。");
    }
    if (!nonBlank(selector.url)) {
      throw invalidSelector("链接地址必须是非空文本。");
    }
  }
}

function selectTableCell(
  source: string,
  root: MarkdownRoot,
  selector: MarkdownTableCellSelection,
): NodeOffsets {
  validateTableCellSelector(selector);
  const matches: NodeOffsets[] = [];
  for (const table of allNodes(root).filter((node) => node.type === "table")) {
    const [header, ...rows] = table.children ?? [];
    const headerCells = header?.children ?? [];
    const names = headerCells.map((cell) => normalizeLabel(rendered(cell)));
    const keyColumns = names.flatMap((name, index) =>
      name === normalizeLabel(selector.row.column) ? [index] : [],
    );
    const valueColumns = names.flatMap((name, index) =>
      name === normalizeLabel(selector.column) ? [index] : [],
    );
    if (keyColumns.length === 0 || valueColumns.length === 0) continue;

    const matchingRows = rows.filter((row) =>
      keyColumns.some((index) => {
        const cell = row.children?.[index];
        return (
          cell !== undefined &&
          normalizeLabel(rendered(cell)) === normalizeLabel(selector.row.value)
        );
      }),
    );
    if (matchingRows.length === 0) continue;
    if (keyColumns.length !== 1 || valueColumns.length !== 1) {
      throw new MarkdownReferenceError(
        "ambiguous-selection",
        "匹配表格中的行键列或目标列标题重复。",
      );
    }
    if (matchingRows.length !== 1) {
      throw new MarkdownReferenceError(
        "ambiguous-selection",
        "匹配表格中的行键值重复。",
      );
    }

    const row = matchingRows[0]!;
    const cell = row.children?.[valueColumns[0]!];
    if (cell === undefined) continue;
    matches.push(tableCellOffsets(source, cell));
  }
  return one(matches, "表格单元格");
}

function validateTableCellSelector(selector: MarkdownTableCellSelection): void {
  if (
    typeof selector !== "object" ||
    selector === null ||
    !nonBlank(selector.column) ||
    typeof selector.row !== "object" ||
    selector.row === null ||
    !nonBlank(selector.row.column) ||
    !nonBlank(selector.row.value)
  ) {
    throw invalidSelector("表格单元格选择必须提供目标列及有效行键。");
  }
}

function tableCellOffsets(source: string, cell: MarkdownNode): NodeOffsets {
  const children = cell.children ?? [];
  if (children.length > 0) {
    return {
      start: nodeOffsets(source, children[0]!).start,
      end: nodeOffsets(source, children.at(-1)!).end,
    };
  }

  const position = nodeOffsets(source, cell);
  const firstPipe = source.indexOf("|", position.start);
  const lastPipe = source.lastIndexOf("|", position.end - 1);
  if (
    firstPipe < position.start ||
    lastPipe <= firstPipe ||
    lastPipe >= position.end
  ) {
    throw invalidMarkdown("Markdown 表格单元格没有对应原文范围。");
  }
  // 空单元格的 AST 范围包含左右分隔符，只在这段归属范围内取得内部空白。
  const span = trimCell(source, firstPipe + 1, lastPipe);
  if (span.start !== span.end) {
    throw invalidMarkdown("Markdown 空单元格范围包含意外内容。");
  }
  return span;
}

function trimCell(source: string, start: number, end: number): NodeOffsets {
  while (start < end && /[ \t]/u.test(source[start]!)) start++;
  while (end > start && /[ \t]/u.test(source[end - 1]!)) end--;
  return { start, end };
}

function allNodes(root: MarkdownNode): MarkdownNode[] {
  const result: MarkdownNode[] = [];
  const visit = (node: MarkdownNode): void => {
    result.push(node);
    node.children?.forEach(visit);
  };
  visit(root);
  return result;
}

function rendered(node: MarkdownNode): string {
  if (node.type === "image" || node.type === "imageReference") {
    return node.alt ?? "";
  }
  if (node.type === "html") return "";
  if (node.type === "break") return "\n";
  if (node.value !== undefined) return node.value;
  const separator = ["root", "list", "listItem", "table", "tableRow"].includes(
    node.type,
  )
    ? "\n"
    : "";
  return node.children?.map(rendered).join(separator) ?? "";
}

function nodeOffsets(source: string, node: MarkdownNode): NodeOffsets {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (
    start === undefined ||
    end === undefined ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > source.length
  ) {
    throw invalidMarkdown("Markdown 节点没有有效的原文 UTF-16 范围。");
  }
  return { start, end };
}

function assertMarkdownTarget(target: unknown): asserts target is string | URL {
  if (typeof target === "string") {
    if (target.length === 0 || target.includes("\0")) {
      throw new TypeError("Markdown 引用目标必须是非空、有效的路径文本。");
    }
    if (!target.startsWith("file:")) return;
    try {
      fileURLToPath(new URL(target));
      return;
    } catch {
      throw new TypeError("Markdown 引用目标必须是有效 file: URL。");
    }
  }
  if (!(target instanceof URL) || target.protocol !== "file:") {
    throw new TypeError("Markdown 引用目标必须是路径文本或 file: URL。");
  }
  try {
    fileURLToPath(target);
  } catch {
    throw new TypeError("Markdown 引用目标必须是有效 file: URL。");
  }
}

function assertMarkdownSelection(value: unknown): void {
  if (value === undefined) return;
  if (
    !isRecord(value) ||
    value.kind !== "markdown" ||
    Object.keys(value).length !== 2 ||
    !Array.isArray(value.steps) ||
    value.steps.length === 0
  ) {
    throw invalidSelector("Markdown selection 必须是合法且非空的步骤列表。");
  }
  for (const step of value.steps) assertMarkdownStep(step);
}

function decodeMarkdownSelection(
  value: JsonValue | undefined,
): MarkdownSelection | undefined {
  assertMarkdownSelection(value);
  return value === undefined ? undefined : (value as MarkdownSelection);
}

function assertMarkdownStep(
  value: JsonValue,
): asserts value is MarkdownSelectionStep {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw invalidSelector("Markdown 选择步骤必须是有效对象。");
  }
  if (value.kind === "section") {
    if (
      Object.keys(value).length !== 2 ||
      !(
        nonBlank(value.heading) ||
        (Array.isArray(value.heading) &&
          value.heading.length > 0 &&
          value.heading.every(nonBlank))
      )
    ) {
      throw invalidSelector("章节选择必须提供非空标题或完整标题路径。");
    }
    return;
  }
  if (value.kind === "node") {
    if (
      Object.keys(value).length !== 2 ||
      !isRecord(value.selector) ||
      !hasOnlyKeys(value.selector, ["type", "contains", "language", "url"])
    ) {
      throw invalidSelector("Markdown 节点选择结构无效或包含未声明字段。");
    }
    validateNodeSelector(value.selector as unknown as MarkdownNodeSelection);
    return;
  }
  if (value.kind === "tableCell") {
    if (
      Object.keys(value).length === 2 &&
      isRecord(value.selector) &&
      hasOnlyKeys(value.selector, ["column", "row"]) &&
      isRecord(value.selector.row) &&
      hasOnlyKeys(value.selector.row, ["column", "value"]) &&
      nonBlank(value.selector.column) &&
      nonBlank(value.selector.row.column) &&
      nonBlank(value.selector.row.value)
    ) {
      return;
    }
    throw invalidSelector("表格单元格选择必须提供目标列及有效行键。");
  }
  if (value.kind === "quote") {
    if (Object.keys(value).length === 2 && typeof value.text === "string") {
      return;
    }
    throw invalidSelector("原文引用步骤必须提供文本且不能有额外字段。");
  }
  if (value.kind === "match") {
    if (
      (Object.keys(value).length === 2 || Object.keys(value).length === 3) &&
      typeof value.pattern === "string" &&
      (value.group === undefined ||
        (typeof value.group === "number" && Number.isInteger(value.group)))
    ) {
      return;
    }
    throw invalidSelector("正则选择步骤的表达式或捕获组无效。");
  }
  if (value.kind === "region") {
    if (Object.keys(value).length === 2 && typeof value.name === "string") {
      return;
    }
    throw invalidSelector("region 选择步骤必须提供名称且不能有额外字段。");
  }
  if (value.kind === "marker") {
    if (
      Object.keys(value).length === 2 &&
      nonBlank(value.id) &&
      !/\s/u.test(value.id)
    ) {
      return;
    }
    throw invalidSelector("标记选择必须提供非空单行 ID 且不能有额外字段。");
  }
  throw invalidSelector("不支持的 Markdown 选择步骤。");
}

function isMarkdownNodeType(value: unknown): value is MarkdownNodeType {
  return (
    value === "paragraph" ||
    value === "listItem" ||
    value === "code" ||
    value === "inlineCode" ||
    value === "link" ||
    value === "table"
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeLabel(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function one<T>(matches: readonly T[], label: string): T {
  if (matches.length === 0) {
    throw new MarkdownReferenceError("missing-selection", `没有找到${label}。`);
  }
  if (matches.length !== 1) {
    throw new MarkdownReferenceError(
      "ambiguous-selection",
      `${label}匹配到 ${matches.length} 处，请收窄范围。`,
    );
  }
  return matches[0]!;
}

function resolveTarget(target: string, root: string): string {
  if (target.startsWith("file:")) return fileURLToPath(new URL(target));
  return isAbsolute(target) ? target : resolve(root, target);
}

function displayTarget(absolutePath: string, root: string): string {
  const relativePath = relative(root, absolutePath);
  return relativePath === "" ? "." : relativePath;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "markdown-selection-failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidSelector(message: string): MarkdownReferenceError {
  return new MarkdownReferenceError("invalid-selector", message);
}

function invalidMarkdown(message: string): MarkdownReferenceError {
  return new MarkdownReferenceError("invalid-markdown", message);
}
