import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import type { ExecutionRunRecord } from "@dock/sdk";

import { collectNodeRun } from "./event-mapper.ts";
import type {
  NodeEvent,
  NodeSelectedTest,
  NormalizedNodeRun,
} from "./types.ts";

const diagnosticLimit = 8_192;

/** 通过 Node 原生 `--test` 执行一次声明，并只读取其 reporter 事件流。 */
export async function executeNodeTestRun(
  run: NormalizedNodeRun,
  selectedTests: readonly NodeSelectedTest[],
): Promise<ExecutionRunRecord> {
  const reporterPath = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./node-reporter.ts"
        : "./node-reporter.js",
      import.meta.url,
    ),
  );
  const arguments_ = [
    "--test",
    `--test-reporter=${reporterPath}`,
    "--test-reporter-destination=stdout",
    ...(run.namePattern === undefined
      ? []
      : [`--test-name-pattern=${run.namePattern}`]),
    ...run.files,
  ];
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;

  return await new Promise<ExecutionRunRecord>((resolve) => {
    const events: NodeEvent[] = [];
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let protocolError: string | undefined;
    let processError: string | undefined;
    let stderr = "";
    let child: ReturnType<typeof spawn>;

    try {
      child = spawn(process.execPath, arguments_, {
        cwd: run.root,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve(
        collectNodeRun(events, {
          testRoot: run.testRoot,
          files: run.files,
          ...(run.namePattern === undefined
            ? {}
            : { namePattern: run.namePattern }),
          selectedTests,
          exitCode: null,
          signal: null,
          processError: errorMessage(error),
        }),
      );
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      pending += decoder.write(chunk);
      pending = consumeLines(pending, events, (message) => {
        protocolError ??= message;
      });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < diagnosticLimit) {
        stderr += chunk
          .toString("utf8")
          .slice(0, diagnosticLimit - stderr.length);
      }
    });
    child.on("error", (error) => {
      processError = error.message;
    });
    child.on("close", (code, signal) => {
      pending += decoder.end();
      pending = consumeLines(pending, events, (message) => {
        protocolError ??= message;
      });
      if (pending.trim() !== "") {
        consumeLine(pending, events, (message) => {
          protocolError ??= message;
        });
      }
      const hasFinalSummary = events.some(
        (event) =>
          event.type === "test:summary" && event.data?.entryFile === undefined,
      );
      if (processError === undefined && code !== 0 && !hasFinalSummary) {
        const detail = stderr.trim();
        processError =
          detail || `Node 测试命令提前以退出码 ${String(code)} 结束。`;
      }
      resolve(
        collectNodeRun(events, {
          testRoot: run.testRoot,
          files: run.files,
          ...(run.namePattern === undefined
            ? {}
            : { namePattern: run.namePattern }),
          selectedTests,
          exitCode: code,
          signal,
          ...(processError === undefined ? {} : { processError }),
          ...(protocolError === undefined ? {} : { protocolError }),
        }),
      );
    });
  });
}

function consumeLines(
  input: string,
  events: NodeEvent[],
  onError: (message: string) => void,
): string {
  let start = 0;
  for (
    let index = input.indexOf("\n");
    index !== -1;
    index = input.indexOf("\n", start)
  ) {
    consumeLine(input.slice(start, index), events, onError);
    start = index + 1;
  }
  return input.slice(start);
}

function consumeLine(
  line: string,
  events: NodeEvent[],
  onError: (message: string) => void,
): void {
  if (line.trim() === "") return;
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    onError(`Node 原生 reporter 输出了无效 JSON：${errorMessage(error)}`);
    return;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { type?: unknown }).type !== "string"
  ) {
    onError("Node 原生 reporter 输出了不符合事件形状的数据。");
    return;
  }
  const event = value as NodeEvent;
  if (event.data !== undefined && !isRecord(event.data)) {
    onError("Node 原生 reporter 事件的 data 字段不是对象。");
    return;
  }
  events.push(event);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
