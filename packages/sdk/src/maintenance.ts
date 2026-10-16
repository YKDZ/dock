import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import {
  check as checkCore,
  isJsonValue,
  updateBaseline as updateBaselineCore,
  type Baseline,
  type BaselineUpdateIssue,
  type BindingDefinition,
  type CheckReport as CoreCheckReport,
  type JsonValue,
  type ReferenceDefinition,
  type ReferenceResult,
} from "@dock/core";

import { normalizeConfig, type NormalizedReference } from "./authoring.ts";
import type {
  Config,
  PluginExecutionContext,
  PluginExecutionIdentity,
  PluginResult,
} from "./contracts.ts";
import {
  createExecutionSession,
  type ExecutionSession,
  type ExecutionSummary,
} from "./execution.ts";
import {
  normalizeFilePath,
  resolveScope,
  ScopeResolutionError,
  type MaintenanceScope,
} from "./scope.ts";

export type MaintenanceConfig = Config | string | URL;
export type Operation = "check" | "updateBaseline";
export type { MaintenanceScope } from "./scope.ts";
export type CheckReport = CoreCheckReport & {
  readonly execution?: ExecutionSummary;
};
export type BaselineUpdateOutcome =
  | {
      readonly status: "updated";
      readonly baseline: Baseline;
      readonly report: CheckReport;
    }
  | {
      readonly status: "rejected";
      readonly errors: BaselineUpdateIssue[];
      readonly report: CheckReport;
    };

export class MaintenanceError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MaintenanceError";
    this.code = code;
  }
}

type PreparedConfig = {
  readonly root: string;
  readonly baselinePath: string;
  readonly plugins: ReadonlyMap<string, Config["plugins"][number]>;
  readonly references: readonly NormalizedReference[];
  readonly bindings: BindingDefinition[];
};

export async function check(
  config: MaintenanceConfig,
  scope?: MaintenanceScope,
): Promise<CheckReport> {
  if (typeof config === "string" || config instanceof URL) {
    return await runConfigWorker("check", resolveConfigPath(config), scope);
  }
  return await checkConfig(config, process.cwd(), scope);
}

export async function updateBaseline(
  config: MaintenanceConfig,
  scope?: MaintenanceScope,
): Promise<BaselineUpdateOutcome> {
  if (typeof config === "string" || config instanceof URL) {
    return await runConfigWorker(
      "updateBaseline",
      resolveConfigPath(config),
      scope,
    );
  }
  return await updateConfig(config, process.cwd(), scope);
}

export async function checkConfig(
  value: unknown,
  defaultRoot: string,
  scope?: MaintenanceScope,
): Promise<CheckReport> {
  const config = prepareConfig(value, defaultRoot);
  await validatePluginReferences(config, scope);
  const fileInfo = currentFileInfo(config);
  const baseline = await readBaseline(config.baselinePath);
  const selection = resolveMaintenanceScope(scope, config, baseline, fileInfo);
  const session = await prepareExecution(config, selection.references);
  const facts = await collect(config, selection.references, session);
  const report = checkCore({
    references: referenceDefinitions(config.references, fileInfo),
    bindings: config.bindings,
    facts,
    ...(baseline === undefined ? {} : { baseline }),
    declarationCompleteness: "complete",
    ...(selection.bindingIds === undefined
      ? {}
      : { scope: [...selection.bindingIds] }),
  });
  return withExecutionSummary(report, session);
}

export async function updateConfig(
  value: unknown,
  defaultRoot: string,
  scope?: MaintenanceScope,
): Promise<BaselineUpdateOutcome> {
  const config = prepareConfig(value, defaultRoot);
  await validatePluginReferences(config, scope);
  const fileInfo = currentFileInfo(config);
  const baseline = await readBaseline(config.baselinePath);
  const selection = resolveMaintenanceScope(scope, config, baseline, fileInfo);
  const session = await prepareExecution(config, selection.references);
  const facts = await collect(config, selection.references, session);
  const outcome = updateBaselineCore({
    references: referenceDefinitions(config.references, fileInfo),
    bindings: config.bindings,
    facts,
    ...(baseline === undefined ? {} : { baseline }),
    declarationCompleteness: "complete",
    ...(selection.bindingIds === undefined
      ? {}
      : { scope: [...selection.bindingIds] }),
  });
  if (outcome.status === "updated") {
    await writeBaseline(config.baselinePath, outcome.baseline);
  }
  return {
    ...outcome,
    report: withExecutionSummary(outcome.report, session),
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
  };
}

async function prepareExecution(
  config: PreparedConfig,
  references: readonly NormalizedReference[],
): Promise<ExecutionSession> {
  const session = createExecutionSession();
  const context: PluginExecutionContext = {
    root: config.root,
    execution: session,
  };
  for (const plugin of config.plugins.values()) {
    if (plugin.prepare === undefined) continue;
    const pluginReferences = references.filter(
      (reference) => reference.pluginId === plugin.id,
    );
    if (pluginReferences.length === 0) continue;
    try {
      await plugin.prepare(pluginReferences, context);
    } catch (error) {
      throw new MaintenanceError(
        "plugin-prepare-failed",
        `插件 ${plugin.id} 准备执行失败：${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
  await session.run();
  return session;
}

async function collect(
  config: PreparedConfig,
  references: readonly NormalizedReference[],
  session: ExecutionSession,
): Promise<ReferenceResult[]> {
  const context: PluginExecutionContext = {
    root: config.root,
    execution: session,
  };
  return await Promise.all(
    references.map(async (reference) => {
      const plugin = config.plugins.get(reference.pluginId);
      if (plugin === undefined) {
        return {
          referenceId: reference.id,
          error: {
            code: "plugin-not-registered",
            message: `引用 ${reference.id} 的插件未登记：${reference.pluginId}`,
          },
        } satisfies ReferenceResult;
      }
      try {
        return toReferenceResult(
          reference.id,
          await plugin.collect(reference, context),
        );
      } catch (error) {
        return {
          referenceId: reference.id,
          error: {
            code: "plugin-failed",
            message: errorMessage(error),
          },
        } satisfies ReferenceResult;
      }
    }),
  );
}

function withExecutionSummary(
  report: CoreCheckReport,
  session: ExecutionSession,
): CheckReport {
  const execution = session.summary();
  return execution === undefined ? report : { ...report, execution };
}

function toReferenceResult(id: string, result: PluginResult): ReferenceResult {
  if (typeof result !== "object" || result === null) {
    return invalidPluginResult(id);
  }
  const range = "range" in result ? result.range : undefined;
  if (result.kind === "error") {
    return {
      referenceId: id,
      error: result.error,
      ...(range === undefined ? {} : { range }),
    };
  }
  if (result.kind === "value" && isJsonValue(result.value)) {
    return {
      referenceId: id,
      value: result.value,
      ...(range === undefined ? {} : { range }),
    };
  }
  if (result.kind === "collection") {
    return {
      referenceId: id,
      collection: {
        completeness: result.collection.completeness,
        members: [...result.collection.members],
      },
      ...(range === undefined ? {} : { range }),
    };
  }
  return invalidPluginResult(id);
}

function invalidPluginResult(id: string): ReferenceResult {
  return {
    referenceId: id,
    error: {
      code: "invalid-plugin-result",
      message: `插件对引用 ${id} 返回了无效采集结果。`,
    },
  };
}

function referenceDefinitions(
  references: readonly NormalizedReference[],
  fileInfo: ReadonlyMap<string, string | null>,
): ReferenceDefinition[] {
  return references.map((reference) => ({
    id: reference.id,
    target: {
      pluginId: reference.pluginId,
      target: reference.target,
      fileInfo: fileInfo.get(reference.id) ?? null,
    },
    ...(reference.selection === undefined
      ? {}
      : { selection: reference.selection }),
    ...(reference.note === undefined ? {} : { note: reference.note }),
  }));
}

async function validatePluginReferences(
  config: PreparedConfig,
  scope: MaintenanceScope | undefined,
): Promise<void> {
  const filtering = requestsFiltering(scope);
  const identities = new Map<
    string,
    { readonly configuration: string; readonly pluginId: string }
  >();
  const context = { root: config.root };

  for (const plugin of config.plugins.values()) {
    const references = config.references.filter(
      (reference) => reference.pluginId === plugin.id,
    );
    if (references.length === 0) continue;
    if (plugin.validateReferences === undefined) {
      if (filtering && plugin.prepare !== undefined) {
        throw new MaintenanceError(
          "plugin-preflight-missing",
          `插件 ${plugin.id} 会登记执行，但没有完整配置身份预检，不能安全缩小范围。`,
        );
      }
      continue;
    }
    let declarations: void | readonly PluginExecutionIdentity[];
    try {
      declarations = await plugin.validateReferences(references, context);
    } catch (error) {
      throw new MaintenanceError(
        "plugin-reference-validation-failed",
        `插件 ${plugin.id} 完整配置预检失败：${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (declarations === undefined) continue;
    if (!Array.isArray(declarations)) {
      throw new MaintenanceError(
        "plugin-reference-validation-failed",
        `插件 ${plugin.id} 完整配置预检必须返回执行身份列表。`,
      );
    }
    for (const declaration of declarations) {
      if (
        typeof declaration !== "object" ||
        declaration === null ||
        Array.isArray(declaration) ||
        typeof declaration.identity !== "string" ||
        declaration.identity.length === 0 ||
        !isJsonValue(declaration.configuration)
      ) {
        throw new MaintenanceError(
          "plugin-reference-validation-failed",
          `插件 ${plugin.id} 完整配置预检返回了无效执行身份。`,
        );
      }
      const encoded = canonicalJson(declaration.configuration);
      const prior = identities.get(declaration.identity);
      if (prior !== undefined && prior.configuration !== encoded) {
        throw new MaintenanceError(
          "execution-identity-conflict",
          `执行身份 ${declaration.identity} 在插件 ${prior.pluginId} 与 ${plugin.id} 中对应不同配置。`,
        );
      }
      identities.set(declaration.identity, {
        configuration: encoded,
        pluginId: plugin.id,
      });
    }
  }
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

function requestsFiltering(scope: MaintenanceScope | undefined): boolean {
  if (scope === undefined) return false;
  if (typeof scope !== "object" || scope === null) return true;
  return Object.values(scope).some(
    (value) => !Array.isArray(value) || value.length > 0,
  );
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
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

async function writeBaseline(path: string, baseline: Baseline): Promise<void> {
  const directory = dirname(path);
  const temporary = resolve(directory, `.${randomUUID()}.dock-baseline.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(directory, { recursive: true });
    handle = await open(temporary, "wx", 0o666);
    await handle.writeFile(`${JSON.stringify(baseline, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    throw new MaintenanceError(
      "baseline-write-failed",
      `无法原子写入基线 ${path}：${errorMessage(error)}`,
      { cause: error },
    );
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function resolveConfigPath(input: string | URL): string {
  if (input instanceof URL) {
    if (input.protocol !== "file:") {
      throw new MaintenanceError(
        "config-path-invalid",
        "配置入口 URL 必须使用 file: 协议。",
      );
    }
    return fileURLToPath(input);
  }
  return resolve(process.cwd(), input);
}

function runConfigWorker<T>(
  operation: Operation,
  configPath: string,
  scope?: MaintenanceScope,
): Promise<T> {
  const workerUrl = new URL(
    import.meta.url.endsWith(".ts")
      ? "./maintenance-worker.ts"
      : "./maintenance-worker.js",
    import.meta.url,
  );
  const execArgv = process.execArgv.filter(
    (argument) =>
      argument.startsWith("--conditions=") ||
      argument.startsWith("--import=") ||
      argument.startsWith("--loader="),
  );
  return new Promise<T>((resolveResult, rejectResult) => {
    const worker = new Worker(workerUrl, {
      workerData: {
        operation,
        configPath,
        ...(scope === undefined ? {} : { scope }),
      },
      execArgv,
    });
    let finishing = false;
    const finishAfterTermination = async (
      settle: () => void,
    ): Promise<void> => {
      try {
        await worker.terminate();
        settle();
      } catch (error) {
        rejectResult(
          new MaintenanceError(
            "config-worker-failed",
            `配置维护 Worker 收尾失败：${errorMessage(error)}`,
            { cause: error },
          ),
        );
      }
    };
    worker.once("message", (message: WorkerMessage) => {
      if (finishing) return;
      finishing = true;
      void finishAfterTermination(() => {
        if (message.ok) {
          resolveResult(message.result as T);
        } else {
          rejectResult(new MaintenanceError(message.code, message.message));
        }
      });
    });
    worker.once("error", (error) => {
      if (finishing) return;
      finishing = true;
      void finishAfterTermination(() =>
        rejectResult(
          new MaintenanceError(
            "config-worker-failed",
            `配置维护 Worker 失败：${error.message}`,
            { cause: error },
          ),
        ),
      );
    });
    worker.once("exit", (code) => {
      if (finishing) return;
      finishing = true;
      rejectResult(
        new MaintenanceError(
          "config-worker-failed",
          `配置维护 Worker 提前退出（${String(code)}）。`,
        ),
      );
    });
  });
}

export type WorkerMessage =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };

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
