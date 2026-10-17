import { dirname, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

import {
  MaintenanceError,
  operateConfig,
  type Operation,
  type MaintenanceScope,
  type WorkerMessage,
} from "./maintenance.ts";

type WorkerInput = {
  readonly operation: Operation;
  readonly configPath: string;
  readonly scope?: MaintenanceScope;
};

async function run(): Promise<WorkerMessage> {
  const input = workerData as WorkerInput;
  if (!new Set([".ts", ".mts", ".js", ".mjs"]).has(extname(input.configPath))) {
    throw new MaintenanceError(
      "config-extension-unsupported",
      `配置入口 ${input.configPath} 必须使用 .ts、.mts、.js 或 .mjs 扩展名。`,
    );
  }
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(pathToFileURL(input.configPath).href)) as Record<
      string,
      unknown
    >;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = hasCode(error, "ENOENT")
      ? "config-not-found"
      : "config-load-failed";
    throw new MaintenanceError(
      code,
      `无法加载配置入口 ${input.configPath}：${message}`,
      { cause: error },
    );
  }
  if (!Object.hasOwn(loaded, "default")) {
    throw new MaintenanceError(
      "config-export-missing",
      `配置入口 ${input.configPath} 必须提供 default 导出。`,
    );
  }

  const defaultRoot = dirname(input.configPath);
  try {
    const result = await operateConfig(
      input.operation,
      loaded.default,
      defaultRoot,
      input.scope,
      input.configPath,
    );
    return { ok: true, result };
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new MaintenanceError(
      "maintenance-failed",
      `配置入口 ${input.configPath} 的维护操作失败：${message}`,
      { cause: error },
    );
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

if (parentPort === null) {
  throw new Error("配置维护 Worker 缺少消息端口。");
}

try {
  parentPort.postMessage(await run());
} catch (error) {
  parentPort.postMessage({
    ok: false,
    code: error instanceof MaintenanceError ? error.code : "maintenance-failed",
    message: error instanceof Error ? error.message : String(error),
  } satisfies WorkerMessage);
}
