import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Baseline,
  BindingDefinition,
  ReferenceDefinition,
} from "@dock/core";

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

/** Normalizes plugin-reported file locations and scope filter paths to absolute paths under the effective root. */
export function normalizeFilePath(value: string | URL, root: string): string {
  if (value instanceof URL) {
    if (value.protocol !== "file:") {
      throw new TypeError("File target URL must use the file: protocol.");
    }
    return resolve(fileURLToPath(value));
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(
      "File target must be a non-empty path string or file: URL.",
    );
  }
  if (value.startsWith("file:")) {
    return resolve(fileURLToPath(new URL(value)));
  }
  return resolve(root, value);
}

/** Resolves current and historical baseline scope selectors after full declarations and plugin preflight finish. */
export function resolveScope(
  input: unknown,
  config: ScopeInput,
): ScopeSelection {
  const selectors = snapshotScope(input);
  const hasSelectors =
    selectors.binding.length > 0 ||
    selectors.reference.length > 0 ||
    selectors.file.length > 0;
  if (!hasSelectors) {
    const boundReferenceIds = new Set(
      config.bindings.flatMap((binding) => binding.references),
    );
    return {
      references: config.references.filter((reference) =>
        boundReferenceIds.has(reference.id),
      ),
    };
  }

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
          `File info for reference ${reference.id} was not normalized.`,
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
    throw invalidScope("Scope filter must be an object.");
  }
  const selectors = input;
  const known = new Set(["binding", "reference", "file"]);
  for (const key of Object.keys(selectors)) {
    if (!known.has(key)) throw invalidScope(`Unsupported scope filter ${key}.`);
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
    throw invalidScope(`Scope filter ${name} must be a list of strings.`);
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      throw invalidScope(
        `Each item in scope filter ${name} must be a non-empty string.`,
      );
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
      `Invalid scope file ${file}: ${errorMessage(error)}`,
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
    throw historyUnexplainable(
      definition.id,
      "Historical definition is missing host plugin identity wrapper.",
    );
  }
  if (!Object.hasOwn(target, "target")) {
    throw historyUnexplainable(
      definition.id,
      "Historical definition is missing plugin target.",
    );
  }
  if (!Object.hasOwn(target, "fileInfo")) {
    throw historyUnexplainable(
      definition.id,
      "Historical definition is missing file target snapshot or no-file marker.",
    );
  }
  const fileInfo = target.fileInfo;
  if (fileInfo === null) return null;
  if (typeof fileInfo !== "string" || fileInfo.length === 0) {
    throw historyUnexplainable(
      definition.id,
      "Historical definition is missing a valid creation-time file target snapshot.",
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
    `Scope selector ${kind} matched no current or historical bindings: ${value}`,
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
    `Cannot resolve file location for historical reference ${referenceId}: ${message}`,
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
