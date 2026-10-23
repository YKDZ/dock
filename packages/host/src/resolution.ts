import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  check as checkCore,
  resolveCheckScope,
  type Baseline,
  type BindingDefinition,
  type CheckContext,
  type JsonValue,
  type ReferenceDefinition,
} from "@ykdz/dock-core";

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

/** 查看结果包含完整声明、历史状态和各插件明确公开的说明。 */
export type ResolvedMaintenance = {
  readonly context: CheckContext & {
    readonly declarationCompleteness: "complete";
    readonly scope: readonly string[];
  };
  readonly root: string;
  readonly baselinePath: string;
  readonly configPath?: string;
  readonly plugins: readonly ResolvedPlugin[];
  /** 完整当前声明的直接文件目标，不表示传递依赖或文件已经存在。 */
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
    readonly plugins: ReadonlyMap<string, Config["plugins"][number]>;
    readonly references: readonly NormalizedReference[];
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

/** 三种维护操作共用完整预检、文件定位、基线读取及范围解释。 */
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
  const pluginViews = await Promise.all(
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
      return {
        id: preparedPlugin.plugin.id,
        references: Object.freeze(
          preparedPlugin.references.map(({ id }) => id),
        ),
        selectedReferences: Object.freeze(
          selectedReferences.map(({ id }) => id),
        ),
        ...(description === undefined ? {} : { description }),
      } satisfies ResolvedPlugin;
    }),
  );
  const collectors = preparedPlugins.map((preparedPlugin) => ({
    plugin: preparedPlugin.plugin,
    references: preparedPlugin.references,
    selectedReferences: Object.freeze(
      preparedPlugin.references.filter((reference) =>
        selectedIds.has(reference.id),
      ),
    ),
    ...(preparedPlugin.prepared === undefined
      ? {}
      : { prepared: preparedPlugin.prepared }),
  }));
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
      context: structuredClone({
        ...context,
        declarationCompleteness: "complete",
        scope: resolveCheckScope(context),
      }),
      root: config.root,
      baselinePath: config.baselinePath,
      ...(configPath === undefined ? {} : { configPath }),
      plugins: Object.freeze(pluginViews),
      files: [...files].map(([path, references]) => ({ path, references })),
      declarationSources: config.declarationSources,
    },
    runtime: {
      plugins: config.plugins,
      references: selection.references,
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
          `插件 ${plugin.id} 完整配置预检失败：${errorMessage(error)}`,
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
      `插件 ${preparedPlugin.plugin.id} 返回了无效查看说明：${errorMessage(error)}`,
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
    return {
      id: reference.id,
      target: {
        pluginId: reference.pluginId,
        target: reference.target,
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
        `引用 ${reference.id} 的插件未登记：${reference.pluginId}`,
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
        `插件 ${plugin.id} 无法说明引用 ${reference.id} 的文件目标：${errorMessage(error)}`,
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

async function readBaseline(path: string): Promise<Baseline | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw new MaintenanceError(
      "baseline-read-failed",
      `无法读取基线 ${path}：${errorMessage(error)}`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    throw new MaintenanceError(
      "baseline-invalid",
      `基线 ${path} 不是有效 JSON：${errorMessage(error)}`,
      { cause: error },
    );
  }
  try {
    checkCore({
      references: [],
      bindings: [],
      facts: [],
      baseline: parsed as Baseline,
    });
  } catch (error) {
    throw new MaintenanceError(
      "baseline-invalid",
      `基线 ${path} 格式无效：${errorMessage(error)}`,
      { cause: error },
    );
  }
  return parsed as Baseline;
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
