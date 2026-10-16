import { writeFileSync } from "node:fs";

import { captureVitestCandidate } from "./event-mapper.ts";

type ReporterContext = {
  readonly version?: unknown;
  readonly config?: {
    readonly root?: unknown;
    readonly watch?: unknown;
    readonly dangerouslyIgnoreUnhandledErrors?: unknown;
  };
  readonly logger?: { error?: (...arguments_: unknown[]) => unknown };
  close?: (...arguments_: unknown[]) => unknown;
};

/** 官方 CLI reporter：在原生 close 完成后写出本次操作的临时收据。 */
export default class DockVitestReporter {
  #candidate: ReturnType<typeof captureVitestCandidate> | undefined;
  #closeErrors: string[] = [];
  #enabled = false;
  #root = "";
  #version = "";
  #runEndCount = 0;
  #receiptWritten = false;
  #closeFinished = false;

  onInit(contextValue: unknown): void {
    if (process.env.DOCK_VITEST_RECEIPT === undefined) return;
    this.#enabled = true;
    if (!isRecord(contextValue)) {
      throw new TypeError("Vitest reporter 没有收到原生运行上下文。");
    }
    const context = contextValue as ReporterContext;
    if (
      typeof context.version !== "string" ||
      typeof context.config?.root !== "string"
    ) {
      throw new TypeError("Vitest reporter 缺少版本或 root 上下文。");
    }
    this.#version = context.version;
    this.#root = context.config.root;
    if (!new Set(["4.1.11", "5.0.3"]).has(this.#version)) {
      throw new TypeError(`尚未验证 Vitest ${this.#version}。`);
    }
    if (
      context.config.watch === true ||
      context.config.dangerouslyIgnoreUnhandledErrors === true
    ) {
      throw new TypeError("Dock Vitest 维护只支持单次运行和原生错误处理。");
    }

    const logger = context.logger;
    if (typeof logger?.error !== "function") {
      throw new TypeError("Vitest logger 无法报告共同关闭错误。");
    }
    const originalError = logger.error.bind(logger);
    logger.error = (...arguments_: unknown[]) => {
      if (arguments_[0] === "error during close") {
        this.#closeErrors.push(
          arguments_.slice(1).map(errorMessage).join("；"),
        );
      }
      return originalError(...arguments_);
    };

    if (typeof context.close !== "function") {
      throw new TypeError("Vitest 上下文没有公开 close 方法。");
    }
    const originalClose = context.close.bind(context);
    context.close = async (...arguments_: unknown[]) => {
      try {
        const result = await originalClose(...arguments_);
        this.#closeFinished = true;
        return result;
      } catch (error) {
        this.#closeErrors.push(errorMessage(error));
        throw error;
      }
    };
    process.once("beforeExit", () => this.#writeReceipt());
  }

  onTestRunEnd(
    modules: unknown,
    unhandledErrors: unknown,
    reason: unknown,
  ): void {
    if (!this.#enabled) return;
    this.#runEndCount += 1;
    if (this.#runEndCount > 1) {
      this.#closeErrors.push("Vitest 在单次维护中结束了多次测试运行。");
      return;
    }
    this.#candidate = captureVitestCandidate(
      modules,
      unhandledErrors,
      reason,
      this.#version,
      this.#root,
    );
  }

  #writeReceipt(): void {
    if (!this.#enabled || this.#receiptWritten) return;
    this.#receiptWritten = true;
    const path = process.env.DOCK_VITEST_RECEIPT;
    if (path === undefined) return;
    writeFileSync(
      path,
      `${JSON.stringify({
        version: this.#version,
        closed: this.#closeFinished,
        candidate: this.#candidate,
        closeErrors: this.#closeErrors,
      })}\n`,
      "utf8",
    );
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
