import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createReference,
  definePlugin,
  type JsonValue,
  type PluginBatchResult,
  type PluginContext,
  type PluginReadResult,
  type PluginReferenceResult,
  type PluginRequest,
  type Reference,
  type ReferenceOptions,
  type ReadableReferencePlugin,
  type TextRange,
} from "@ykdz/dock";
import { selectTextRange } from "@ykdz/dock-reference-file";
import type { TextSelectionStep } from "@ykdz/dock-reference-file";
import * as ts from "typescript";

export const typescriptPluginId = "@ykdz/dock-reference-typescript" as const;

export type TypeScriptDeclarationKind =
  | "function"
  | "interface"
  | "class"
  | "variable"
  | "type"
  | "method"
  | "property";

export type TypeScriptSymbolStep = {
  readonly kind: "symbol";
  readonly name: string[];
  readonly declaration?: TypeScriptDeclarationKind;
};

export type TypeScriptSelectionStep = TypeScriptSymbolStep | TextSelectionStep;

export type TypeScriptSelection = {
  readonly kind: "typescript";
  readonly steps: [TypeScriptSymbolStep, ...TextSelectionStep[]];
};

export type TypeScriptReference<
  Id extends string = string,
  Selection extends JsonValue = TypeScriptSelection,
> = Reference<typeof typescriptPluginId, Id, string, string, Selection>;

export type TypeScriptTextReferenceBuilder = {
  quote(text: string): TypeScriptTextReferenceBuilder;
  match(pattern: string, group?: number): TypeScriptTextReferenceBuilder;
  region(name: string): TypeScriptTextReferenceBuilder;
  reference<Id extends string>(
    id: Id,
    options?: Pick<ReferenceOptions, "note" | "declaredAt">,
  ): TypeScriptReference<Id>;
};

export type TypeScriptReferenceBuilder = {
  symbol(
    name: string | readonly [string, ...string[]],
    declaration?: TypeScriptDeclarationKind,
  ): TypeScriptTextReferenceBuilder;
};

export type TypeScriptPlugin = ReadableReferencePlugin<
  typeof typescriptPluginId,
  TypeScriptReference,
  string
> & {
  from(target: string | URL): TypeScriptReferenceBuilder;
};

class TypeScriptReferenceError extends Error {
  readonly code: string;
  readonly range: TextRange | undefined;

  constructor(
    code: string,
    message: string,
    range?: TextRange,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TypeScriptReferenceError";
    this.code = code;
    this.range = range;
  }
}

const implementation = definePlugin({
  id: typescriptPluginId,
  validate(reference: TypeScriptReference): void {
    try {
      assertTarget(reference.target);
    } catch (error) {
      throw new TypeScriptReferenceError(
        "invalid-typescript-target",
        errorMessage(error),
        undefined,
        { cause: error },
      );
    }
    try {
      assertSelection(reference.selection);
    } catch (error) {
      throw new TypeScriptReferenceError(
        "invalid-typescript-selection",
        errorMessage(error),
        undefined,
        { cause: error },
      );
    }
  },
  fileInfo(reference: TypeScriptReference, context: PluginContext): string {
    return resolveTarget(reference.target, context.root);
  },
  async collect(
    request: PluginRequest<TypeScriptReference>,
    context: PluginContext,
  ): Promise<PluginBatchResult<string>> {
    const results: PluginReferenceResult<string>[] = [];
    for (const reference of request.selectedReferences) {
      try {
        const result = await readTypeScriptReference(reference, context.root);
        results.push({
          referenceId: reference.id,
          kind: "value",
          value: result.value,
          ...(result.range === undefined ? {} : { range: result.range }),
        });
      } catch (error) {
        const range =
          error instanceof TypeScriptReferenceError ? error.range : undefined;
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
    reference: TypeScriptReference,
    context: PluginContext,
  ): Promise<PluginReadResult<string>> {
    return await readTypeScriptReference(reference, context.root);
  },
});

export const typescript: TypeScriptPlugin = {
  ...implementation,
  from(target: string | URL): TypeScriptReferenceBuilder {
    const normalizedTarget = normalizeTarget(target);
    assertTypeScriptFile(normalizedTarget);
    return {
      symbol(
        name: string | readonly [string, ...string[]],
        declaration?: TypeScriptDeclarationKind,
      ): TypeScriptTextReferenceBuilder {
        const path = typeof name === "string" ? [name] : [...name];
        if (
          path.length === 0 ||
          path.some((part) => typeof part !== "string" || part.length === 0)
        ) {
          throw new TypeError("TypeScript 符号路径必须包含非空名称。");
        }
        if (declaration !== undefined && !isDeclarationKind(declaration)) {
          throw new TypeError("TypeScript 声明种类无效。");
        }
        const step: TypeScriptSymbolStep = {
          kind: "symbol",
          name: path,
          ...(declaration === undefined ? {} : { declaration }),
        };
        return createTextBuilder(normalizedTarget, [step]);
      },
    };
  },
};

function createTextBuilder(
  target: string,
  steps: readonly TypeScriptSelectionStep[],
): TypeScriptTextReferenceBuilder {
  return {
    quote(text: string): TypeScriptTextReferenceBuilder {
      return createTextBuilder(target, [...steps, { kind: "quote", text }]);
    },
    match(pattern: string, group?: number): TypeScriptTextReferenceBuilder {
      return createTextBuilder(target, [
        ...steps,
        { kind: "match", pattern, ...(group === undefined ? {} : { group }) },
      ]);
    },
    region(name: string): TypeScriptTextReferenceBuilder {
      return createTextBuilder(target, [...steps, { kind: "region", name }]);
    },
    reference<Id extends string>(
      id: Id,
      options: Pick<ReferenceOptions, "note" | "declaredAt"> = {},
    ): TypeScriptReference<Id> {
      const selection: TypeScriptSelection = {
        kind: "typescript",
        steps: steps as [TypeScriptSymbolStep, ...TextSelectionStep[]],
      };
      return createReference<
        typeof typescriptPluginId,
        Id,
        string,
        string,
        TypeScriptSelection
      >(typescriptPluginId, id, target, {
        selection,
        ...options,
      });
    },
  };
}

async function readTypeScriptReference(
  reference: TypeScriptReference,
  root: string,
): Promise<PluginReadResult<string>> {
  let absolutePath: string;
  try {
    assertTarget(reference.target);
    absolutePath = resolveTarget(reference.target, root);
    assertTypeScriptFile(absolutePath);
  } catch (error) {
    throw new TypeScriptReferenceError(
      "invalid-typescript-target",
      errorMessage(error),
      undefined,
      { cause: error },
    );
  }

  let sourceText: string;
  try {
    sourceText = await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new TypeScriptReferenceError(
      "typescript-file-read-failed",
      `无法读取 TypeScript 文件 ${displayTarget(absolutePath, root)}：${errorMessage(error)}`,
      undefined,
      { cause: error },
    );
  }

  let selection: TypeScriptSelection;
  try {
    assertSelection(reference.selection);
    selection = reference.selection;
  } catch (error) {
    throw new TypeScriptReferenceError(
      "invalid-typescript-selection",
      errorMessage(error),
      undefined,
      { cause: error },
    );
  }

  const path = displayTarget(absolutePath, root);
  const sourceFile = parseSource(sourceText, absolutePath, path);
  let range = {
    path,
    start: 0,
    end: sourceText.length,
  } satisfies TextRange;
  range = locateSymbol(sourceFile, selection.steps[0], path);
  try {
    for (const step of selection.steps.slice(1)) {
      if (step.kind === "symbol") {
        throw new TypeError("TypeScript selection 只能包含一个符号步骤。");
      }
      range = selectTextRange(sourceText, range, step);
    }
  } catch (error) {
    throw new TypeScriptReferenceError(
      errorCode(error),
      errorMessage(error),
      range,
      { cause: error },
    );
  }

  return { value: sourceText.slice(range.start, range.end), range };
}

function locateSymbol(
  sourceFile: ts.SourceFile,
  step: TypeScriptSymbolStep,
  path: string,
): TextRange {
  const candidates: ts.Node[] = [];
  const visit = (node: ts.Node, parents: readonly string[]): void => {
    if (isUnsupportedScope(node)) return;

    const kind = declarationKind(node);
    const name = declarationName(node);
    if (
      (kind !== undefined || ts.isModuleDeclaration(node)) &&
      name === undefined
    ) {
      return;
    }

    const names = name === undefined ? parents : [...parents, name];
    if (
      kind !== undefined &&
      names.length === step.name.length &&
      names.every((part, index) => part === step.name[index]) &&
      (step.declaration === undefined || step.declaration === kind)
    ) {
      candidates.push(node);
    }

    ts.forEachChild(node, (child) => visit(child, names));
  };

  visit(sourceFile, []);
  if (candidates.length === 0) {
    throw new TypeScriptReferenceError(
      "missing-symbol",
      `找不到声明 ${step.name.join(".")}${formatDeclaration(step.declaration)}。`,
    );
  }
  if (candidates.length > 1) {
    throw new TypeScriptReferenceError(
      "ambiguous-symbol",
      `声明 ${step.name.join(".")}${formatDeclaration(step.declaration)}不唯一。`,
    );
  }

  const selected = candidates[0]!;
  return {
    path,
    start: selected.getStart(sourceFile),
    end: selected.getEnd(),
  };
}

function parseSource(
  sourceText: string,
  fileName: string,
  displayPath: string,
): ts.SourceFile {
  const extension = extname(fileName).toLowerCase();
  const scriptKind =
    extension === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === fileName ? sourceFile : undefined),
    getDefaultLibFileName: () => "/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? sourceText : undefined),
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram(
    [fileName],
    {
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
      noLib: true,
      noResolve: true,
    },
    host,
  );
  const diagnostic = program.getSyntacticDiagnostics(sourceFile)[0];
  if (diagnostic !== undefined) {
    const position =
      diagnostic.start === undefined
        ? undefined
        : sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
    const location =
      position === undefined
        ? ""
        : `（${position.line + 1}:${position.character + 1}）`;
    throw new TypeScriptReferenceError(
      "typescript-syntax-error",
      `${displayPath}${location}：${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
    );
  }
  return sourceFile;
}

function declarationKind(node: ts.Node): TypeScriptDeclarationKind | undefined {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isVariableDeclaration(node)) return "variable";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
    return "method";
  }
  if (
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return "property";
  }
  return undefined;
}

function declarationName(node: ts.Node): string | undefined {
  if (declarationKind(node) === undefined && !ts.isModuleDeclaration(node)) {
    return undefined;
  }
  const name = (node as ts.NamedDeclaration).name;
  if (
    name !== undefined &&
    (ts.isIdentifier(name) ||
      ts.isPrivateIdentifier(name) ||
      ts.isStringLiteral(name) ||
      ts.isNumericLiteral(name))
  ) {
    return name.text;
  }
  return undefined;
}

function hasNamedObjectOwner(node: ts.ObjectLiteralExpression): boolean {
  let value: ts.Node = node;
  let owner = value.parent;
  while (
    owner !== undefined &&
    (ts.isParenthesizedExpression(owner) ||
      ts.isAsExpression(owner) ||
      ts.isSatisfiesExpression(owner) ||
      ts.isTypeAssertionExpression(owner) ||
      ts.isNonNullExpression(owner)) &&
    owner.expression === value
  ) {
    value = owner;
    owner = owner.parent;
  }
  return Boolean(
    owner !== undefined &&
    (ts.isVariableDeclaration(owner) ||
      ts.isPropertyDeclaration(owner) ||
      ts.isPropertyAssignment(owner)) &&
    owner.initializer === value &&
    declarationName(owner) !== undefined,
  );
}

function isUnsupportedScope(node: ts.Node): boolean {
  if (
    ts.isFunctionExpression(node) ||
    ts.isClassExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isParameter(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isClassStaticBlockDeclaration(node) ||
    ts.isCallSignatureDeclaration(node) ||
    ts.isConstructSignatureDeclaration(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isCatchClause(node)
  ) {
    return true;
  }
  if (ts.isObjectLiteralExpression(node)) return !hasNamedObjectOwner(node);
  if (ts.isBlock(node)) {
    const parent = node.parent;
    return !(
      parent !== undefined &&
      (ts.isFunctionDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent))
    );
  }
  return false;
}

function assertTarget(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError("TypeScript 引用目标必须是非空路径或 file: URL。");
  }
  if (!value.startsWith("file:")) return;
  try {
    fileURLToPath(new URL(value));
  } catch (error) {
    throw new TypeError("TypeScript 引用目标必须是有效 file: URL。", {
      cause: error,
    });
  }
}

function normalizeTarget(value: string | URL): string {
  const target = value instanceof URL ? value.href : value;
  assertTarget(target);
  return target;
}

function assertTypeScriptFile(path: string): void {
  const extension = extname(path).toLowerCase();
  if (![".ts", ".tsx", ".mts", ".cts"].includes(extension)) {
    throw new TypeError(
      "TypeScript 符号定位只支持 .ts、.tsx、.mts 和 .cts 文件。",
    );
  }
}

function assertSelection(
  value: JsonValue | undefined,
): asserts value is TypeScriptSelection {
  if (
    !isRecord(value) ||
    value.kind !== "typescript" ||
    !Array.isArray(value.steps) ||
    value.steps.length === 0 ||
    !isSymbolStep(value.steps[0]) ||
    !value.steps.slice(1).every(isTextSelectionStep)
  ) {
    throw new TypeError(
      "TypeScript selection 必须以符号步骤开始，并接普通文本步骤。",
    );
  }
}

function isSymbolStep(value: unknown): value is TypeScriptSymbolStep {
  if (
    !isRecord(value) ||
    value.kind !== "symbol" ||
    !Array.isArray(value.name) ||
    value.name.length === 0 ||
    !value.name.every((part) => typeof part === "string" && part.length > 0) ||
    (value.declaration !== undefined && !isDeclarationKind(value.declaration))
  ) {
    return false;
  }
  return Object.keys(value).every((key) =>
    ["kind", "name", "declaration"].includes(key),
  );
}

function isTextSelectionStep(value: unknown): value is TextSelectionStep {
  if (!isRecord(value)) return false;
  if (value.kind === "quote") {
    return (
      typeof value.text === "string" &&
      Object.keys(value).every((key) => ["kind", "text"].includes(key))
    );
  }
  if (value.kind === "match") {
    return (
      typeof value.pattern === "string" &&
      (value.group === undefined || typeof value.group === "number") &&
      Object.keys(value).every((key) =>
        ["kind", "pattern", "group"].includes(key),
      )
    );
  }
  if (value.kind === "region") {
    return (
      typeof value.name === "string" &&
      Object.keys(value).every((key) => ["kind", "name"].includes(key))
    );
  }
  return false;
}

function isDeclarationKind(value: unknown): value is TypeScriptDeclarationKind {
  return (
    typeof value === "string" &&
    [
      "function",
      "interface",
      "class",
      "variable",
      "type",
      "method",
      "property",
    ].includes(value)
  );
}

function resolveTarget(target: string, root: string): string {
  if (target.startsWith("file:")) return fileURLToPath(new URL(target));
  return isAbsolute(target) ? target : resolve(root, target);
}

function displayTarget(absolutePath: string, root: string): string {
  const target = relative(root, absolutePath);
  return target.length === 0 ? "." : target;
}

function formatDeclaration(
  declaration: TypeScriptDeclarationKind | undefined,
): string {
  return declaration === undefined ? "" : `（${declaration}）`;
}

function errorCode(error: unknown): string {
  if (error instanceof TypeScriptReferenceError) return error.code;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "typescript-reference-failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { TextSelectionStep } from "@ykdz/dock-reference-file";
