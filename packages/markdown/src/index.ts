import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeLineRange,
  createReference,
  definePlugin,
  recordLineRange,
  type DeclarationSource,
  type JsonValue,
  type PluginBatchResult,
  type PluginContext,
  type PluginDeclarationSource,
  type PluginDiscoveryInput,
  type PluginDiscoveryIssue,
  type PluginDiscoveryResult,
  type PluginReadResult,
  type PluginReferenceResult,
  type PluginRequest,
  type ReadableReferencePlugin,
  type Reference,
  type ReferenceOptions,
  type TextRange,
} from "@dock/host";
import {
  assertTextSelectionStep,
  selectTextRange,
  type TextSelectionStep,
} from "@dock/text-selection";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { parseFragment } from "parse5";

export const markdownPluginId = "@ykdz/dock-reference-markdown" as const;

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

export type MarkdownDeclarationSource = PluginDeclarationSource<
  typeof markdownPluginId,
  string
>;

export type MarkdownReferenceBuilder<
  Selection extends JsonValue = MarkdownSelection,
> = {
  section(heading: string | readonly string[]): MarkdownReferenceBuilder;
  node(selector: MarkdownNodeSelection): MarkdownReferenceBuilder;
  tableCell(selector: MarkdownTableCellSelection): MarkdownReferenceBuilder;
  marker(id: string): MarkdownReferenceBuilder;
  quote(text: string): MarkdownReferenceBuilder;
  match(pattern: string, group?: number): MarkdownReferenceBuilder;
  region(name: string): MarkdownReferenceBuilder;
  reference<Id extends string>(
    id: Id,
    options?: MarkdownReferenceOptions,
  ): MarkdownReference<Id, Selection>;
};

export type MarkdownPlugin = ReadableReferencePlugin<
  typeof markdownPluginId,
  MarkdownReference,
  string,
  never,
  MarkdownDeclarationSource
> & {
  from(target: string | URL): MarkdownReferenceBuilder<never>;
  source(
    target: string | URL,
    options?: { readonly declaredAt?: DeclarationSource },
  ): MarkdownDeclarationSource;
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
        `Invalid Markdown reference ${reference.id}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  },
  validateSource(source: MarkdownDeclarationSource): void {
    assertMarkdownTarget(source.target);
  },
  async discover(
    input: PluginDiscoveryInput<MarkdownReference, MarkdownDeclarationSource>,
    context: PluginContext,
  ): Promise<PluginDiscoveryResult> {
    const loadSource = createMarkdownBatchLoader();
    const explicitSourcePaths = new Set<string>();
    const referencedPaths = new Set<string>();
    const missingBaselinePaths = new Set<string>(input.missingBaselineFiles);

    for (const source of input.sources) {
      assertMarkdownTarget(source.target);
      explicitSourcePaths.add(resolveTarget(source.target, context.root));
    }
    for (const reference of input.references) {
      assertMarkdownTarget(reference.target);
      referencedPaths.add(resolveTarget(reference.target, context.root));
    }

    const filesToValidate = new Set<string>([
      ...explicitSourcePaths,
      ...missingBaselinePaths,
    ]);
    const issues: PluginDiscoveryIssue[] = [];
    for (const absolutePath of filesToValidate) {
      const displayPath = displayTarget(absolutePath, context.root);
      let fileState: MarkdownFileState;
      try {
        fileState = await loadSource(absolutePath, displayPath);
      } catch (error) {
        issues.push({
          code: "declaration-source-read-failed",
          message: `Cannot read Markdown declaration source ${displayPath}: ${errorMessage(error)}`,
        });
        continue;
      }

      if (
        explicitSourcePaths.has(absolutePath) &&
        !referencedPaths.has(absolutePath)
      ) {
        const directiveIssues = fileState.directives().issues;
        if (directiveIssues.length > 0) {
          issues.push({
            code: "invalid-marker",
            message: formatDirectiveIssues(displayPath, directiveIssues),
          });
        }
      }
    }

    return { bindings: [], issues };
  },
  fileInfo(reference: MarkdownReference, context: PluginContext): string {
    return resolveTarget(reference.target, context.root);
  },
  async collect(
    request: PluginRequest<MarkdownReference>,
    context: PluginContext,
  ): Promise<PluginBatchResult<string>> {
    const loadSource = createMarkdownBatchLoader();
    const results: PluginReferenceResult<string>[] = [];
    for (const reference of request.selectedReferences) {
      try {
        const result = await readMarkdownReference(
          reference,
          context.root,
          loadSource,
        );
        results.push({
          referenceId: reference.id,
          kind: "value",
          value: result.value,
          ...(result.range === undefined ? {} : { range: result.range }),
        });
      } catch (error) {
        const range =
          error instanceof MarkdownReferenceError ? error.range : undefined;
        results.push({
          referenceId: reference.id,
          kind: "error",
          error: { code: errorCode(error), message: errorMessage(error) },
          ...(range === undefined ? {} : { range }),
        });
      }
    }
    return { results };
  },
  async read(
    reference: MarkdownReference,
    context: PluginContext,
  ): Promise<PluginReadResult<string>> {
    return await readMarkdownReference(
      reference,
      context.root,
      directMarkdownLoader,
    );
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
  source(
    target: string | URL,
    options: { readonly declaredAt?: DeclarationSource } = {},
  ): MarkdownDeclarationSource {
    assertMarkdownTarget(target);
    if (
      typeof options !== "object" ||
      options === null ||
      Array.isArray(options)
    ) {
      throw new TypeError("Markdown source options must be an object.");
    }
    const declaredAtDescriptor = Object.getOwnPropertyDescriptor(
      options,
      "declaredAt",
    );
    if (
      declaredAtDescriptor !== undefined &&
      !("value" in declaredAtDescriptor)
    ) {
      throw new TypeError("Markdown source declaredAt cannot be an accessor.");
    }
    const declaredAt = declaredAtDescriptor?.value as
      | DeclarationSource
      | undefined;
    if (
      declaredAt !== undefined &&
      typeof declaredAt !== "string" &&
      !(declaredAt instanceof URL)
    ) {
      throw new TypeError(
        "Markdown source declaredAt must be a path string or URL.",
      );
    }
    return {
      pluginId: markdownPluginId,
      target: target instanceof URL ? target.href : target,
      ...(declaredAt === undefined ? {} : { declaredAt }),
    };
  },
};

function createBuilder<Selection extends JsonValue>(
  target: string,
  steps: MarkdownSelectionStep[],
): MarkdownReferenceBuilder<Selection> {
  return {
    section(heading): MarkdownReferenceBuilder {
      const normalizedHeading: string | string[] =
        typeof heading === "string" ? heading : Array.from(heading);
      return createBuilder<MarkdownSelection>(target, [
        ...steps,
        { kind: "section", heading: normalizedHeading },
      ]);
    },
    node(selector): MarkdownReferenceBuilder {
      return createBuilder<MarkdownSelection>(target, [
        ...steps,
        { kind: "node", selector },
      ]);
    },
    tableCell(selector): MarkdownReferenceBuilder {
      return createBuilder<MarkdownSelection>(target, [
        ...steps,
        { kind: "tableCell", selector },
      ]);
    },
    marker(id): MarkdownReferenceBuilder {
      return createBuilder<MarkdownSelection>(target, [
        ...steps,
        { kind: "marker", id },
      ]);
    },
    quote(text): MarkdownReferenceBuilder {
      const step: TextSelectionStep = { kind: "quote", text };
      assertTextSelectionStep(step);
      return createBuilder<MarkdownSelection>(target, [...steps, step]);
    },
    match(pattern, group): MarkdownReferenceBuilder {
      const step: TextSelectionStep = {
        kind: "match",
        pattern,
        ...(group === undefined ? {} : { group }),
      };
      assertTextSelectionStep(step);
      return createBuilder<MarkdownSelection>(target, [...steps, step]);
    },
    region(name): MarkdownReferenceBuilder {
      const step: TextSelectionStep = { kind: "region", name };
      assertTextSelectionStep(step);
      return createBuilder<MarkdownSelection>(target, [...steps, step]);
    },
    reference<Id extends string>(
      id: Id,
      options: MarkdownReferenceOptions = {},
    ): MarkdownReference<Id, Selection> {
      if (Object.hasOwn(options, "selection")) {
        throw new TypeError(
          "Markdown selection must be constructed through the public selector.",
        );
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

type CachedOutcome<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: unknown };

type MarkdownFileState = {
  readonly source: string;
  parseRange(start: number, end: number): MarkdownRoot;
  directives(): ScannedDocumentDirectives;
  markers(): readonly DockDirective[];
};

type MarkdownSourceLoader = (
  absolutePath: string,
  displayPath: string,
) => Promise<MarkdownFileState>;

const markerPrefixPattern = /<!--\s*dock:/u;

function createMarkdownFileState(source: string): MarkdownFileState {
  const astByRange = new Map<string, MarkdownRoot>();
  let cachedDirectives: CachedOutcome<ScannedDocumentDirectives> | undefined;

  const parseRange = (start: number, end: number): MarkdownRoot => {
    const key = `${start}:${end}`;
    let root = astByRange.get(key);
    if (root === undefined) {
      root = parseMarkdown(source.slice(start, end));
      astByRange.set(key, root);
    }
    return root;
  };

  const directives = (): ScannedDocumentDirectives => {
    if (cachedDirectives === undefined) {
      try {
        cachedDirectives = {
          ok: true,
          value: scanDocumentDirectives(source, () =>
            parseRange(0, source.length),
          ),
        };
      } catch (error) {
        cachedDirectives = { ok: false, error };
      }
    }
    if (!cachedDirectives.ok) throw cachedDirectives.error;
    return cachedDirectives.value;
  };

  return {
    source,
    parseRange,
    directives,
    markers(): readonly DockDirective[] {
      return directives().markers;
    },
  };
}

// Scoped to one collect() call so multiple references to the same file share reads, AST ranges, and marker scans.
function createMarkdownBatchLoader(): MarkdownSourceLoader {
  const files = new Map<string, Promise<CachedOutcome<MarkdownFileState>>>();

  return async (
    absolutePath: string,
    displayPath: string,
  ): Promise<MarkdownFileState> => {
    let pending = files.get(absolutePath);
    if (pending === undefined) {
      pending = readFile(absolutePath, "utf8").then(
        (source) => ({
          ok: true as const,
          value: createMarkdownFileState(source),
        }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      files.set(absolutePath, pending);
    }
    const outcome = await pending;
    if (outcome.ok) return outcome.value;
    throw toMarkdownReadError(displayPath, outcome.error);
  };
}

const directMarkdownLoader: MarkdownSourceLoader = async (
  absolutePath: string,
  displayPath: string,
): Promise<MarkdownFileState> => {
  try {
    return createMarkdownFileState(await readFile(absolutePath, "utf8"));
  } catch (error) {
    throw toMarkdownReadError(displayPath, error);
  }
};

function toMarkdownReadError(
  displayPath: string,
  error: unknown,
): MarkdownReferenceError {
  const code = hasCode(error, "ENOENT") ? "missing-file" : "file-read-failed";
  return new MarkdownReferenceError(
    code,
    `Cannot read Markdown file ${displayPath}: ${errorMessage(error)}`,
    undefined,
    { cause: error },
  );
}

async function readMarkdownReference(
  reference: MarkdownReference,
  root: string,
  loadSource: MarkdownSourceLoader,
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

  const path = displayTarget(absolutePath, root);
  const fileState = await loadSource(absolutePath, path);

  let current: TextRange = { path, start: 0, end: fileState.source.length };
  let selection: MarkdownSelection | undefined;
  try {
    selection = decodeMarkdownSelection(reference.selection);
  } catch (error) {
    recordLineRange(current, fileState.source);
    throw new MarkdownReferenceError(
      "invalid-selection",
      `Invalid selection for Markdown reference ${reference.id}: ${errorMessage(error)}`,
      current,
      { cause: error },
    );
  }

  if (selection !== undefined) {
    for (const step of selection.steps) {
      try {
        current = selectMarkdownRange(fileState, current, step);
      } catch (error) {
        recordLineRange(current, fileState.source);
        const issues = safeDirectiveIssues(fileState);
        const extraIssues =
          step.kind === "marker"
            ? issues.filter((issue) => issue.markerId !== step.id)
            : issues;
        const message =
          extraIssues.length === 0
            ? errorMessage(error)
            : `${errorMessage(error)}\n${formatDirectiveIssues(path, extraIssues)}`;
        throw new MarkdownReferenceError(errorCode(error), message, current, {
          cause: error,
        });
      }
    }
  }

  const directiveIssues = fileState.directives().issues;
  if (directiveIssues.length > 0) {
    const firstIssue = directiveIssues[0]!;
    const issueRange: TextRange = {
      path,
      start: firstIssue.start,
      end: firstIssue.end,
    };
    recordLineRange(issueRange, fileState.source);
    throw new MarkdownReferenceError(
      "invalid-marker",
      formatDirectiveIssues(path, directiveIssues),
      issueRange,
    );
  }

  recordLineRange(current, fileState.source);
  return { value: markdownFact(fileState, current), range: current };
}

function selectMarkdownRange(
  fileState: MarkdownFileState,
  input: TextRange,
  step: MarkdownSelectionStep,
): TextRange {
  if (step.kind === "marker") {
    return selectMarker(fileState.markers(), input, step.id);
  }
  if (
    step.kind === "quote" ||
    step.kind === "match" ||
    step.kind === "region"
  ) {
    return selectTextRange(fileState.source, input, step);
  }

  const current = fileState.source.slice(input.start, input.end);
  const root = fileState.parseRange(input.start, input.end);
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
      "Unsupported Markdown selection step.",
    );
  }

  return {
    path: input.path,
    start: input.start + offsets.start,
    end: input.start + offsets.end,
  };
}

type DockDirective = {
  readonly kind: "start" | "end";
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly raw: string;
};

type DockDirectiveIssue = {
  readonly code: string;
  readonly start: number;
  readonly end: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly markerId?: string;
  readonly message: (displayPath: string) => string;
};

type ScannedDocumentDirectives = {
  readonly markers: readonly DockDirective[];
  readonly issues: readonly DockDirectiveIssue[];
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

const dockDirectiveCommentPattern = /^<!--\s*dock:/u;

function scanDocumentDirectives(
  source: string,
  getFullDocumentRoot: () => MarkdownRoot,
): ScannedDocumentDirectives {
  // Skip full-document Markdown + HTML fragment scanning when no dock: comment prefix is present.
  if (!markerPrefixPattern.test(source)) {
    return { markers: [], issues: [] };
  }

  const markers: DockDirective[] = [];
  const issues: DockDirectiveIssue[] = [];
  const nodes = allNodes(getFullDocumentRoot());
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

  // Keep HTML fragments identified by Markdown and parse them together to preserve inline <script> raw-text context.
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
      const start = location.startOffset;
      const end = location.endOffset;
      const raw = source.slice(start, end);
      if (dockDirectiveCommentPattern.test(raw)) {
        const parsed = parseDockDirective(source, start, end, raw);
        if (parsed.kind === "issue") {
          issues.push(parsed.issue);
        } else {
          markers.push(parsed.directive);
        }
      }
    }
    html.childNodes?.forEach(visit);
    if (html.content !== undefined) visit(html.content);
  };
  visit(fragment);

  markers.sort((left, right) => left.start - right.start);
  validateMarkerPairing(markers, issues);
  issues.sort((left, right) => left.start - right.start);
  return { markers, issues };
}

function parseDockDirective(
  source: string,
  start: number,
  end: number,
  raw: string,
):
  | { readonly kind: "directive"; readonly directive: DockDirective }
  | { readonly kind: "issue"; readonly issue: DockDirectiveIssue } {
  const { startLine, endLine } = computeLineRange(source, start, end);
  if (!raw.endsWith("-->")) {
    return {
      kind: "issue",
      issue: {
        code: "invalid-marker",
        start,
        end,
        startLine,
        endLine,
        message: (displayPath) =>
          `${displayPath}:${startLine}: Unclosed Dock directive comment (${previewDirective(raw)}): missing closing "-->".`,
      },
    };
  }

  const body = raw.slice(4, -3).trim();
  const headerMatch = /^dock:([^\s{]*)(?:([\s\S]*))?$/u.exec(body);
  const name = headerMatch?.[1] ?? "";
  const rest = (headerMatch?.[2] ?? "").trim();

  if (name.length === 0) {
    return {
      kind: "issue",
      issue: {
        code: "invalid-marker",
        start,
        end,
        startLine,
        endLine,
        message: (displayPath) =>
          `${displayPath}:${startLine}: Empty Dock directive (${previewDirective(raw)}). Expected dock:start or dock:end.`,
      },
    };
  }

  if (name === "start" || name === "end") {
    if (rest.length === 0) {
      return {
        kind: "issue",
        issue: {
          code: "invalid-marker",
          start,
          end,
          startLine,
          endLine,
          message: (displayPath) =>
            `${displayPath}:${startLine}: Invalid Dock directive "dock:${name}" (${previewDirective(raw)}): missing marker ID.`,
        },
      };
    }
    if (/\s/u.test(rest)) {
      return {
        kind: "issue",
        issue: {
          code: "invalid-marker",
          start,
          end,
          startLine,
          endLine,
          message: (displayPath) =>
            `${displayPath}:${startLine}: Invalid Dock directive "dock:${name}" (${previewDirective(raw)}): marker ID must be a single non-empty token without whitespace.`,
        },
      };
    }
    return {
      kind: "directive",
      directive: {
        kind: name,
        id: rest,
        start,
        end,
        startLine,
        endLine,
        raw,
      },
    };
  }

  return {
    kind: "issue",
    issue: {
      code: "invalid-marker",
      start,
      end,
      startLine,
      endLine,
      message: (displayPath) =>
        `${displayPath}:${startLine}: Unknown Dock directive "dock:${name}" (${previewDirective(raw)}). Expected dock:start or dock:end.`,
    },
  };
}

function validateMarkerPairing(
  markers: readonly DockDirective[],
  issues: DockDirectiveIssue[],
): void {
  const byId = new Map<string, DockDirective[]>();
  for (const marker of markers) {
    const group = byId.get(marker.id) ?? [];
    group.push(marker);
    byId.set(marker.id, group);
  }

  for (const [id, group] of byId) {
    const starts = group.filter((marker) => marker.kind === "start");
    const ends = group.filter((marker) => marker.kind === "end");

    if (starts.length > 1) {
      const target = starts[1]!;
      const lineList = starts.map((marker) => marker.startLine).join(", ");
      issues.push({
        code: "invalid-marker",
        start: target.start,
        end: target.end,
        startLine: target.startLine,
        endLine: target.endLine,
        markerId: id,
        message: (displayPath) =>
          `${displayPath}:${target.startLine}: Duplicate start marker for "${id}" (lines ${lineList}): ${target.raw}.`,
      });
    }

    if (ends.length > 1) {
      const target = ends[1]!;
      const lineList = ends.map((marker) => marker.startLine).join(", ");
      issues.push({
        code: "invalid-marker",
        start: target.start,
        end: target.end,
        startLine: target.startLine,
        endLine: target.endLine,
        markerId: id,
        message: (displayPath) =>
          `${displayPath}:${target.startLine}: Duplicate end marker for "${id}" (lines ${lineList}): ${target.raw}.`,
      });
    }

    if (starts.length >= 1 && ends.length === 0) {
      const opening = starts[0]!;
      issues.push({
        code: "invalid-marker",
        start: opening.start,
        end: opening.end,
        startLine: opening.startLine,
        endLine: opening.endLine,
        markerId: id,
        message: (displayPath) =>
          `${displayPath}:${opening.startLine}: Unclosed start marker ${opening.raw}: missing matching <!-- dock:end ${id} -->.`,
      });
    }

    if (starts.length === 0 && ends.length >= 1) {
      const closing = ends[0]!;
      issues.push({
        code: "invalid-marker",
        start: closing.start,
        end: closing.end,
        startLine: closing.startLine,
        endLine: closing.endLine,
        markerId: id,
        message: (displayPath) =>
          `${displayPath}:${closing.startLine}: Orphan end marker ${closing.raw}: missing matching <!-- dock:start ${id} -->.`,
      });
    }

    if (
      starts.length === 1 &&
      ends.length === 1 &&
      starts[0]!.end > ends[0]!.start
    ) {
      const opening = starts[0]!;
      const closing = ends[0]!;
      issues.push({
        code: "invalid-marker",
        start: closing.start,
        end: closing.end,
        startLine: closing.startLine,
        endLine: closing.endLine,
        markerId: id,
        message: (displayPath) =>
          `${displayPath}:${closing.startLine}: Reversed markers for "${id}": ${closing.raw} (line ${closing.startLine}) precedes ${opening.raw} (line ${opening.startLine}).`,
      });
    }
  }
}

function previewDirective(raw: string): string {
  const singleLine = raw.replace(/\s+/gu, " ").trim();
  return singleLine.length <= 80 ? singleLine : `${singleLine.slice(0, 77)}...`;
}

function formatDirectiveIssues(
  displayPath: string,
  issues: readonly DockDirectiveIssue[],
): string {
  if (issues.length === 1) {
    return issues[0]!.message(displayPath);
  }
  return `Invalid Dock directives in ${displayPath}:\n${issues.map((issue) => `  - ${issue.message(displayPath)}`).join("\n")}`;
}

function safeDirectiveIssues(
  fileState: MarkdownFileState,
): readonly DockDirectiveIssue[] {
  try {
    return fileState.directives().issues;
  } catch {
    return [];
  }
}

function markdownFact(fileState: MarkdownFileState, input: TextRange): string {
  const { source } = fileState;
  let result = "";
  let cursor = input.start;
  for (const marker of fileState.markers()) {
    if (marker.end <= input.start || marker.start >= input.end) continue;
    const start = Math.max(input.start, marker.start);
    const end = Math.min(input.end, marker.end);
    result += source.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  return result + source.slice(cursor, input.end);
}

function selectMarker(
  documentMarkers: readonly DockDirective[],
  input: TextRange,
  id: string,
): TextRange {
  if (!nonBlank(id) || /\s/u.test(id)) {
    throw invalidSelector(
      "Marker ID must be a non-empty single-line string without whitespace.",
    );
  }
  const markers = documentMarkers.filter((marker) => marker.id === id);
  const opening = one(
    markers.filter((marker) => marker.kind === "start"),
    `start of marker ${id}`,
  );
  const closing = one(
    markers.filter((marker) => marker.kind === "end"),
    `end of marker ${id}`,
  );
  if (opening.end > closing.start) {
    throw invalidSelector(`End of marker ${id} must follow its start.`);
  }
  if (opening.end < input.start || closing.start > input.end) {
    throw new MarkdownReferenceError(
      "missing-selection",
      `Marker ${id} is outside the current selection range.`,
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
      throw invalidSelector("Heading path must contain non-empty headings.");
    }
  } else if (!nonBlank(heading)) {
    throw invalidSelector("Heading must be non-empty text.");
  }

  const ancestors: { depth: number; name: string }[] = [];
  const headings = root.children
    .filter((node) => node.type === "heading")
    .map((node) => {
      if (node.depth === undefined) {
        throw invalidMarkdown("Markdown heading is missing a depth level.");
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
  const selected = one(matches, "matching heading");
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

  // Trim only blank lines at section boundaries; preserve indentation of the first body line and the rest of the source.
  start +=
    source.slice(start, trimmedEnd).match(/^(?:[ \t]*(?:\r\n|\r|\n))+/u)?.[0]
      .length ?? 0;
  trimmedEnd -=
    source.slice(start, trimmedEnd).match(/(?:(?:\r\n|\r|\n)[ \t]*)+$/u)?.[0]
      .length ?? 0;
  if (source.slice(start, trimmedEnd).trim().length === 0) {
    throw new MarkdownReferenceError(
      "missing-selection",
      "Specified heading has no body content.",
    );
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
  const selected = one(matches, `Markdown ${selector.type} node`);
  return nodeOffsets(source, selected);
}

function validateNodeSelector(selector: MarkdownNodeSelection): void {
  if (typeof selector !== "object" || selector === null) {
    throw invalidSelector("Markdown node selector must be an object.");
  }
  if (!isMarkdownNodeType(selector.type)) {
    throw invalidSelector("Unsupported Markdown node type.");
  }
  if (selector.contains !== undefined && !nonBlank(selector.contains)) {
    throw invalidSelector("Node contains text must be non-empty.");
  }
  if ("language" in selector) {
    if (selector.type !== "code") {
      throw invalidSelector("language can only be used for code blocks.");
    }
    if (!nonBlank(selector.language)) {
      throw invalidSelector("Code language must be non-empty text.");
    }
  }
  if ("url" in selector) {
    if (selector.type !== "link") {
      throw invalidSelector("url can only be used for links.");
    }
    if (!nonBlank(selector.url)) {
      throw invalidSelector("Link url must be non-empty text.");
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
        "Duplicate row key column or target column header in matching table.",
      );
    }
    if (matchingRows.length !== 1) {
      throw new MarkdownReferenceError(
        "ambiguous-selection",
        "Duplicate row key value in matching table.",
      );
    }

    const row = matchingRows[0]!;
    const cell = row.children?.[valueColumns[0]!];
    if (cell === undefined) continue;
    matches.push(tableCellOffsets(source, cell));
  }
  return one(matches, "table cell");
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
    throw invalidSelector(
      "Table cell selector must provide a target column and a valid row key.",
    );
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
    throw invalidMarkdown(
      "Markdown table cell has no corresponding source range.",
    );
  }
  // The AST range of an empty cell includes its surrounding delimiters; inspect only the inner whitespace within that span.
  const span = trimCell(source, firstPipe + 1, lastPipe);
  if (span.start !== span.end) {
    throw invalidMarkdown(
      "Markdown empty cell range contains unexpected content.",
    );
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
    throw invalidMarkdown("Markdown node has no valid source UTF-16 range.");
  }
  return { start, end };
}

function assertMarkdownTarget(target: unknown): asserts target is string | URL {
  if (typeof target === "string") {
    if (target.length === 0 || target.includes("\0")) {
      throw new TypeError(
        "Markdown reference target must be a non-empty valid path string.",
      );
    }
    if (!target.startsWith("file:")) return;
    try {
      fileURLToPath(new URL(target));
      return;
    } catch {
      throw new TypeError(
        "Markdown reference target must be a valid file: URL.",
      );
    }
  }
  if (!(target instanceof URL) || target.protocol !== "file:") {
    throw new TypeError(
      "Markdown reference target must be a path string or file: URL.",
    );
  }
  try {
    fileURLToPath(target);
  } catch {
    throw new TypeError("Markdown reference target must be a valid file: URL.");
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
    throw invalidSelector(
      "Markdown selection must be a valid non-empty step list.",
    );
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
    throw invalidSelector("Markdown selection step must be a valid object.");
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
      throw invalidSelector(
        "Section selection must provide a non-empty heading or full heading path.",
      );
    }
    return;
  }
  if (value.kind === "node") {
    if (
      Object.keys(value).length !== 2 ||
      !isRecord(value.selector) ||
      !hasOnlyKeys(value.selector, ["type", "contains", "language", "url"])
    ) {
      throw invalidSelector(
        "Markdown node selection has an invalid structure or undeclared fields.",
      );
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
    throw invalidSelector(
      "Table cell selection must provide a target column and a valid row key.",
    );
  }
  if (
    value.kind === "quote" ||
    value.kind === "match" ||
    value.kind === "region"
  ) {
    try {
      assertTextSelectionStep(value);
      return;
    } catch (error) {
      throw invalidSelector(errorMessage(error));
    }
  }
  if (value.kind === "marker") {
    if (
      Object.keys(value).length === 2 &&
      nonBlank(value.id) &&
      !/\s/u.test(value.id)
    ) {
      return;
    }
    throw invalidSelector(
      "Marker selection must provide a non-empty single-line ID with no extra fields.",
    );
  }
  throw invalidSelector("Unsupported Markdown selection step.");
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
    throw new MarkdownReferenceError(
      "missing-selection",
      `No matching ${label} found.`,
    );
  }
  if (matches.length !== 1) {
    throw new MarkdownReferenceError(
      "ambiguous-selection",
      `Found ${matches.length} matches for ${label}; narrow the selection.`,
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
