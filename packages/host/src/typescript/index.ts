import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";

import {
  createReference,
  definePlugin,
  type ReferenceOptions,
} from "../authoring.ts";
import type {
  JsonValue,
  PluginBatchResult,
  PluginContext,
  PluginReadResult,
  PluginReferenceResult,
  PluginRequest,
  ReadableReferencePlugin,
  Reference,
  TextRange,
} from "../contracts.ts";
import {
  assertTextSelectionStep,
  selectTextRange,
  type TextSelectionStep,
} from "../file/text-selection.ts";

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
        `Invalid TypeScript target for reference ${reference.id}: ${errorMessage(error)}`,
        undefined,
        { cause: error },
      );
    }
    try {
      assertSelection(reference.selection);
    } catch (error) {
      throw new TypeScriptReferenceError(
        "invalid-typescript-selection",
        `Invalid TypeScript selection for reference ${reference.id}: ${errorMessage(error)}`,
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
    const loader = createBatchSourceLoader();
    const results = await Promise.all(
      request.selectedReferences.map(
        async (reference): Promise<PluginReferenceResult<string>> => {
          try {
            const result = await readTypeScriptReference(
              reference,
              context.root,
              loader,
            );
            return {
              referenceId: reference.id,
              kind: "value",
              value: result.value,
              ...(result.range === undefined ? {} : { range: result.range }),
            };
          } catch (error) {
            const range =
              error instanceof TypeScriptReferenceError
                ? error.range
                : undefined;
            return {
              referenceId: reference.id,
              kind: "error",
              error: { code: errorCode(error), message: errorMessage(error) },
              ...(range === undefined ? {} : { range }),
            };
          }
        },
      ),
    );
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
          throw new TypeError(
            "TypeScript symbol path must contain non-empty names.",
          );
        }
        if (declaration !== undefined && !isDeclarationKind(declaration)) {
          throw new TypeError("Invalid TypeScript declaration kind.");
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
      const step: TextSelectionStep = { kind: "quote", text };
      assertTextSelectionStep(step);
      return createTextBuilder(target, [...steps, step]);
    },
    match(pattern: string, group?: number): TypeScriptTextReferenceBuilder {
      const step: TextSelectionStep = {
        kind: "match",
        pattern,
        ...(group === undefined ? {} : { group }),
      };
      assertTextSelectionStep(step);
      return createTextBuilder(target, [...steps, step]);
    },
    region(name: string): TypeScriptTextReferenceBuilder {
      const step: TextSelectionStep = { kind: "region", name };
      assertTextSelectionStep(step);
      return createTextBuilder(target, [...steps, step]);
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

type SettledResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: TypeScriptReferenceError };

type SourceLoader = {
  readSourceText(absolutePath: string, displayPath: string): Promise<string>;
  parseSourceFile(
    sourceText: string,
    absolutePath: string,
    displayPath: string,
  ): ts.SourceFile;
};

async function readSourceTextUncached(
  absolutePath: string,
  displayPath: string,
): Promise<string> {
  try {
    return await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new TypeScriptReferenceError(
      "typescript-file-read-failed",
      `Cannot read TypeScript file ${displayPath}: ${errorMessage(error)}`,
      undefined,
      { cause: error },
    );
  }
}

function createUncachedSourceLoader(): SourceLoader {
  return {
    readSourceText: readSourceTextUncached,
    parseSourceFile: parseSource,
  };
}

function toTypeScriptReferenceError(error: unknown): TypeScriptReferenceError {
  if (error instanceof TypeScriptReferenceError) return error;
  return new TypeScriptReferenceError(
    errorCode(error),
    errorMessage(error),
    undefined,
    { cause: error },
  );
}

/**
 * Shares file reads, parsed ASTs, and syntax error outcomes by absolute path within
 * a single collect() call while never retaining state across independent checks.
 */
function createBatchSourceLoader(): SourceLoader {
  const sourceTexts = new Map<string, Promise<SettledResult<string>>>();
  const parsedFiles = new Map<string, SettledResult<ts.SourceFile>>();

  return {
    async readSourceText(
      absolutePath: string,
      displayPath: string,
    ): Promise<string> {
      let pending = sourceTexts.get(absolutePath);
      if (pending === undefined) {
        pending = readSourceTextUncached(absolutePath, displayPath).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({
            ok: false as const,
            error: toTypeScriptReferenceError(error),
          }),
        );
        sourceTexts.set(absolutePath, pending);
      }
      const settled = await pending;
      if (!settled.ok) throw settled.error;
      return settled.value;
    },
    parseSourceFile(
      sourceText: string,
      absolutePath: string,
      displayPath: string,
    ): ts.SourceFile {
      let cached = parsedFiles.get(absolutePath);
      if (cached === undefined) {
        try {
          cached = {
            ok: true,
            value: parseSource(sourceText, absolutePath, displayPath),
          };
        } catch (error) {
          cached = {
            ok: false,
            error: toTypeScriptReferenceError(error),
          };
        }
        parsedFiles.set(absolutePath, cached);
      }
      if (!cached.ok) throw cached.error;
      return cached.value;
    },
  };
}

async function readTypeScriptReference(
  reference: TypeScriptReference,
  root: string,
  loader: SourceLoader = createUncachedSourceLoader(),
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

  const path = displayTarget(absolutePath, root);
  const sourceText = await loader.readSourceText(absolutePath, path);

  let selection: TypeScriptSelection;
  try {
    assertSelection(reference.selection);
    selection = reference.selection;
  } catch (error) {
    throw new TypeScriptReferenceError(
      "invalid-typescript-selection",
      `Invalid TypeScript selection for reference ${reference.id}: ${errorMessage(error)}`,
      undefined,
      { cause: error },
    );
  }

  const sourceFile = loader.parseSourceFile(sourceText, absolutePath, path);
  let range = {
    path,
    start: 0,
    end: sourceText.length,
  } satisfies TextRange;
  range = locateSymbol(sourceFile, selection.steps[0], path);
  try {
    for (const step of selection.steps.slice(1)) {
      if (step.kind === "symbol") {
        throw new TypeError(
          "TypeScript selection can contain only one symbol step.",
        );
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
      `Cannot find declaration ${step.name.join(".")}${formatDeclaration(step.declaration)}.`,
    );
  }
  if (candidates.length > 1) {
    throw new TypeScriptReferenceError(
      "ambiguous-symbol",
      `Declaration ${step.name.join(".")}${formatDeclaration(step.declaration)} is not unique.`,
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
        : ` (${position.line + 1}:${position.character + 1})`;
    throw new TypeScriptReferenceError(
      "typescript-syntax-error",
      `${displayPath}${location}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
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
    throw new TypeError(
      "TypeScript reference target must be a non-empty path or file: URL.",
    );
  }
  if (!value.startsWith("file:")) return;
  try {
    fileURLToPath(new URL(value));
  } catch (error) {
    throw new TypeError(
      "TypeScript reference target must be a valid file: URL.",
      {
        cause: error,
      },
    );
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
      "TypeScript symbol selection only supports .ts, .tsx, .mts, and .cts files.",
    );
  }
}

function assertSelection(
  value: JsonValue | undefined,
): asserts value is TypeScriptSelection {
  if (
    !isRecord(value) ||
    value.kind !== "typescript" ||
    Object.keys(value).length !== 2 ||
    !Array.isArray(value.steps) ||
    value.steps.length === 0 ||
    !isSymbolStep(value.steps[0])
  ) {
    throw new TypeError(
      "TypeScript selection must start with a symbol step followed by plain text steps.",
    );
  }
  for (const step of value.steps.slice(1)) {
    assertTextSelectionStep(step);
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
  return declaration === undefined ? "" : ` (${declaration})`;
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

export type { TextSelectionStep } from "../file/text-selection.ts";
