import { access, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createReference,
  definePlugin,
  type JsonValue,
  type PluginBatchResult,
  type PluginContext,
  type PluginRequest,
  type PluginReadResult,
  type Reference,
  type ReferenceOptions,
  type ReadableReferencePlugin,
} from "@ykdz/dock";

import { selectTextRange, TextSelectionError } from "./text-selection.ts";
import type { TextSelectionStep } from "./text-selection.ts";

export const filePluginId = "@ykdz/dock-reference-file" as const;

export type FileTextSelection = {
  readonly kind: "text";
  readonly steps: TextSelectionStep[];
};

export type FileExistsSelection = { readonly kind: "exists" };

export type FileSelection = FileExistsSelection | FileTextSelection;

export type FileReference<
  Id extends string = string,
  Value extends JsonValue = JsonValue,
  Selection extends JsonValue = FileSelection,
> = Reference<typeof filePluginId, Id, string, Value, Selection>;

export type FileReferenceBuilder = FileTextReferenceBuilder<never> & {
  exists(): FileExistsReferenceBuilder;
};

export type FileReferenceLocation = {
  from(target: string | URL): FileReferenceBuilder;
};

export type FileTextReferenceBuilder<
  Selection extends JsonValue = FileTextSelection,
> = {
  quote(text: string): FileTextReferenceBuilder;
  match(pattern: string, group?: number): FileTextReferenceBuilder;
  region(name: string): FileTextReferenceBuilder;
  reference<Id extends string>(
    id: Id,
    options?: FileReferenceOptions,
  ): FileReference<Id, string, Selection>;
};

export type FileExistsReferenceBuilder = {
  reference<Id extends string>(
    id: Id,
    options?: FileReferenceOptions,
  ): FileReference<Id, true, FileExistsSelection>;
};

export type FileReferenceOptions = Pick<
  ReferenceOptions,
  "note" | "declaredAt"
>;

export type FilePlugin = ReadableReferencePlugin<
  typeof filePluginId,
  FileReference,
  JsonValue
> & {
  from(target: string | URL): FileReferenceBuilder;
  at(moduleUrl: string | URL): FileReferenceLocation;
};

const implementation = definePlugin({
  id: filePluginId,
  validate(reference: FileReference): void {
    try {
      assertFileTarget(reference.target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TypeError(`文件引用 ${reference.id} 的目标无效：${message}`, {
        cause: error,
      });
    }
    try {
      assertFileSelection(reference.selection);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TypeError(
        `文件引用 ${reference.id} 的 selection 无效：${message}`,
        { cause: error },
      );
    }
  },
  fileInfo(reference: FileReference, context: PluginContext): string {
    try {
      assertFileTarget(reference.target);
      return resolveTarget(reference.target, context.root);
    } catch (error) {
      throw new TypeError(
        `文件引用 ${reference.id} 无法说明文件目标：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  },
  async collect(
    request: PluginRequest<FileReference>,
    context: PluginContext,
  ): Promise<PluginBatchResult> {
    return {
      results: await Promise.all(
        request.selectedReferences.map(async (reference) => {
          try {
            const result = await readFileReference(reference, context.root);
            return {
              referenceId: reference.id,
              kind: "value" as const,
              value: result.value,
              ...(result.range === undefined ? {} : { range: result.range }),
            };
          } catch (error) {
            const range =
              error instanceof FileReferenceError ? error.range : undefined;
            return {
              referenceId: reference.id,
              kind: "error" as const,
              error: {
                code: fileReferenceErrorCode(error),
                message: error instanceof Error ? error.message : String(error),
              },
              ...(range === undefined ? {} : { range }),
            };
          }
        }),
      ),
    };
  },
  async read(
    reference: FileReference,
    context: PluginContext,
  ): Promise<PluginReadResult> {
    return await readFileReference(reference, context.root);
  },
});

export const file: FilePlugin = {
  ...implementation,
  from(target: string | URL): FileReferenceBuilder {
    assertFileTarget(target);
    const normalizedTarget = target instanceof URL ? target.href : target;
    return createFileBuilder(normalizedTarget);
  },
  at(moduleUrl: string | URL): FileReferenceLocation {
    const source = assertFileModuleUrl(moduleUrl);
    return {
      from(target: string | URL): FileReferenceBuilder {
        assertFileTarget(target);
        return createFileBuilder(bindFileTarget(target, source));
      },
    };
  },
};

function bindFileTarget(target: string | URL, source: URL): string {
  if (target instanceof URL) return target.href;
  if (target.startsWith("file:")) return new URL(target).href;
  return isAbsolute(target) ? target : new URL(target, source).href;
}

function assertFileModuleUrl(value: string | URL): URL {
  let moduleUrl: URL;
  try {
    moduleUrl = value instanceof URL ? value : new URL(value);
    if (moduleUrl.protocol !== "file:") {
      throw new TypeError("文件模块 URL 必须使用 file: 协议。");
    }
    fileURLToPath(moduleUrl);
  } catch (error) {
    throw new TypeError("file.at() 需要有效的 file: 模块 URL。", {
      cause: error,
    });
  }
  return moduleUrl;
}

function createFileBuilder(target: string): FileReferenceBuilder {
  return {
    ...createTextBuilder(target, []),
    exists(): FileExistsReferenceBuilder {
      return {
        reference<Id extends string>(
          id: Id,
          options: FileReferenceOptions = {},
        ): FileReference<Id, true, FileExistsSelection> {
          return createFileReference<Id, true, FileExistsSelection>(
            target,
            id,
            options,
            {
              kind: "exists",
            },
          );
        },
      };
    },
    reference<Id extends string>(
      id: Id,
      options: FileReferenceOptions = {},
    ): FileReference<Id, string, never> {
      return createFileReference<Id, string, never>(
        target,
        id,
        options,
        undefined,
      );
    },
  };
}

function createTextBuilder(
  target: string,
  steps: readonly TextSelectionStep[],
): FileTextReferenceBuilder {
  const selection = {
    kind: "text",
    steps: [...steps],
  } satisfies FileTextSelection;
  return {
    quote(text: string): FileTextReferenceBuilder {
      return createTextBuilder(target, [...steps, { kind: "quote", text }]);
    },
    match(pattern: string, group?: number): FileTextReferenceBuilder {
      return createTextBuilder(target, [
        ...steps,
        { kind: "match", pattern, ...(group === undefined ? {} : { group }) },
      ]);
    },
    region(name: string): FileTextReferenceBuilder {
      return createTextBuilder(target, [...steps, { kind: "region", name }]);
    },
    reference<Id extends string>(
      id: Id,
      options: FileReferenceOptions = {},
    ): FileReference<Id, string, FileTextSelection> {
      return createFileReference<Id, string, FileTextSelection>(
        target,
        id,
        options,
        selection,
      );
    },
  };
}

function createFileReference<
  Id extends string,
  Value extends JsonValue,
  Selection extends JsonValue,
>(
  target: string,
  id: Id,
  options: FileReferenceOptions,
  selection: Selection | undefined,
): FileReference<Id, Value, Selection> {
  if (Object.hasOwn(options, "selection")) {
    throw new TypeError("普通文件引用的 selection 必须通过公开定位器构造。");
  }
  return createReference<typeof filePluginId, Id, string, Value, Selection>(
    filePluginId,
    id,
    target,
    {
      ...(selection === undefined ? {} : { selection }),
      ...(options.note === undefined ? {} : { note: options.note }),
      ...(options.declaredAt === undefined
        ? {}
        : { declaredAt: options.declaredAt }),
    },
  );
}

class FileReferenceError extends Error {
  readonly code: string;
  readonly range: PluginReadResult["range"];

  constructor(
    code: string,
    message: string,
    range?: PluginReadResult["range"],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FileReferenceError";
    this.code = code;
    this.range = range;
  }
}

async function readFileReference(
  reference: FileReference,
  root: string,
): Promise<PluginReadResult> {
  let absolutePath: string;
  try {
    assertFileTarget(reference.target);
    absolutePath = resolveTarget(reference.target, root);
  } catch (error) {
    throw new FileReferenceError(
      "invalid-file-target",
      error instanceof Error ? error.message : String(error),
      undefined,
      { cause: error },
    );
  }

  let selection: FileSelection | undefined;
  try {
    selection = decodeFileSelection(reference.selection);
  } catch (error) {
    throw new FileReferenceError(
      "invalid-file-selection",
      `文件引用 ${reference.id} 的 selection 无效：${error instanceof Error ? error.message : String(error)}`,
      undefined,
      { cause: error },
    );
  }

  const path = displayTarget(absolutePath, root);
  if (selection?.kind === "exists") {
    try {
      await access(absolutePath);
      return { value: true };
    } catch (error) {
      const code = hasCode(error, "ENOENT")
        ? "missing-file"
        : "file-read-failed";
      throw new FileReferenceError(
        code,
        `无法读取文件 ${path}：${error instanceof Error ? error.message : String(error)}`,
        undefined,
        { cause: error },
      );
    }
  }

  let text: string;
  try {
    text = await readFile(absolutePath, "utf8");
  } catch (error) {
    const code = hasCode(error, "ENOENT") ? "missing-file" : "file-read-failed";
    throw new FileReferenceError(
      code,
      `无法读取文件 ${path}：${error instanceof Error ? error.message : String(error)}`,
      undefined,
      { cause: error },
    );
  }

  let selectedRange = { path, start: 0, end: text.length };
  if (selection?.kind === "text") {
    try {
      for (const step of selection.steps) {
        selectedRange = selectTextRange(text, selectedRange, step);
      }
    } catch (error) {
      const code = isTextSelectionError(error)
        ? error.code
        : "file-selection-failed";
      throw new FileReferenceError(
        code,
        error instanceof Error ? error.message : String(error),
        { path, start: 0, end: text.length },
        { cause: error },
      );
    }
  }

  return {
    value: text.slice(selectedRange.start, selectedRange.end),
    range: selectedRange,
  };
}

function fileReferenceErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "file-selection-failed";
}

function assertFileTarget(target: unknown): asserts target is string | URL {
  if (typeof target === "string") {
    if (target.length === 0 || target.includes("\0")) {
      throw new TypeError("普通文件引用目标必须是非空、有效的路径文本。");
    }
    if (!target.startsWith("file:")) return;
    try {
      fileURLToPath(new URL(target));
      return;
    } catch {
      throw new TypeError("普通文件引用目标必须是有效 file: URL。");
    }
  }
  if (!(target instanceof URL) || target.protocol !== "file:") {
    throw new TypeError("普通文件引用目标必须是非空路径文本或 file: URL。");
  }
  try {
    fileURLToPath(target);
  } catch {
    throw new TypeError("普通文件引用目标必须是有效 file: URL。");
  }
}

function assertFileSelection(value: JsonValue | undefined): void {
  if (value === undefined) return;
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value.kind === "exists" &&
    Object.keys(value).length === 1
  ) {
    return;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value.kind === "text" &&
    Object.keys(value).length === 2 &&
    Array.isArray(value.steps) &&
    value.steps.length > 0 &&
    value.steps.every(isTextSelectionStep)
  ) {
    return;
  }
  throw new TypeError("普通文件 selection 必须是合法的文本或存在性选择。");
}

function decodeFileSelection(
  value: JsonValue | undefined,
): FileSelection | undefined {
  assertFileSelection(value);
  return value === undefined ? undefined : (value as FileSelection);
}

function isTextSelectionStep(
  value: JsonValue,
): value is JsonValue & TextSelectionStep {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  if (value.kind === "quote") {
    return typeof value.text === "string" && Object.keys(value).length === 2;
  }
  if (value.kind === "match") {
    return (
      typeof value.pattern === "string" &&
      (value.group === undefined || typeof value.group === "number") &&
      Object.keys(value).length === (value.group === undefined ? 2 : 3)
    );
  }
  if (value.kind === "region") {
    return typeof value.name === "string" && Object.keys(value).length === 2;
  }
  return false;
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

function isTextSelectionError(error: unknown): error is TextSelectionError {
  return error instanceof TextSelectionError;
}

export { selectTextRange, TextSelectionError } from "./text-selection.ts";
export type { TextSelectionStep } from "./text-selection.ts";
