import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  canonicalJson,
  check as checkCore,
  isJsonValue,
  resolveCheckScope,
  type Baseline,
  type BindingDefinition,
  type CheckContext,
  type ReferenceDefinition,
} from "@ykdz/dock-core";

import { normalizeConfig, type NormalizedReference } from "./authoring.ts";
import type { Config, DeclarationSource, RunDeclaration } from "./contracts.ts";
import { MaintenanceError } from "./errors.ts";
import { ownJsonValue } from "./owned-data.ts";
import {
  normalizeFilePath,
  resolveScope,
  snapshotScope,
  ScopeResolutionError,
  type MaintenanceScope,
} from "./scope.ts";

export type ResolvedRun = RunDeclaration & {
  readonly pluginId: string;
  readonly selectedReferences: readonly string[];
};

/** 解析时点的完整声明、历史状态及范围；宿主信息不参与领域比较。 */
export type ResolvedMaintenance = {
  readonly context: CheckContext & {
    readonly declarationCompleteness: "complete";
    readonly scope: readonly string[];
  };
  readonly root: string;
  readonly baselinePath: string;
  readonly configPath?: string;
  readonly plugins: readonly string[];
  readonly runs: readonly ResolvedRun[];
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

export type ResolvedOperation = {
  readonly model: ResolvedMaintenance;
  readonly runtime: {
    readonly plugins: ReadonlyMap<string, Config["plugins"][number]>;
    readonly references: readonly NormalizedReference[];
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
  const declarations = await declarePluginRuns(config);
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
      // 后续插件采集不能改写已解析的领域输入。
      context: structuredClone({
        ...context,
        declarationCompleteness: "complete",
        scope: resolveCheckScope(context),
      }),
      root: config.root,
      baselinePath: config.baselinePath,
      ...(configPath === undefined ? {} : { configPath }),
      plugins: [...config.plugins.keys()],
      runs: Object.freeze(
        declarations.map((declaration) =>
          Object.freeze({
            ...declaration,
            selectedReferences: Object.freeze(
              declaration.references.filter((id) => selectedIds.has(id)),
            ),
          }),
        ),
      ),
      files: [...files].map(([path, references]) => ({ path, references })),
      declarationSources: config.declarationSources,
    },
    runtime: {
      plugins: config.plugins,
      references: selection.references,
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
      // 仓库级基线可覆盖包外的共享文档；项目外位置保持绝对目标。
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

async function declarePluginRuns(
  config: PreparedConfig,
): Promise<Omit<ResolvedRun, "selectedReferences">[]> {
  const runs = new Map<string, Omit<ResolvedRun, "selectedReferences">>();
  const context = Object.freeze({ root: config.root });
  for (const plugin of config.plugins.values()) {
    const references = Object.freeze(
      config.references.filter((reference) => reference.pluginId === plugin.id),
    );
    if (references.length === 0) continue;
    let declarations: readonly RunDeclaration[];
    try {
      if (plugin.validateReferences !== undefined) {
        const result = await plugin.validateReferences(references, context);
        if (result !== undefined)
          throw new TypeError("完整引用集合校验不能返回运行声明。");
      }
      if (plugin.execution === undefined) continue;
      declarations = await plugin.execution.declare(references, context);
    } catch (error) {
      throw new MaintenanceError(
        "plugin-reference-validation-failed",
        `插件 ${plugin.id} 完整配置预检失败：${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (!validDeclarations(declarations)) {
      throw new MaintenanceError(
        "plugin-reference-validation-failed",
        `插件 ${plugin.id} 必须返回有效的运行声明列表。`,
      );
    }
    const referenceIds = new Set(references.map((reference) => reference.id));
    for (const declaration of declarations) {
      if (!declaration.references.every((id) => referenceIds.has(id))) {
        throw new MaintenanceError(
          "plugin-reference-validation-failed",
          `插件 ${plugin.id} 返回了无效引用归属。`,
        );
      }
      const prior = runs.get(declaration.identity);
      if (
        prior !== undefined &&
        (prior.pluginId !== plugin.id ||
          canonicalJson(prior.configuration) !==
            canonicalJson(declaration.configuration))
      ) {
        throw new MaintenanceError(
          prior.pluginId === plugin.id
            ? "plugin-reference-validation-failed"
            : "execution-identity-conflict",
          `执行身份 ${declaration.identity} 在插件 ${prior.pluginId} 与 ${plugin.id} 中存在配置或执行归属冲突。`,
        );
      }
      runs.set(
        declaration.identity,
        Object.freeze({
          pluginId: plugin.id,
          identity: declaration.identity,
          configuration:
            prior?.configuration ?? ownJsonValue(declaration.configuration),
          references: Object.freeze([
            ...new Set([
              ...(prior?.references ?? []),
              ...declaration.references,
            ]),
          ]),
        }),
      );
    }
  }
  return [...runs.values()];
}

function validDeclarations(value: unknown): value is readonly RunDeclaration[] {
  return (
    Array.isArray(value) &&
    isJsonValue(value) &&
    value.every((declaration: unknown) => {
      if (
        typeof declaration !== "object" ||
        declaration === null ||
        Array.isArray(declaration)
      )
        return false;
      const run = declaration as Record<string, unknown>;
      return (
        typeof run.identity === "string" &&
        run.identity.length > 0 &&
        Object.hasOwn(run, "configuration") &&
        isJsonValue(run.configuration) &&
        Array.isArray(run.references) &&
        run.references.length > 0 &&
        run.references.every(
          (id: unknown) => typeof id === "string" && id.length > 0,
        )
      );
    })
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
