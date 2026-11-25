import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { collectInstalledPackageNames } from "./npm-ls.ts";

export type ProcessResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

export type CliEnvelope = {
  readonly schemaVersion: string;
  readonly command?: string;
  readonly outputMode?: string;
  readonly kind: string;
  readonly variant?: string;
  readonly data?: {
    readonly code?: string;
    readonly message?: string;
    readonly report?: unknown;
    readonly resolution?: unknown;
    readonly errors?: readonly {
      readonly code: string;
      readonly message: string;
    }[];
  };
  readonly issues?: readonly {
    readonly code: string;
    readonly option?: string;
  }[];
};

export const packageDirectory = dirname(
  dirname(fileURLToPath(import.meta.url)),
);

export const hostCompiler = join(
  packageDirectory,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc",
);

export function dockBin(consumer: string): string {
  return join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "dock.cmd" : "dock",
  );
}

/** Installs npm packages into an isolated consumer directory using the offline cache first. */
export async function installConsumer(
  consumer: string,
  packages: readonly string[],
  name: string,
): Promise<void> {
  await mkdir(consumer, { recursive: true });
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name, private: true, type: "module" }),
  );
  const install = await run(
    "npm",
    [
      "install",
      "--prefix",
      consumer,
      "--no-save",
      "--no-package-lock",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      ...packages,
    ],
    consumer,
    360_000,
  );
  assert.equal(
    install.code,
    0,
    `Clean tarball installation failed (signal=${install.signal}, timedOut=${install.timedOut}):\n${install.stdout}\n${install.stderr}`,
  );
}

/** Verifies none of the forbidden packages exist in the consumer's `npm ls` tree. */
export async function assertForbiddenDependencies(
  consumer: string,
  forbidden: readonly string[],
  contextLabel: string,
): Promise<Set<string>> {
  const listing = await run(
    "npm",
    ["ls", "--all", "--json", "--prefix", consumer],
    consumer,
  );
  assert.equal(listing.code, 0, listing.stderr);
  const names = collectInstalledPackageNames(
    JSON.parse(listing.stdout) as unknown,
  );
  for (const dependency of forbidden) {
    assert.equal(
      names.has(dependency),
      false,
      `${contextLabel} must not depend on ${dependency}`,
    );
  }
  for (const name of names) {
    assert.equal(
      name.startsWith("@dock/"),
      false,
      `${contextLabel} must not install internal workspace package ${name}`,
    );
  }
  return names;
}

export function parseEnvelope(output: string): CliEnvelope {
  const envelope = JSON.parse(output) as CliEnvelope;
  assert.equal(envelope.schemaVersion, "3", output);
  if (envelope.kind !== "usageFailure") {
    assert.equal(envelope.outputMode, "structured", output);
  }
  return envelope;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function run(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  timeoutMs = 60_000,
  env: NodeJS.ProcessEnv = {},
): Promise<ProcessResult> {
  return new Promise((resolveResult, rejectResult) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...arguments_], {
        cwd,
        detached: process.platform !== "win32",
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      rejectResult(error);
      return;
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      if (process.platform !== "win32" && child.pid !== undefined) {
        process.kill(-child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectResult(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ code, signal, stdout, stderr, timedOut });
    });
  });
}
