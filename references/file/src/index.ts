import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createReference,
  definePlugin,
  type PluginResult,
  type Reference,
  type ReferenceOptions,
  type ReferencePlugin,
} from "@dock/sdk";

export const filePluginId = "@dock/reference-file" as const;

export type FileReference = Reference<
  typeof filePluginId,
  string,
  string,
  string
>;

export type FileReferenceBuilder = {
  reference<Id extends string>(
    id: Id,
    options?: FileReferenceOptions,
  ): Reference<typeof filePluginId, Id, string, string>;
};

export type FileReferenceOptions = Pick<
  ReferenceOptions,
  "note" | "declaredAt"
>;

export type FilePlugin = ReferencePlugin<
  typeof filePluginId,
  FileReference,
  string
> & {
  from(target: string | URL): FileReferenceBuilder;
};

const implementation = definePlugin<typeof filePluginId, FileReference, string>(
  {
    id: filePluginId,
    validate(reference): void {
      if (reference.selection !== undefined) {
        throw new TypeError(
          `文件引用 ${reference.id} 当前只支持全文，不能传入 selection。`,
        );
      }
      try {
        assertFileTarget(reference.target);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new TypeError(`文件引用 ${reference.id} 的目标无效：${message}`, {
          cause: error,
        });
      }
    },
    async collect(reference, context): Promise<PluginResult<string>> {
      if (reference.selection !== undefined) {
        return {
          kind: "error",
          error: {
            code: "unsupported-file-selection",
            message: `文件引用 ${reference.id} 当前只支持全文。`,
          },
        };
      }
      const target = reference.target;
      if (typeof target !== "string") {
        return {
          kind: "error",
          error: {
            code: "invalid-file-target",
            message: `文件引用 ${reference.id} 的目标必须是路径文本或 file: URL。`,
          },
        };
      }
      let absolutePath: string;
      try {
        absolutePath = resolveTarget(target, context.root);
      } catch (error) {
        return {
          kind: "error",
          error: {
            code: "invalid-file-target",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }

      try {
        const text = await readFile(absolutePath, "utf8");
        const displayPath = relative(context.root, absolutePath);
        return {
          kind: "value",
          value: text,
          range: {
            path: displayPath === "" ? "." : displayPath,
            start: 0,
            end: text.length,
          },
        };
      } catch (error) {
        const code = hasCode(error, "ENOENT")
          ? "missing-file"
          : "file-read-failed";
        const message = error instanceof Error ? error.message : String(error);
        return {
          kind: "error",
          error: {
            code,
            message: `无法读取文件 ${displayTarget(absolutePath, context.root)}：${message}`,
          },
          range: {
            path: displayTarget(absolutePath, context.root),
            start: 0,
            end: 0,
          },
        };
      }
    },
  },
);

export const file: FilePlugin = {
  ...implementation,
  from(target: string | URL): FileReferenceBuilder {
    assertFileTarget(target);
    const normalizedTarget = target instanceof URL ? target.href : target;
    return {
      reference<Id extends string>(
        id: Id,
        options: FileReferenceOptions = {},
      ): Reference<typeof filePluginId, Id, string, string> {
        if (Object.hasOwn(options, "selection")) {
          throw new TypeError(
            "普通文件引用当前只支持全文，不能传入 selection。",
          );
        }
        return createReference<typeof filePluginId, Id, string, string>(
          filePluginId,
          id,
          normalizedTarget,
          {
            ...(options.note === undefined ? {} : { note: options.note }),
            ...(options.declaredAt === undefined
              ? {}
              : { declaredAt: options.declaredAt }),
          },
        );
      },
    };
  },
};

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
