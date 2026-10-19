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
  type ReferenceResult,
} from "@ykdz/dock-core";

import type { Config, PluginResult } from "./contracts.ts";
import { MaintenanceError } from "./errors.ts";
import {
  createExecutionSession,
  type ExecutionSession,
  type ExecutionSummary,
} from "./execution.ts";
import {
  resolveMaintenance,
  type ResolvedMaintenance,
  type ResolvedOperation,
} from "./resolution.ts";
import type { MaintenanceScope } from "./scope.ts";

export { MaintenanceError } from "./errors.ts";

export type MaintenanceConfig = Config | string | URL;
export type Operation = "inspect" | "check" | "updateBaseline";
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

/** 配置文件和 SDK 对象入口在这里汇合，操作不会重新解释解析结果。 */
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
  const session = await prepareExecution(resolved);
  const facts = await collect(resolved, session);
  const input = { ...resolved.model.context, facts };
  if (operation === "check") {
    return withExecutionSummary(
      checkCore(input),
      session,
    ) as OperationResult[Kind];
  }
  const outcome = updateBaselineCore(input);
  if (outcome.status === "updated") {
    await writeBaseline(resolved.model.baselinePath, outcome.baseline);
  }
  return {
    ...outcome,
    report: withExecutionSummary(outcome.report, session),
  } as OperationResult[Kind];
}

async function prepareExecution(
  resolved: ResolvedOperation,
): Promise<ExecutionSession> {
  const session = createExecutionSession(resolved);
  await session.run();
  return session;
}

async function collect(
  resolved: ResolvedOperation,
  session: ExecutionSession,
): Promise<ReferenceResult[]> {
  return await Promise.all(
    resolved.runtime.references.map(async (reference) => {
      const plugin = resolved.runtime.plugins.get(reference.pluginId);
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
          await plugin.collect(
            reference,
            Object.freeze({
              root: resolved.model.root,
              execution: session.view(plugin.id),
            }),
          ),
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
      value: copyJsonValue(result.value),
      ...(range === undefined ? {} : { range }),
    };
  }
  if (result.kind === "collection") {
    return {
      referenceId: id,
      collection: {
        completeness: result.collection.completeness,
        members: result.collection.members.map((member) =>
          "value" in member && isJsonValue(member.value)
            ? { ...member, value: copyJsonValue(member.value) }
            : { ...member },
        ),
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
