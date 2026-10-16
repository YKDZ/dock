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
  type BaselineUpdateOutcome,
  type BindingDefinition,
  type CheckReport,
  type ReferenceDefinition,
  type ReferenceResult,
} from "@dock/core";

import { validateConfig } from "./authoring.ts";
import type { Config, PluginResult, Reference } from "./contracts.ts";

export type MaintenanceConfig = Config | string | URL;
export type Operation = "check" | "updateBaseline";

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
  readonly references: readonly Reference[];
  readonly bindings: BindingDefinition[];
};

export async function check(config: MaintenanceConfig): Promise<CheckReport> {
  if (typeof config === "string" || config instanceof URL) {
    return await runConfigWorker("check", resolveConfigPath(config));
  }
  return await checkConfig(config, process.cwd());
}

export async function updateBaseline(
  config: MaintenanceConfig,
): Promise<BaselineUpdateOutcome> {
  if (typeof config === "string" || config instanceof URL) {
    return await runConfigWorker("updateBaseline", resolveConfigPath(config));
  }
  return await updateConfig(config, process.cwd());
}

export async function checkConfig(
  value: unknown,
  defaultRoot: string,
): Promise<CheckReport> {
  const config = prepareConfig(value, defaultRoot);
  const baseline = await readBaseline(config.baselinePath);
  const facts = await collect(config);
  return checkCore({
    references: referenceDefinitions(config.references),
    bindings: config.bindings,
    facts,
    ...(baseline === undefined ? {} : { baseline }),
    declarationCompleteness: "complete",
  });
}

export async function updateConfig(
  value: unknown,
  defaultRoot: string,
): Promise<BaselineUpdateOutcome> {
  const config = prepareConfig(value, defaultRoot);
  const baseline = await readBaseline(config.baselinePath);
  const facts = await collect(config);
  const outcome = updateBaselineCore({
    references: referenceDefinitions(config.references),
    bindings: config.bindings,
    facts,
    ...(baseline === undefined ? {} : { baseline }),
    declarationCompleteness: "complete",
  });
  if (outcome.status === "updated") {
    await writeBaseline(config.baselinePath, outcome.baseline);
  }
  return outcome;
}

export function prepareConfig(
  value: unknown,
  defaultRoot: string,
): PreparedConfig {
  validateConfig(value);
  const root = resolve(defaultRoot, value.root ?? ".");
  const baselinePath = resolve(root, value.baseline ?? "dock.baseline.json");
  const plugins = new Map(value.plugins.map((plugin) => [plugin.id, plugin]));
  const references = new Map<string, Reference>();
  const bindings: PreparedConfig["bindings"][number][] = [];

  for (const binding of value.bindings) {
    bindings.push({
      id: binding.id,
      references: binding.references.map((reference) => reference.id),
      ...(binding.note === undefined ? {} : { note: binding.note }),
    });
    for (const reference of binding.references) {
      if (!references.has(reference.id))
        references.set(reference.id, reference);
    }
  }

  return {
    root,
    baselinePath,
    plugins,
    references: [...references.values()],
    bindings,
  };
}

async function collect(config: PreparedConfig): Promise<ReferenceResult[]> {
  return await Promise.all(
    config.references.map(async (reference) => {
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
          await plugin.collect(reference, { root: config.root }),
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
  references: readonly Reference[],
): ReferenceDefinition[] {
  return references.map((reference) => ({
    id: reference.id,
    target: reference.target,
    ...(reference.selection === undefined
      ? {}
      : { selection: reference.selection }),
    ...(reference.note === undefined ? {} : { note: reference.note }),
  }));
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
      workerData: { operation, configPath },
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
