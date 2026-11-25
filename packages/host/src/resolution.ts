import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  BaselineValidationError,
  cstToJsonValue,
  isWellFormedJsonString,
  JsonSyntaxError,
  parseBaselineJson,
  resolveCheckScope,
  type Baseline,
  type BaselineValidationIssue,
  type BindingDefinition,
  type CheckContext,
  type JsonCstNode,
  type JsonPropertyNode,
  type JsonValue,
  type ReferenceDefinition,
} from "@dock/core";

import { normalizeConfig, type NormalizedReference } from "./authoring.ts";
import type {
  Config,
  DeclarationSource,
  PluginInformation,
  PluginRequest,
  ReferencePlugin,
} from "./contracts.ts";
import { MaintenanceError } from "./errors.ts";
import { ownJsonValue, ownPluginInformation } from "./owned-data.ts";
import {
  normalizeFilePath,
  resolveScope,
  snapshotScope,
  ScopeResolutionError,
  type MaintenanceScope,
} from "./scope.ts";

export type ResolvedPlugin = {
  readonly id: string;
  readonly references: readonly string[];
  readonly selectedReferences: readonly string[];
  readonly description?: PluginInformation;
};

/** Inspection result containing complete declarations, historical baseline state, and plugin descriptions. */
export type ResolvedMaintenance = {
  readonly context: CheckContext & {
    readonly declarationCompleteness: "complete";
    readonly scope: readonly string[];
  };
  readonly root: string;
  readonly baselinePath: string;
  readonly configPath?: string;
  readonly plugins: readonly ResolvedPlugin[];
  /** Direct file targets from complete current declarations; does not imply transitive dependencies or file existence. */
  readonly files: readonly {
    readonly path: string;
    readonly references: readonly string[];
  }[];
  readonly declarationSources: {
    readonly config: readonly string[];
    readonly bindings: Readonly<Record<string, readonly string[]>>;
    readonly references: Readonly<Record<string, readonly string[]>>;
  };
};

export type ResolvedPluginRuntime = {
  readonly plugin: ReferencePlugin;
  readonly references: readonly NormalizedReference[];
  readonly selectedReferences: readonly NormalizedReference[];
  readonly prepared?: JsonValue;
};

export type ResolvedOperation = {
  readonly model: ResolvedMaintenance;
  readonly runtime: {
    readonly collectors: readonly ResolvedPluginRuntime[];
  };
};

type PreparedConfig = {
  readonly root: string;
  readonly baselinePath: string;
  readonly plugins: ReadonlyMap<string, Config["plugins"][number]>;
  readonly references: readonly NormalizedReference[];
  readonly bindings: BindingDefinition[];
  readonly declarationSources: ResolvedMaintenance["declarationSources"];
};

type PreparedPlugin = {
  readonly plugin: Config["plugins"][number];
  readonly references: readonly NormalizedReference[];
  readonly prepared?: JsonValue;
};

/** All three maintenance operations share full preflight, file target resolution, baseline loading, and scope resolution. */
export async function resolveMaintenance(
  value: unknown,
  defaultRoot: string,
  scope?: MaintenanceScope,
  configPath?: string,
): Promise<ResolvedOperation> {
  const config = prepareConfig(value, defaultRoot);
  let requestedScope: MaintenanceScope;
  try {
    requestedScope = snapshotScope(scope);
  } catch (error) {
    if (error instanceof ScopeResolutionError) {
      throw new MaintenanceError(error.code, error.message, { cause: error });
    }
    throw error;
  }
  const preparedPlugins = await preparePlugins(config);
  const fileInfo = currentFileInfo(config);
  const baseline = await readBaseline(config.baselinePath);
  const selection = resolveMaintenanceScope(
    requestedScope,
    config,
    baseline,
    fileInfo,
  );
  const selectedIds = new Set(
    selection.references.map((reference) => reference.id),
  );
  const resolvedPlugins = await Promise.all(
    preparedPlugins.map(async (preparedPlugin) => {
      const selectedReferences = Object.freeze(
        preparedPlugin.references.filter((reference) =>
          selectedIds.has(reference.id),
        ),
      );
      const description = await describePlugin(
        preparedPlugin,
        selectedReferences,
        config.root,
      );
      const view: ResolvedPlugin = {
        id: preparedPlugin.plugin.id,
        references: Object.freeze(
          preparedPlugin.references.map(({ id }) => id),
        ),
        selectedReferences: Object.freeze(
          selectedReferences.map(({ id }) => id),
        ),
        ...(description === undefined ? {} : { description }),
      };
      const collector: ResolvedPluginRuntime = {
        plugin: preparedPlugin.plugin,
        references: preparedPlugin.references,
        selectedReferences,
        ...(preparedPlugin.prepared === undefined
          ? {}
          : { prepared: preparedPlugin.prepared }),
      };
      return { view, collector };
    }),
  );
  const pluginViews = resolvedPlugins.map(({ view }) => view);
  const collectors = resolvedPlugins.map(({ collector }) => collector);
  const context: CheckContext = {
    references: referenceDefinitions(config, fileInfo),
    bindings: config.bindings,
    ...(baseline === undefined ? {} : { baseline }),
    declarationCompleteness: "complete",
    ...(selection.bindingIds === undefined
      ? {}
      : { scope: selection.bindingIds }),
  };
  const files = new Map<string, string[]>();
  for (const [id, path] of fileInfo) {
    if (path === null) continue;
    const references = files.get(path) ?? [];
    references.push(id);
    files.set(path, references);
  }
  return {
    model: {
      context: {
        ...context,
        declarationCompleteness: "complete",
        scope: resolveCheckScope(context),
      },
      root: config.root,
      baselinePath: config.baselinePath,
      ...(configPath === undefined ? {} : { configPath }),
      plugins: Object.freeze(pluginViews),
      files: [...files].map(([path, references]) => ({ path, references })),
      declarationSources: config.declarationSources,
    },
    runtime: {
      collectors: Object.freeze(collectors),
    },
  };
}

export function prepareConfig(
  value: unknown,
  defaultRoot: string,
): PreparedConfig {
  const normalized = normalizeConfig(value);
  const { config, references } = normalized;
  const root = resolve(defaultRoot, config.root ?? ".");
  const baselinePath = resolve(root, config.baseline ?? "dock.baseline.json");
  const plugins = new Map(config.plugins.map((plugin) => [plugin.id, plugin]));
  const bindings: PreparedConfig["bindings"][number][] = [];

  for (const binding of config.bindings) {
    bindings.push({
      id: binding.id,
      references: binding.references.map((reference) => reference.id),
      ...(binding.note === undefined ? {} : { note: binding.note }),
    });
  }

  return {
    root,
    baselinePath,
    plugins,
    references,
    bindings,
    declarationSources: {
      config: (config.declarationSources ?? []).map(sourceText),
      bindings: Object.fromEntries(
        config.bindings.map((binding) => [
          binding.id,
          binding.declaredAt === undefined
            ? []
            : [sourceText(binding.declaredAt)],
        ]),
      ),
      references: Object.fromEntries(
        references.map((reference) => [
          reference.id,
          reference.declarationSources.map(sourceText),
        ]),
      ),
    },
  };
}

async function preparePlugins(
  config: PreparedConfig,
): Promise<PreparedPlugin[]> {
  const context = Object.freeze({ root: config.root });
  return await Promise.all(
    [...config.plugins.values()].map(async (plugin) => {
      const references = Object.freeze(
        config.references.filter(
          (reference) => reference.pluginId === plugin.id,
        ),
      );
      if (references.length === 0 || plugin.prepare === undefined) {
        return { plugin, references };
      }
      let prepared: JsonValue | undefined;
      try {
        const value = await plugin.prepare(references, context);
        if (value !== undefined) prepared = ownJsonValue(value);
      } catch (error) {
        throw new MaintenanceError(
          "plugin-prepare-failed",
          `Plugin ${plugin.id} full-config preflight failed: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      return {
        plugin,
        references,
        ...(prepared === undefined ? {} : { prepared }),
      };
    }),
  );
}

async function describePlugin(
  preparedPlugin: PreparedPlugin,
  selectedReferences: readonly NormalizedReference[],
  root: string,
): Promise<PluginInformation | undefined> {
  if (preparedPlugin.plugin.describe === undefined) return undefined;
  const request = createPluginRequest(preparedPlugin, selectedReferences);
  try {
    return ownPluginInformation(
      await preparedPlugin.plugin.describe(request, Object.freeze({ root })),
    );
  } catch (error) {
    throw new MaintenanceError(
      "plugin-description-invalid",
      `Plugin ${preparedPlugin.plugin.id} returned an invalid inspection description: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function createPluginRequest(
  preparedPlugin: PreparedPlugin | ResolvedPluginRuntime,
  selectedReferences: readonly NormalizedReference[],
): PluginRequest {
  return Object.freeze({
    references: preparedPlugin.references,
    selectedReferences,
    ...(preparedPlugin.prepared === undefined
      ? {}
      : { prepared: preparedPlugin.prepared }),
  });
}

function referenceDefinitions(
  config: PreparedConfig,
  fileInfo: ReadonlyMap<string, string | null>,
): ReferenceDefinition[] {
  const baselineDirectory = dirname(config.baselinePath);
  const projectDirectory = isWithinDirectory(baselineDirectory, config.root)
    ? baselineDirectory
    : config.root;
  const context = Object.freeze({ root: config.root });
  return config.references.map((reference) => {
    const location = fileInfo.get(reference.id);
    let snapshot = location ?? null;
    if (
      location !== undefined &&
      location !== null &&
      isWithinDirectory(projectDirectory, location)
    ) {
      snapshot = relative(baselineDirectory, location) || ".";
    }
    const plugin = config.plugins.get(reference.pluginId);
    let target = reference.target;
    if (plugin?.comparableTarget !== undefined) {
      try {
        target = ownJsonValue(plugin.comparableTarget(reference, context));
      } catch (error) {
        throw new MaintenanceError(
          "plugin-comparable-target-failed",
          `Plugin ${plugin.id} failed to describe comparable target for reference ${reference.id}: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    }
    return {
      id: reference.id,
      target: {
        pluginId: reference.pluginId,
        target,
        fileInfo: snapshot,
      },
      ...(reference.selection === undefined
        ? {}
        : { selection: reference.selection }),
      ...(reference.note === undefined ? {} : { note: reference.note }),
    };
  });
}

function isWithinDirectory(directory: string, path: string): boolean {
  const fromDirectory = relative(directory, path);
  return (
    fromDirectory !== ".." &&
    !fromDirectory.startsWith(`..${sep}`) &&
    !isAbsolute(fromDirectory)
  );
}

function currentFileInfo(config: PreparedConfig): Map<string, string | null> {
  const locations = new Map<string, string | null>();
  for (const reference of config.references) {
    const plugin = config.plugins.get(reference.pluginId);
    if (plugin === undefined) {
      throw new MaintenanceError(
        "plugin-not-registered",
        `Plugin is not registered for reference ${reference.id}: ${reference.pluginId}`,
      );
    }
    if (plugin.fileInfo === undefined) {
      locations.set(reference.id, null);
      continue;
    }
    try {
      locations.set(
        reference.id,
        normalizeFilePath(
          plugin.fileInfo(reference, { root: config.root }),
          config.root,
        ),
      );
    } catch (error) {
      throw new MaintenanceError(
        "plugin-file-info-failed",
        `Plugin ${plugin.id} failed to describe file target for reference ${reference.id}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
  return locations;
}

function resolveMaintenanceScope(
  scope: MaintenanceScope | undefined,
  config: PreparedConfig,
  baseline: Baseline | undefined,
  fileInfo: ReadonlyMap<string, string | null>,
): ReturnType<typeof resolveScope> {
  try {
    return resolveScope(scope, {
      root: config.root,
      baselineDirectory: dirname(config.baselinePath),
      references: config.references,
      bindings: config.bindings,
      baseline,
      fileInfo,
    });
  } catch (error) {
    if (error instanceof ScopeResolutionError) {
      throw new MaintenanceError(error.code, error.message, { cause: error });
    }
    throw error;
  }
}

const HOST_TARGET_ALLOWED_KEYS = new Set(["pluginId", "target", "fileInfo"]);
const HOST_TARGET_REQUIRED_KEYS = ["pluginId", "target"] as const;

function validateHostBaselineTarget(
  node: JsonCstNode,
  basePath: string,
  reportIssue: (issue: BaselineValidationIssue) => void,
): JsonValue | undefined {
  if (node.kind !== "object") {
    reportIssue({
      path: basePath,
      code: "invalid-type",
      message: `Target wrapper at ${basePath} must be an object with pluginId, target, and fileInfo.`,
      line: node.span.start.line,
    });
    return undefined;
  }

  const props = new Map<string, JsonPropertyNode>();
  const duplicatedKeys = new Set<string>();
  const invalidKeys = new Set<string>();

  for (const prop of node.properties) {
    const fieldPath = `${basePath}.${prop.key}`;
    if (!isWellFormedJsonString(prop.key)) {
      if (!invalidKeys.has(prop.key)) {
        invalidKeys.add(prop.key);
        reportIssue({
          path: fieldPath,
          code: "invalid-json-value",
          message: `Property key at ${fieldPath} contains an unpaired surrogate.`,
          line: prop.keySpan.start.line,
        });
      }
      continue;
    }
    const first = props.get(prop.key);
    if (first !== undefined) {
      if (!duplicatedKeys.has(prop.key)) {
        duplicatedKeys.add(prop.key);
        reportIssue({
          path: fieldPath,
          code: "duplicate-key",
          message: `Duplicate key ${JSON.stringify(prop.key)} at ${fieldPath} (lines ${first.keySpan.start.line} and ${prop.keySpan.start.line}).`,
          line: prop.keySpan.start.line,
        });
      }
      continue;
    }
    props.set(prop.key, prop);
    if (!HOST_TARGET_ALLOWED_KEYS.has(prop.key)) {
      reportIssue({
        path: fieldPath,
        code: "unknown-field",
        message: `Unknown field ${JSON.stringify(prop.key)} at ${fieldPath}.`,
        line: prop.keySpan.start.line,
      });
    }
  }

  for (const reqKey of HOST_TARGET_REQUIRED_KEYS) {
    if (!props.has(reqKey) && !invalidKeys.has(reqKey)) {
      reportIssue({
        path: `${basePath}.${reqKey}`,
        code: "missing-field",
        message: `Missing required field ${JSON.stringify(reqKey)} at ${basePath}.`,
        line: node.span.start.line,
      });
    }
  }

  let pluginId: string | undefined;
  const pluginIdProp = props.get("pluginId");
  if (pluginIdProp !== undefined && !duplicatedKeys.has("pluginId")) {
    const pluginIdPath = `${basePath}.pluginId`;
    if (
      pluginIdProp.value.kind !== "string" ||
      pluginIdProp.value.value.length === 0
    ) {
      reportIssue({
        path: pluginIdPath,
        code:
          pluginIdProp.value.kind === "string" ? "invalid-id" : "invalid-type",
        message: `Target pluginId at ${pluginIdPath} must be a non-empty string.`,
        line: pluginIdProp.value.span.start.line,
      });
    } else if (!isWellFormedJsonString(pluginIdProp.value.value)) {
      reportIssue({
        path: pluginIdPath,
        code: "invalid-json-value",
        message: `Target pluginId at ${pluginIdPath} contains an unpaired surrogate.`,
        line: pluginIdProp.value.span.start.line,
      });
    } else {
      pluginId = pluginIdProp.value.value;
    }
  }

  let target: JsonValue | undefined;
  const targetProp = props.get("target");
  if (targetProp !== undefined && !duplicatedKeys.has("target")) {
    try {
      target = cstToJsonValue(targetProp.value);
    } catch (error) {
      reportIssue({
        path: `${basePath}.target`,
        code: "invalid-json-value",
        message: `${errorMessage(error)} at ${basePath}.target.`,
        line: targetProp.value.span.start.line,
      });
    }
  }

  let fileInfo: string | null | undefined;
  let fileInfoValid = true;
  const fileInfoProp = props.get("fileInfo");
  if (fileInfoProp !== undefined) {
    if (duplicatedKeys.has("fileInfo")) {
      fileInfoValid = false;
    } else {
      const fileInfoPath = `${basePath}.fileInfo`;
      if (fileInfoProp.value.kind === "null") {
        fileInfo = null;
      } else if (
        fileInfoProp.value.kind !== "string" ||
        fileInfoProp.value.value.length === 0
      ) {
        fileInfoValid = false;
        reportIssue({
          path: fileInfoPath,
          code:
            fileInfoProp.value.kind === "string"
              ? "invalid-id"
              : "invalid-type",
          message: `Target fileInfo at ${fileInfoPath} must be a non-empty string or null.`,
          line: fileInfoProp.value.span.start.line,
        });
      } else if (!isWellFormedJsonString(fileInfoProp.value.value)) {
        fileInfoValid = false;
        reportIssue({
          path: fileInfoPath,
          code: "invalid-json-value",
          message: `Target fileInfo at ${fileInfoPath} contains an unpaired surrogate.`,
          line: fileInfoProp.value.span.start.line,
        });
      } else {
        fileInfo = fileInfoProp.value.value;
      }
    }
  }

  if (pluginId === undefined || target === undefined || !fileInfoValid) {
    return undefined;
  }
  return {
    pluginId,
    target,
    ...(fileInfo === undefined ? {} : { fileInfo }),
  };
}

function formatBaselineIssue(issue: BaselineValidationIssue): string {
  if (
    issue.line !== undefined &&
    issue.code !== "duplicate-key" &&
    issue.code !== "invalid-version"
  ) {
    return `${issue.message} (line ${issue.line})`;
  }
  return issue.message;
}

async function readBaseline(path: string): Promise<Baseline | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw new MaintenanceError(
      "baseline-read-failed",
      `Failed to read baseline ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  try {
    return parseBaselineJson(content, {
      validateTargetDefinition: validateHostBaselineTarget,
    });
  } catch (error) {
    if (error instanceof JsonSyntaxError) {
      throw new MaintenanceError(
        "baseline-invalid",
        `Baseline ${path} is not valid JSON (line ${error.line}, column ${error.column}): ${error.message}`,
        { cause: error },
      );
    }
    if (error instanceof BaselineValidationError) {
      const message =
        error.issues.length === 1
          ? `Invalid baseline format at ${path}: ${formatBaselineIssue(error.issues[0]!)}`
          : `Invalid baseline format at ${path}:\n${error.issues.map((issue) => `  - ${formatBaselineIssue(issue)}`).join("\n")}`;
      throw new MaintenanceError("baseline-invalid", message, { cause: error });
    }
    throw new MaintenanceError(
      "baseline-invalid",
      `Invalid baseline format at ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function sourceText(source: DeclarationSource): string {
  return typeof source === "string" ? source : source.href;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
