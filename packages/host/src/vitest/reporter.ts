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

/** Official CLI reporter: writes the temporary receipt for this operation after native close completes. */
export default class DockVitestReporter {
  #candidate: ReturnType<typeof captureVitestCandidate> | undefined;
  #closeErrors: string[] = [];
  #enabled = false;
  #root = "";
  #version = "";
  #requestedFiles: readonly string[] = [];
  #runEndCount = 0;
  #receiptWritten = false;
  #closeFinished = false;

  onInit(contextValue: unknown): void {
    if (process.env.DOCK_VITEST_RECEIPT === undefined) return;
    this.#enabled = true;
    if (!isRecord(contextValue)) {
      throw new TypeError(
        "Vitest reporter did not receive a native run context.",
      );
    }
    const context = contextValue as ReporterContext;
    if (
      typeof context.version !== "string" ||
      typeof context.config?.root !== "string"
    ) {
      throw new TypeError(
        "Vitest reporter is missing version or root in context.",
      );
    }
    this.#version = context.version;
    this.#root = context.config.root;
    this.#requestedFiles = parseRequestedFiles(
      process.env.DOCK_VITEST_REQUESTED_FILES,
    );
    if (!new Set(["4.1.11", "5.0.3"]).has(this.#version)) {
      throw new TypeError(`Vitest ${this.#version} has not been verified.`);
    }
    if (
      context.config.watch === true ||
      context.config.dangerouslyIgnoreUnhandledErrors === true
    ) {
      throw new TypeError(
        "Dock Vitest maintenance only supports single runs with native error handling.",
      );
    }

    const logger = context.logger;
    if (typeof logger?.error !== "function") {
      throw new TypeError(
        "Vitest logger cannot report shared close errors.",
      );
    }
    const originalError = logger.error.bind(logger);
    logger.error = (...arguments_: unknown[]) => {
      if (arguments_[0] === "error during close") {
        this.#closeErrors.push(
          arguments_.slice(1).map(errorMessage).join("; "),
        );
      }
      return originalError(...arguments_);
    };

    if (typeof context.close !== "function") {
      throw new TypeError("Vitest context does not expose a close method.");
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
      this.#closeErrors.push(
        "Vitest ended multiple test runs during a single maintenance operation.",
      );
      return;
    }
    this.#candidate = captureVitestCandidate(
      modules,
      unhandledErrors,
      reason,
      this.#version,
      this.#root,
      this.#requestedFiles,
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

function parseRequestedFiles(value: string | undefined): string[] {
  if (value === undefined) {
    throw new TypeError("Vitest reporter is missing the declared file list.");
  }
  let files: unknown;
  try {
    files = JSON.parse(value) as unknown;
  } catch {
    throw new TypeError("Vitest reporter received an invalid declared file list.");
  }
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    !files.every(
      (file) => typeof file === "string" && file.length > 0 && isAbsolute(file),
    )
  ) {
    throw new TypeError("Vitest reporter received an invalid declared file list.");
  }
  return files;
}

function isAbsolute(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}
