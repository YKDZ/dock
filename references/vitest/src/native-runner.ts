import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ExecutionRunRecord } from "@dock/sdk";
import type { JsonValue } from "@dock/sdk";

import { mapVitestRun } from "./event-mapper.ts";
import type { VitestProcessResult } from "./event-mapper.ts";

export type NormalizedVitestRun = {
  readonly identity: string;
  readonly root: string;
  readonly testRoot: string;
  readonly files: readonly string[];
  readonly additionalTests: readonly SelectedVitestTest[];
  readonly configFile?: string;
  readonly configuration: JsonValue;
};

export type SelectedVitestTest = {
  readonly file: string;
  readonly name: string;
};

type ChildResult = VitestProcessResult & {
  readonly stdout: string;
  readonly stderr: string;
};

const supportedVersions = new Set(["4.1.11", "5.0.3"]);
const diagnosticLimit = 16_384;

/** 通过官方 Vitest CLI 单次运行，并只在完整 close 后接收收据。 */
export async function executeVitestRun(
  run: NormalizedVitestRun,
  selectedTests: readonly SelectedVitestTest[],
  allInFiles = false,
): Promise<ExecutionRunRecord> {
  const temporary = await mkdtemp(join(tmpdir(), "dock-vitest-run-"));
  const receiptPath = join(temporary, "receipt.json");
  const configPath = join(temporary, "vitest.config.mjs");
  try {
    const installation = installedVitest(run.testRoot);
    if (!supportedVersions.has(installation.version)) {
      return incompleteRun(
        "vitest-version-unsupported",
        `尚未验证 Vitest ${installation.version}。`,
      );
    }
    const names = selectedNames(selectedTests);
    if (names.length === 0 && !allInFiles) {
      return incompleteRun(
        "vitest-selection-empty",
        "运行配置中的 testNamePattern 排除了全部声明测试。",
      );
    }
    await writeFile(
      configPath,
      createOverlayConfig({
        ...(run.configFile === undefined
          ? {}
          : { userConfigPath: run.configFile }),
        root: run.testRoot,
        names,
        allInFiles,
        setupPath: internalFile("setup"),
        reporterPath: internalFile("reporter"),
      }),
      "utf8",
    );
    const environment = { ...process.env };
    environment.DOCK_VITEST_RECEIPT = receiptPath;
    environment.DOCK_VITEST_REQUESTED_FILES = JSON.stringify(run.files);
    const arguments_ = [
      installation.cliPath,
      "run",
      "--root",
      run.testRoot,
      "--config",
      configPath,
      ...run.files,
    ];
    const processResult = await runProcess(
      process.execPath,
      arguments_,
      run.root,
      environment,
    );
    let receipt: unknown;
    try {
      receipt = JSON.parse(await readFile(receiptPath, "utf8")) as unknown;
    } catch (error) {
      const result = mapVitestRun(undefined, {
        code: processResult.code,
        signal: processResult.signal,
        error:
          processResult.error ??
          `Vitest 原生收据缺失或损坏：${errorMessage(error)}${processResult.stderr ? `\n${processResult.stderr}` : ""}`,
      });
      return result;
    }
    return mapVitestRun(receipt, processResult);
  } catch (error) {
    return incompleteRun("vitest-runner-failed", errorMessage(error));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function installedVitest(testRoot: string): {
  readonly version: string;
  readonly cliPath: string;
} {
  const requireFromRoot = createRequire(resolve(testRoot, "package.json"));
  const packageJsonPath = requireFromRoot.resolve("vitest/package.json");
  const packageJson = requireFromRoot(packageJsonPath) as {
    readonly version: string;
  };
  return {
    version: packageJson.version,
    cliPath: join(dirname(packageJsonPath), "vitest.mjs"),
  };
}

function selectedNames(selectedTests: readonly SelectedVitestTest[]): string[] {
  return [...new Set(selectedTests.map((test) => test.name))];
}

function createOverlayConfig(options: {
  readonly userConfigPath?: string;
  readonly root: string;
  readonly names: readonly string[];
  readonly allInFiles: boolean;
  readonly setupPath: string;
  readonly reporterPath: string;
}): string {
  const userConfigUrl =
    options.userConfigPath === undefined
      ? undefined
      : pathToFileURL(options.userConfigPath).href;
  return `
const userModule = ${userConfigUrl === undefined ? "undefined" : `await import(${JSON.stringify(userConfigUrl)})`};
let userConfig = userModule?.default ?? {};
if (typeof userConfig === "function") {
  userConfig = await userConfig({ command: "serve", mode: "test" });
}
if (!userConfig || typeof userConfig !== "object" || Array.isArray(userConfig)) {
  throw new TypeError("Vitest 配置必须导出单一配置对象。");
}
const userTest = userConfig.test ?? {};
const setupFiles = Array.isArray(userTest.setupFiles)
  ? userTest.setupFiles
  : userTest.setupFiles === undefined ? [] : [userTest.setupFiles];
const reporters = Array.isArray(userTest.reporters)
  ? userTest.reporters
  : userTest.reporters === undefined ? ["default"] : [userTest.reporters];
const configuredPattern = userTest.testNamePattern;
const selectedTargets = ${JSON.stringify(
    options.names.map((name) => {
      const filterName = name.replaceAll(" > ", " ");
      return {
        name,
        filterName,
        patterns: [...new Set([name, filterName])].map(escapeRegExp),
      };
    }),
  )};
const selectedPatterns = [...new Set(selectedTargets.filter(({ name, filterName }) => {
  if (configuredPattern === undefined) return true;
  const pattern = configuredPattern instanceof RegExp
    ? configuredPattern
    : new RegExp(configuredPattern);
  pattern.lastIndex = 0;
  const matchesReportedTitle = pattern.test(name);
  pattern.lastIndex = 0;
  return matchesReportedTitle || pattern.test(filterName);
}).flatMap(({ patterns }) => patterns))];
const testNamePattern = selectedPatterns.length === 0
  ? "^(?!)$"
  : "^(?:" + selectedPatterns.join("|") + ")$";
export default {
  ...userConfig,
  root: ${JSON.stringify(options.root)},
  test: {
    ...userTest,
    watch: false,
    dangerouslyIgnoreUnhandledErrors: false,
    // 允许已发现的空原生 suite；声明文件和必需成员由目录映射单独验证。
    passWithNoTests: true,
    ${options.allInFiles ? "" : "testNamePattern,"}
    setupFiles: [...setupFiles, ${JSON.stringify(options.setupPath)}],
    reporters: [...reporters, ${JSON.stringify(options.reporterPath)}],
  },
};
`;
}

async function runProcess(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<ChildResult> {
  return await new Promise<ChildResult>((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let processError: string | undefined;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, arguments_, {
        cwd,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolveResult({
        code: null,
        signal: null,
        error: errorMessage(error),
        stdout,
        stderr,
      });
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < diagnosticLimit) {
        stdout += chunk
          .toString("utf8")
          .slice(0, diagnosticLimit - stdout.length);
      }
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
      resolveResult({
        code,
        signal,
        ...(processError === undefined ? {} : { error: processError }),
        stdout,
        stderr,
      });
    });
  });
}

function internalFile(name: "setup" | "reporter"): string {
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return fileURLToPath(new URL(`./${name}${extension}`, import.meta.url));
}

function incompleteRun(code: string, message: string): ExecutionRunRecord {
  return {
    lifecycle: "incomplete",
    commandAttempts: 0,
    testExecutions: 0,
    tests: [],
    errors: [{ code, message }],
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
