import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type ProcessResult = {
  readonly code: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDirectory = join(
  packageDirectory,
  "fixtures",
  "installed-consumer",
  "current-config",
);
const dependencyFixture = join(
  packageDirectory,
  "fixtures",
  "installed-consumer",
  "current-config-dependency",
);

export async function verifyInstalledCurrentConfig(
  consumer: string,
): Promise<void> {
  const scenario = await mkdtemp(join(consumer, "current-config-consumer-"));
  const fixture = join(scenario, "fixture");
  try {
    await cp(fixtureDirectory, fixture, { recursive: true });
    const dependencyDirectory = join(
      fixture,
      "node_modules",
      "current-config-declarations",
    );
    await mkdir(dirname(dependencyDirectory), { recursive: true });
    await cp(dependencyFixture, dependencyDirectory, { recursive: true });

    const result = await runConsumer(join(fixture, "runner.mjs"), fixture);
    assert.equal(
      result.timedOut,
      false,
      `当前声明消费者未能自然退出，可能仍有操作资源存活：\n${result.stdout}\n${result.stderr}`,
    );
    assert.equal(
      result.code,
      0,
      `当前声明安装消费者失败：\n${result.stdout}\n${result.stderr}`,
    );
  } finally {
    await rm(scenario, { recursive: true, force: true });
  }
}

function runConsumer(entry: string, cwd: string): Promise<ProcessResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, [entry], { cwd });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 10_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectResult(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveResult({
        code: code ?? 1,
        signal,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}
