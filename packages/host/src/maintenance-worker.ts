import { dirname, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

import {
  MaintenanceError,
  operateConfig,
  operateConfigWithLineRanges,
  type Operation,
  type MaintenanceScope,
  type WorkerMessage,
} from "./maintenance.ts";

type WorkerInput = {
  readonly operation: Operation;
  readonly configPath: string;
  readonly scope?: MaintenanceScope;
  readonly collectLineRanges?: boolean;
};

async function run(): Promise<WorkerMessage> {
  const input = workerData as WorkerInput;
  if (!new Set([".ts", ".mts", ".js", ".mjs"]).has(extname(input.configPath))) {
    throw new MaintenanceError(
      "config-extension-unsupported",
      `Config entry ${input.configPath} must use a .ts, .mts, .js, or .mjs extension.`,
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
      `Failed to load config entry ${input.configPath}: ${message}`,
      { cause: error },
    );
  }
  if (!Object.hasOwn(loaded, "default")) {
    throw new MaintenanceError(
      "config-export-missing",
      `Config entry ${input.configPath} must provide a default export.`,
    );
  }

  const defaultRoot = dirname(input.configPath);
  try {
    const result = input.collectLineRanges
      ? await operateConfigWithLineRanges(
          input.operation,
          loaded.default,
          defaultRoot,
          input.scope,
          input.configPath,
        )
      : await operateConfig(
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
      `Maintenance operation failed for config entry ${input.configPath}: ${message}`,
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
  throw new Error("Config maintenance worker is missing a message port.");
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
