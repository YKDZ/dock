import { randomUUID } from "node:crypto";
import { open, rename, rm, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import {
  check as checkCore,
  copyJsonValue,
  isJsonValue,
  updateBaseline as updateBaselineCore,
  type Baseline,
  type BaselineUpdateIssue,
  type CheckReport as CoreCheckReport,
  type JsonValue,
  type ReferenceMemberResult,
  type ReferenceResult,
  type TextRange,
} from "@ykdz/dock-core";

import type { Config, PluginRequest } from "./contracts.ts";
import { MaintenanceError } from "./errors.ts";
import { ownPluginInformation } from "./owned-data.ts";
import {
  resolveMaintenance,
  type ResolvedMaintenance,
  type ResolvedOperation,
  type ResolvedPluginRuntime,
} from "./resolution.ts";
import type { MaintenanceScope } from "./scope.ts";

export { MaintenanceError } from "./errors.ts";

export type MaintenanceConfig = Config | string | URL;
export type Operation = "inspect" | "check" | "updateBaseline";
export type { MaintenanceScope } from "./scope.ts";
export type CheckReport = CoreCheckReport & {
  readonly pluginDiagnostics: readonly {
    readonly pluginId: string;
    readonly data: JsonValue;
    readonly text: readonly string[];
  }[];
  readonly pluginErrors: readonly {
    readonly pluginId: string;
    readonly code: string;
    readonly message: string;
  }[];
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

export async function inspect(
  config: MaintenanceConfig,
  scope?: MaintenanceScope,
): Promise<ResolvedMaintenance> {
  return await runOperation("inspect", config, scope);
}

export async function check(
  config: MaintenanceConfig,
  scope?: MaintenanceScope,
): Promise<CheckReport> {
  return await runOperation("check", config, scope);
}

export async function updateBaseline(
  config: MaintenanceConfig,
  scope?: MaintenanceScope,
): Promise<BaselineUpdateOutcome> {
  return await runOperation("updateBaseline", config, scope);
}

type OperationResult = {
  inspect: ResolvedMaintenance;
  check: CheckReport;
  updateBaseline: BaselineUpdateOutcome;
};

async function runOperation<Kind extends Operation>(
  operation: Kind,
  config: MaintenanceConfig,
  scope?: MaintenanceScope,
): Promise<OperationResult[Kind]> {
  if (typeof config === "string" || config instanceof URL) {
    return await runConfigWorker(operation, resolveConfigPath(config), scope);
  }
  return await operateConfig(operation, config, process.cwd(), scope);
}

/** 配置文件和宿主对象入口在这里汇合，操作不会重新解释解析结果。 */
export async function operateConfig<Kind extends Operation>(
  operation: Kind,
  value: unknown,
  defaultRoot: string,
  scope?: MaintenanceScope,
  configPath?: string,
): Promise<OperationResult[Kind]> {
  const resolved = await resolveMaintenance(
    value,
    defaultRoot,
    scope,
    configPath,
  );
  if (operation === "inspect") return resolved.model as OperationResult[Kind];
  const collection = await collect(resolved);
  const input = { ...resolved.model.context, facts: collection.facts };
  if (operation === "check") {
    return withPluginInformation(
      checkCore(input),
      collection,
    ) as OperationResult[Kind];
  }
  const outcome = updateBaselineCore(input);
  if (outcome.status === "updated") {
    await writeBaseline(resolved.model.baselinePath, outcome.baseline);
  }
  return {
    ...outcome,
    report: withPluginInformation(outcome.report, collection),
  } as OperationResult[Kind];
}

type PluginError = {
  readonly pluginId: string;
  readonly code: string;
  readonly message: string;
};

type PluginCollection = {
  readonly facts: ReferenceResult[];
  readonly diagnostics: readonly {
    readonly pluginId: string;
    readonly data: JsonValue;
    readonly text: readonly string[];
  }[];
  readonly errors: readonly PluginError[];
};

async function collect(resolved: ResolvedOperation): Promise<PluginCollection> {
  const context = Object.freeze({ root: resolved.model.root });
  const batches = await Promise.all(
    resolved.runtime.collectors
      .filter(({ selectedReferences }) => selectedReferences.length > 0)
      .map(async (plugin) => {
        try {
          const request: PluginRequest = Object.freeze({
            references: plugin.references,
            selectedReferences: plugin.selectedReferences,
            ...(plugin.prepared === undefined
              ? {}
              : { prepared: plugin.prepared }),
          });
          const value = await plugin.plugin.collect(request, context);
          return acceptPluginBatch(plugin, value);
        } catch (error) {
          return failedPluginBatch(plugin, error);
        }
      }),
  );
  return {
    facts: batches.flatMap(({ facts }) => facts),
    diagnostics: batches.flatMap(({ diagnostics }) => diagnostics),
    errors: batches.flatMap(({ errors }) => errors),
  };
}

type AcceptedBatch = {
  readonly facts: ReferenceResult[];
  readonly diagnostics: PluginCollection["diagnostics"];
  readonly errors: PluginError[];
};

function acceptPluginBatch(
  plugin: ResolvedPluginRuntime,
  value: unknown,
): AcceptedBatch {
  const shell = readBatchShell(value);
  if (shell === undefined) {
    return failedPluginBatch(
      plugin,
      "无效批量结果外壳",
      "invalid-plugin-batch-result",
    );
  }

  const errors: PluginError[] = [];
  const diagnostics: PluginCollection["diagnostics"][number][] = [];
  if (shell.diagnostics !== undefined) {
    try {
      const information = ownPluginInformation(shell.diagnostics);
      diagnostics.push({ pluginId: plugin.plugin.id, ...information });
    } catch (error) {
      errors.push({
        pluginId: plugin.plugin.id,
        code: "invalid-plugin-diagnostics",
        message: `插件 ${plugin.plugin.id} 的诊断格式无效：${errorMessage(error)}`,
      });
    }
  }

  const selectedIds = new Set(plugin.selectedReferences.map(({ id }) => id));
  const byReference = new Map<string, unknown[]>();
  const facts: ReferenceResult[] = [];
  for (const entry of shell.results) {
    const id = resultReferenceId(entry);
    if (id === undefined) {
      errors.push({
        pluginId: plugin.plugin.id,
        code: "unattributed-plugin-result",
        message: `插件 ${plugin.plugin.id} 返回了没有有效引用身份的结果。`,
      });
      continue;
    }
    if (!selectedIds.has(id)) {
      errors.push({
        pluginId: plugin.plugin.id,
        code: "unexpected-plugin-result",
        message: `插件 ${plugin.plugin.id} 返回了本次未选中的引用结果：${id}。`,
      });
      continue;
    }
    const results = byReference.get(id) ?? [];
    results.push(entry);
    byReference.set(id, results);
  }

  for (const reference of plugin.selectedReferences) {
    const matches = byReference.get(reference.id) ?? [];
    if (matches.length === 0) {
      facts.push(
        pluginFailure(
          reference.id,
          "missing-plugin-result",
          `插件 ${plugin.plugin.id} 未返回引用 ${reference.id} 的结果。`,
        ),
      );
      continue;
    }
    if (matches.length > 1) {
      facts.push(
        pluginFailure(
          reference.id,
          "duplicate-plugin-result",
          `插件 ${plugin.plugin.id} 对引用 ${reference.id} 返回了多个结果。`,
        ),
      );
      continue;
    }
    try {
      facts.push(toReferenceResult(reference.id, matches[0]));
    } catch {
      facts.push(invalidPluginResult(reference.id));
    }
  }
  return { facts, diagnostics, errors };
}

function failedPluginBatch(
  plugin: ResolvedPluginRuntime,
  error: unknown,
  code = "plugin-failed",
): AcceptedBatch {
  const message = errorMessage(error);
  return {
    facts: plugin.selectedReferences.map((reference) =>
      pluginFailure(
        reference.id,
        code,
        `插件 ${plugin.plugin.id} 批量采集失败：${message}`,
      ),
    ),
    diagnostics: [],
    errors: [],
  };
}

function withPluginInformation(
  report: CoreCheckReport,
  collection: PluginCollection,
): CheckReport {
  return {
    ...report,
    pluginDiagnostics: collection.diagnostics,
    pluginErrors: collection.errors,
  };
}

type BatchShell = {
  readonly results: readonly unknown[];
  readonly diagnostics?: unknown;
};

function readBatchShell(value: unknown): BatchShell | undefined {
  if (!isPlainRecord(value)) return undefined;
  const results = ownDataProperty(value, "results");
  if (results.status !== "value") return undefined;
  const entries = denseArrayValues(results.value);
  if (entries === undefined) return undefined;
  const diagnostics = ownDataProperty(value, "diagnostics");
  if (diagnostics.status === "accessor") {
    return { results: entries, diagnostics: invalidInformation() };
  }
  if (diagnostics.status === "value" && diagnostics.value !== undefined) {
    return { results: entries, diagnostics: diagnostics.value };
  }
  return { results: entries };
}

function invalidInformation(): unknown {
  return Object.freeze({ invalid: true });
}

function resultReferenceId(value: unknown): string | undefined {
  if (!isPlainRecord(value)) return undefined;
  const id = ownDataProperty(value, "referenceId");
  return id.status === "value" && isNonEmptyString(id.value)
    ? id.value
    : undefined;
}

function toReferenceResult(id: string, value: unknown): ReferenceResult {
  if (!isPlainRecord(value)) return invalidPluginResult(id);
  const kind = ownDataProperty(value, "kind");
  const rangeProperty = ownDataProperty(value, "range");
  if (kind.status !== "value" || rangeProperty.status === "accessor") {
    return invalidPluginResult(id);
  }
  const range =
    rangeProperty.status === "value" && rangeProperty.value !== undefined
      ? copyTextRange(rangeProperty.value)
      : undefined;
  if (rangeProperty.status === "value" && range === undefined) {
    return invalidPluginResult(id);
  }
  if (kind.value === "error") {
    const error = ownDataProperty(value, "error");
    if (error.status !== "value" || !isPlainRecord(error.value)) {
      return invalidPluginResult(id);
    }
    const code = ownDataProperty(error.value, "code");
    const message = ownDataProperty(error.value, "message");
    if (
      code.status !== "value" ||
      !isNonEmptyString(code.value) ||
      message.status !== "value" ||
      typeof message.value !== "string"
    ) {
      return invalidPluginResult(id);
    }
    return {
      referenceId: id,
      error: { code: code.value, message: message.value },
      ...(range === undefined ? {} : { range }),
    };
  }
  if (kind.value === "value") {
    const fact = ownDataProperty(value, "value");
    if (fact.status !== "value" || !isJsonValue(fact.value)) {
      return invalidPluginResult(id);
    }
    return {
      referenceId: id,
      value: copyJsonValue(fact.value),
      ...(range === undefined ? {} : { range }),
    };
  }
  if (kind.value === "collection") {
    const collection = ownDataProperty(value, "collection");
    if (collection.status !== "value" || !isPlainRecord(collection.value)) {
      return invalidPluginResult(id);
    }
    const completeness = ownDataProperty(collection.value, "completeness");
    const members = ownDataProperty(collection.value, "members");
    if (
      completeness.status !== "value" ||
      (completeness.value !== "complete" && completeness.value !== "partial") ||
      members.status !== "value"
    ) {
      return invalidPluginResult(id);
    }
    const memberValues = denseArrayValues(members.value);
    if (memberValues === undefined) return invalidPluginResult(id);
    const parsedMembers: ReferenceMemberResult[] = [];
    for (const member of memberValues) {
      const parsed = toMemberResult(member);
      if (parsed === undefined) return invalidPluginResult(id);
      parsedMembers.push(parsed);
    }
    return {
      referenceId: id,
      collection: {
        completeness: completeness.value,
        members: parsedMembers,
      },
      ...(range === undefined ? {} : { range }),
    };
  }
  return invalidPluginResult(id);
}

function toMemberResult(value: unknown):
  | { readonly id: string; readonly value: JsonValue }
  | {
      readonly id: string;
      readonly error: { readonly code: string; readonly message: string };
    }
  | undefined {
  if (!isPlainRecord(value)) return undefined;
  const id = ownDataProperty(value, "id");
  if (id.status !== "value" || !isNonEmptyString(id.value)) return undefined;
  const error = ownDataProperty(value, "error");
  if (error.status === "accessor") return undefined;
  if (error.status === "value") {
    if (!isPlainRecord(error.value)) return undefined;
    const code = ownDataProperty(error.value, "code");
    const message = ownDataProperty(error.value, "message");
    if (
      code.status !== "value" ||
      !isNonEmptyString(code.value) ||
      message.status !== "value" ||
      typeof message.value !== "string"
    ) {
      return undefined;
    }
    // core 按 error 字段判断成员失败，必须保留该错误语义。
    return {
      id: id.value,
      error: { code: code.value, message: message.value },
    };
  }
  const fact = ownDataProperty(value, "value");
  if (fact.status === "value" && isJsonValue(fact.value)) {
    return { id: id.value, value: copyJsonValue(fact.value) };
  }
  return undefined;
}

function copyTextRange(value: unknown): TextRange | undefined {
  if (!isPlainRecord(value)) return undefined;
  const path = ownDataProperty(value, "path");
  const start = ownDataProperty(value, "start");
  const end = ownDataProperty(value, "end");
  if (
    path.status !== "value" ||
    typeof path.value !== "string" ||
    start.status !== "value" ||
    typeof start.value !== "number" ||
    !Number.isInteger(start.value) ||
    start.value < 0 ||
    end.status !== "value" ||
    typeof end.value !== "number" ||
    !Number.isInteger(end.value) ||
    end.value < start.value ||
    Object.getOwnPropertyNames(value).length !== 3
  ) {
    return undefined;
  }
  return { path: path.value, start: start.value, end: end.value };
}

function pluginFailure(
  id: string,
  code: string,
  message: string,
): ReferenceResult {
  return { referenceId: id, error: { code, message } };
}

function invalidPluginResult(id: string): ReferenceResult {
  return pluginFailure(
    id,
    "invalid-plugin-result",
    `插件对引用 ${id} 返回了无效采集结果。`,
  );
}

type OwnProperty =
  | { readonly status: "missing" | "accessor" }
  | { readonly status: "value"; readonly value: unknown };

function ownDataProperty(value: object, key: string): OwnProperty {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return { status: "missing" };
  if (!descriptor.enumerable || !("value" in descriptor)) {
    return { status: "accessor" };
  }
  return { status: "value", value: descriptor.value };
}

function denseArrayValues(value: unknown): unknown[] | undefined {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length > 0 ||
    Object.getOwnPropertyNames(value).length !== value.length + 1
  ) {
    return undefined;
  }
  const entries: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return undefined;
    }
    entries.push(descriptor.value);
  }
  return entries;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function errorMessage(error: unknown): string {
  try {
    return String(error instanceof Error ? error.message : error);
  } catch {
    return "错误对象无法转换为文本";
  }
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
