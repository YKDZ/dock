import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Baseline,
  BindingDefinition,
  ReferenceDefinition,
} from "@ykdz/dock-core";

import type { NormalizedReference } from "./authoring.ts";

export type MaintenanceScope = {
  readonly binding?: readonly string[];
  readonly reference?: readonly string[];
  readonly file?: readonly string[];
};

export type ScopeSelection = {
  readonly bindingIds?: readonly string[];
  readonly references: readonly NormalizedReference[];
};

type ScopeInput = {
  readonly root: string;
  readonly baselineDirectory: string;
  readonly references: readonly NormalizedReference[];
  readonly bindings: readonly BindingDefinition[];
  readonly baseline: Baseline | undefined;
  readonly fileInfo: ReadonlyMap<string, string | null>;
};

export class ScopeResolutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ScopeResolutionError";
    this.code = code;
  }
}

/** 将插件公开的文件位置与筛选路径按有效 root 归一成绝对路径。 */
export function normalizeFilePath(value: string | URL, root: string): string {
  if (value instanceof URL) {
    if (value.protocol !== "file:") {
      throw new TypeError("文件目标 URL 必须使用 file: 协议。");
    }
    return resolve(fileURLToPath(value));
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("文件目标必须是非空路径文本或 file: URL。");
  }
  if (value.startsWith("file:")) {
    return resolve(fileURLToPath(new URL(value)));
  }
  return resolve(root, value);
}

/** 完整声明和插件预检完成后解析当前及基线历史筛选项。 */
export function resolveScope(
  input: unknown,
  config: ScopeInput,
): ScopeSelection {
  const selectors = snapshotScope(input);
  const hasSelectors =
    selectors.binding.length > 0 ||
    selectors.reference.length > 0 ||
    selectors.file.length > 0;
  if (!hasSelectors) return { references: config.references };

  const selectedBindings = new Set<string>();
  const currentBindingIds = new Set(
    config.bindings.map((binding) => binding.id),
  );
  const historicalBindings = config.baseline?.bindings ?? {};
  const currentOwners = ownersByReference(config.bindings);
  const historicalOwners = new Map<string, Set<string>>();
  for (const [bindingId, binding] of Object.entries(historicalBindings)) {
    for (const referenceId of binding.definition.references) {
      const owners = historicalOwners.get(referenceId) ?? new Set<string>();
      owners.add(bindingId);
      historicalOwners.set(referenceId, owners);
    }
  }

  for (const bindingId of selectors.binding) {
    if (
      !currentBindingIds.has(bindingId) &&
      !Object.hasOwn(historicalBindings, bindingId)
    ) {
      throw unmatched("binding", bindingId);
    }
    selectedBindings.add(bindingId);
  }

  for (const referenceId of selectors.reference) {
    const current = currentOwners.get(referenceId);
    const historical = historicalOwners.get(referenceId);
    if (current === undefined && historical === undefined) {
      throw unmatched("reference", referenceId);
    }
    for (const bindingId of current ?? []) selectedBindings.add(bindingId);
    for (const bindingId of historical ?? []) selectedBindings.add(bindingId);
  }

  for (const file of selectors.file) {
    const expected = normalizeSelectorFile(file, config.root);
    const matched = new Set<string>();

    for (const reference of config.references) {
      const location = config.fileInfo.get(reference.id);
      if (location === undefined) {
        throw new ScopeResolutionError(
          "scope-file-info-unavailable",
          `引用 ${reference.id} 的文件信息没有完成归一。`,
        );
      }
      if (location !== null && location === expected) {
        for (const bindingId of currentOwners.get(reference.id) ?? []) {
          matched.add(bindingId);
        }
      }
    }

    for (const [bindingId, binding] of Object.entries(historicalBindings)) {
      for (const referenceId of binding.definition.references) {
        const fact = binding.references[referenceId];
        if (fact === undefined) continue;
        const location = historicalFileInfo(
          fact.definition,
          config.baselineDirectory,
        );
        if (location !== null && location === expected) matched.add(bindingId);
      }
    }

    if (matched.size === 0) throw unmatched("file", file);
    for (const bindingId of matched) selectedBindings.add(bindingId);
  }

  const selectedBindingIds = [...selectedBindings].sort(compareText);
  const selectedCurrentBindings = new Set(
    config.bindings
      .filter((binding) => selectedBindings.has(binding.id))
      .flatMap((binding) => binding.references),
  );
  return {
    bindingIds: selectedBindingIds,
    references: config.references.filter((reference) =>
      selectedCurrentBindings.has(reference.id),
    ),
  };
}

export function snapshotScope(input: unknown): {
  readonly binding: readonly string[];
  readonly reference: readonly string[];
  readonly file: readonly string[];
} {
  if (input === undefined) return { binding: [], reference: [], file: [] };
  if (!isRecord(input)) {
    throw invalidScope("范围筛选必须是对象。");
  }
  const selectors = input;
  const known = new Set(["binding", "reference", "file"]);
  for (const key of Object.keys(selectors)) {
    if (!known.has(key)) throw invalidScope(`不支持范围筛选项 ${key}。`);
  }
  return {
    binding: selectorValues(selectors.binding, "binding"),
    reference: selectorValues(selectors.reference, "reference"),
    file: selectorValues(selectors.file, "file"),
  };
}

function selectorValues(value: unknown, name: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw invalidScope(`范围筛选 ${name} 必须是文本列表。`);
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      throw invalidScope(`范围筛选 ${name} 的每项必须是非空文本。`);
    }
    result.push(item);
  }
  return result;
}

function normalizeSelectorFile(file: string, root: string): string {
  try {
    return normalizeFilePath(file, root);
  } catch (error) {
    throw new ScopeResolutionError(
      "scope-invalid",
      `范围文件 ${file} 无效：${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function historicalFileInfo(
  definition: ReferenceDefinition,
  baselineDirectory: string,
): string | null {
  const target = definition.target;
  if (
    !isRecord(target) ||
    typeof target.pluginId !== "string" ||
    target.pluginId.length === 0
  ) {
    throw historyUnexplainable(definition.id, "历史定义没有宿主插件身份包装。");
  }
  if (!Object.hasOwn(target, "target")) {
    throw historyUnexplainable(definition.id, "历史定义没有插件目标。");
  }
  if (!Object.hasOwn(target, "fileInfo")) {
    throw historyUnexplainable(
      definition.id,
      "历史定义没有文件目标快照或无文件标记。",
    );
  }
  const fileInfo = target.fileInfo;
  if (fileInfo === null) return null;
  if (typeof fileInfo !== "string" || fileInfo.length === 0) {
    throw historyUnexplainable(
      definition.id,
      "历史定义没有有效的创建时文件目标快照。",
    );
  }
  return normalizeFilePath(fileInfo, baselineDirectory);
}

function ownersByReference(
  bindings: readonly BindingDefinition[],
): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const binding of bindings) {
    for (const referenceId of binding.references) {
      const current = owners.get(referenceId) ?? new Set<string>();
      current.add(binding.id);
      owners.set(referenceId, current);
    }
  }
  return owners;
}

function unmatched(kind: string, value: string): ScopeResolutionError {
  return new ScopeResolutionError(
    "scope-selector-unmatched",
    `范围筛选 ${kind} 未命中任何当前或历史关联：${value}`,
  );
}

function invalidScope(message: string): ScopeResolutionError {
  return new ScopeResolutionError("scope-invalid", message);
}

function historyUnexplainable(
  referenceId: string,
  message: string,
): ScopeResolutionError {
  return new ScopeResolutionError(
    "scope-history-unexplainable",
    `无法解释历史引用 ${referenceId} 的文件位置：${message}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
