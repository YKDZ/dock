import { accessSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createReference, definePlugin } from "@dock/sdk";
import type {
  ExecutionRunRecord,
  JsonValue,
  PluginExecutionContext,
  PluginResult,
  Reference,
  ReferenceOptions,
  ReferencePlugin,
} from "@dock/sdk";

import { testIdentity } from "./event-mapper.ts";
import { executeVitestRun } from "./native-runner.ts";
import type {
  NormalizedVitestRun,
  SelectedVitestTest,
} from "./native-runner.ts";

export const vitestPluginId = "@dock/reference-vitest" as const;

export type VitestRun = {
  readonly identity: string;
  readonly files: [string, ...string[]];
  /** 扩大本次原生筛选的目标；它们不是必须成功的状态引用。 */
  readonly additionalTests?: VitestTestSelection[];
  readonly testRoot?: string;
  readonly configFile?: string;
};

export type VitestRunOptions = {
  readonly files: readonly [string, ...string[]];
  /** 只选择 run.files 中的附加测试，不要求它们成功。 */
  readonly additionalTests?: readonly VitestTestSelection[];
  readonly testRoot?: string;
  readonly configFile?: string;
};

export type VitestTestSelection = {
  /** 必须是此运行声明中的测试文件。 */
  readonly file: string;
  /** 完整原生测试标题。 */
  readonly name: string;
};

export type VitestStatusValue = { readonly status: "passed" };

export type VitestStatusTarget = {
  readonly kind: "vitest-test-status";
  readonly run: VitestRun;
  readonly file: string;
  readonly name: string;
};

export type VitestStatusReference<Id extends string = string> = Reference<
  typeof vitestPluginId,
  Id,
  VitestStatusTarget,
  VitestStatusValue,
  never
>;

/** 类型化地声明一次 Vitest 原生运行；声明阶段不启动测试。 */
export function defineVitestRun(
  identity: string,
  options: VitestRunOptions,
): VitestRun {
  assertRun(identity, options);
  return {
    identity,
    files: [...options.files],
    ...(options.additionalTests === undefined
      ? {}
      : {
          additionalTests: options.additionalTests.map(({ file, name }) => ({
            file,
            name,
          })),
        }),
    ...(options.testRoot === undefined ? {} : { testRoot: options.testRoot }),
    ...(options.configFile === undefined
      ? {}
      : { configFile: options.configFile }),
  };
}

/** 声明一条依赖 Vitest 最终成功状态的引用。 */
export function vitestStatus<Id extends string>(
  id: Id,
  run: VitestRun,
  target: { readonly file: string; readonly name: string },
  options: Pick<ReferenceOptions, "declaredAt" | "note"> = {},
): VitestStatusReference<Id> {
  assertRun(run.identity, run);
  assertTestSelection(target);
  return createReference<
    typeof vitestPluginId,
    Id,
    VitestStatusTarget,
    VitestStatusValue,
    never
  >(
    vitestPluginId,
    id,
    {
      kind: "vitest-test-status",
      run,
      file: target.file,
      name: target.name,
    },
    {
      ...(options.declaredAt === undefined
        ? {}
        : { declaredAt: options.declaredAt }),
      ...(options.note === undefined ? {} : { note: options.note }),
    },
  );
}

type VitestPlugin = ReferencePlugin<
  typeof vitestPluginId,
  VitestStatusReference,
  VitestStatusValue
>;

const vitestImplementation: VitestPlugin = definePlugin({
  id: vitestPluginId,
  validate(reference: VitestStatusReference): void {
    if (reference.selection !== undefined) {
      throw new TypeError("Vitest 测试状态引用不支持 selection。");
    }
    assertRun(reference.target.run.identity, reference.target.run);
    assertTestTarget(reference.target);
  },
  async prepare(
    references: readonly VitestStatusReference[],
    context: PluginExecutionContext,
  ): Promise<void> {
    const groups = new Map<
      string,
      {
        readonly run: NormalizedVitestRun;
        readonly targets: SelectedVitestTest[];
      }
    >();
    for (const reference of references) {
      const target = reference.target;
      const run = normalizeRun(target.run, context.root);
      const groupKey = `${run.identity}\0${JSON.stringify(run.configuration)}`;
      const group = groups.get(groupKey) ?? {
        run,
        targets: [...run.additionalTests],
      };
      group.targets.push({
        file: resolveTargetFile(run.testRoot, target.file),
        name: target.name,
      });
      groups.set(groupKey, group);
    }
    for (const { run, targets } of groups.values()) {
      context.execution.register(
        run.identity,
        run.configuration,
        async () => await executeVitestRun(run, uniqueSelectedTests(targets)),
      );
    }
  },
  collect(
    reference: VitestStatusReference,
    context: PluginExecutionContext,
  ): PluginResult<VitestStatusValue> {
    const run = context.execution.get(reference.target.run.identity);
    if (run === undefined) {
      return {
        kind: "error",
        error: {
          code: "execution-record-missing",
          message: `Vitest 执行 ${reference.target.run.identity} 没有完成当前维护会话。`,
        },
      };
    }
    return factFromVitestRun(
      reference,
      run,
      resolveTestRoot(reference.target.run, context.root),
    );
  },
});

export const vitest = vitestImplementation;

function normalizeRun(run: VitestRun, root: string): NormalizedVitestRun {
  const testRoot = resolvePath(root, run.testRoot ?? ".");
  const files = [
    ...new Set(run.files.map((file) => resolvePath(testRoot, file))),
  ].sort();
  const fileSet = new Set(files);
  const additionalTests = uniqueSelectedTests(
    (run.additionalTests ?? []).map(({ file, name }) => ({
      file: resolveTargetFile(testRoot, file),
      name,
    })),
  ).sort(compareSelectedTests);
  if (additionalTests.some((selection) => !fileSet.has(selection.file))) {
    throw new TypeError(
      "Vitest 的 additionalTests 必须选择 run.files 中的测试文件。",
    );
  }
  const configFile = resolveConfigFile(root, run.configFile, testRoot);
  const configuration: JsonValue = {
    framework: vitestPluginId,
    root,
    testRoot,
    files,
    ...(additionalTests.length === 0 ? {} : { additionalTests }),
    ...(configFile === undefined ? {} : { configFile }),
  };
  return {
    identity: run.identity,
    root,
    testRoot,
    files,
    additionalTests,
    ...(configFile === undefined ? {} : { configFile }),
    configuration: configuration as NormalizedVitestRun["configuration"],
  };
}

function resolveConfigFile(
  root: string,
  configFile: string | undefined,
  testRoot: string,
): string | undefined {
  if (configFile !== undefined) return resolvePath(root, configFile);
  for (const name of [
    "vitest.config.mts",
    "vitest.config.ts",
    "vitest.config.mjs",
    "vitest.config.js",
    "vitest.config.cts",
    "vitest.config.cjs",
    "vite.config.mts",
    "vite.config.ts",
    "vite.config.mjs",
    "vite.config.js",
    "vite.config.cts",
    "vite.config.cjs",
  ]) {
    const candidate = resolve(testRoot, name);
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // 没有常规配置文件时使用空 Vitest 配置。
    }
  }
  return undefined;
}

function factFromVitestRun(
  reference: VitestStatusReference,
  run: ExecutionRunRecord,
  testRoot: string,
): PluginResult<VitestStatusValue> {
  if (run.lifecycle !== "complete" || run.errors.length > 0) {
    const detail = run.errors.map((error) => error.message).join("；");
    return {
      kind: "error",
      error: {
        code: "run-lifecycle-failed",
        message: detail || "Vitest 原生测试没有完整且一致地结束。",
      },
    };
  }

  const targetFile = resolveTargetFile(testRoot, reference.target.file);
  const identity = testIdentity(
    relativeTestFile(testRoot, targetFile),
    reference.target.name,
  );
  const matches = run.tests.filter((test) => test.id === identity);
  if (matches.length === 0) {
    return vitestError(
      "test-not-executed",
      `没有执行声明的 Vitest 测试：${reference.target.file} / ${reference.target.name}。`,
    );
  }
  if (matches.length > 1 || matches[0]?.status === "duplicate") {
    return vitestError(
      "duplicate-test-identity",
      `同一 Vitest 文件中有多个测试匹配身份 ${reference.target.name}。`,
    );
  }

  const test = matches[0];
  if (test?.status === "passed") {
    return { kind: "value", value: { status: "passed" } };
  }
  if (test === undefined) {
    return vitestError("test-not-executed", "没有找到声明的 Vitest 测试。");
  }
  const code =
    test.status === "cancelled"
      ? test.started
        ? "test-cancelled"
        : "test-not-executed"
      : test.status === "skipped"
        ? "test-skipped"
        : test.status === "todo"
          ? "test-todo"
          : test.status === "filtered"
            ? "test-filtered"
            : test.status === "duplicate"
              ? "duplicate-test-identity"
              : test.status === "not-run"
                ? "test-not-executed"
                : "test-failed";
  return vitestError(
    code,
    test.message ?? `关联测试最终状态为 ${test.status}。`,
  );
}

function resolveTestRoot(run: VitestRun, root: string): string {
  return resolvePath(root, run.testRoot ?? ".");
}

function resolveTargetFile(testRoot: string, file: string): string {
  return resolvePath(testRoot, file);
}

function relativeTestFile(testRoot: string, file: string): string {
  return importRelative(testRoot, file).split("\\").join("/");
}

function importRelative(root: string, file: string): string {
  return relative(root, file);
}

function uniqueSelectedTests(
  targets: readonly SelectedVitestTest[],
): SelectedVitestTest[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const identity = `${target.file}\0${target.name}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function compareSelectedTests(
  left: SelectedVitestTest,
  right: SelectedVitestTest,
): number {
  const fileOrder = compareStrings(left.file, right.file);
  return fileOrder === 0 ? compareStrings(left.name, right.name) : fileOrder;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resolvePath(root: string, path: string): string {
  return path.startsWith("file:")
    ? fileURLToPath(new URL(path))
    : isAbsolute(path)
      ? resolve(path)
      : resolve(root, path);
}

function assertRun(
  identity: unknown,
  value: unknown,
): asserts value is VitestRun {
  if (
    typeof identity !== "string" ||
    identity.length === 0 ||
    !isRecord(value) ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    !value.files.every(isNonEmptyString) ||
    (value.testRoot !== undefined && !isNonEmptyString(value.testRoot)) ||
    (value.configFile !== undefined && !isNonEmptyString(value.configFile))
  ) {
    throw new TypeError(
      "Vitest 测试运行必须提供身份、至少一个测试文件和有效选项。",
    );
  }
  if (
    value.additionalTests !== undefined &&
    (!Array.isArray(value.additionalTests) ||
      !value.additionalTests.every(isVitestTestSelection))
  ) {
    throw new TypeError(
      "Vitest additionalTests 必须提供有效文件和完整测试标题。",
    );
  }
}

function isVitestTestSelection(value: unknown): value is VitestTestSelection {
  return (
    isRecord(value) &&
    isNonEmptyString(value.file) &&
    isNonEmptyString(value.name)
  );
}

function assertTestTarget(value: unknown): asserts value is VitestStatusTarget {
  if (
    !isRecord(value) ||
    value.kind !== "vitest-test-status" ||
    !isRecord(value.run) ||
    !isNonEmptyString(value.file) ||
    !isNonEmptyString(value.name)
  ) {
    throw new TypeError("Vitest 状态引用必须提供有效文件和完整测试标题。");
  }
  assertRun(value.run.identity, value.run);
  assertTestSelection(value);
}

function assertTestSelection(
  value: unknown,
): asserts value is { readonly file: string; readonly name: string } {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.file) ||
    !isNonEmptyString(value.name)
  ) {
    throw new TypeError("Vitest 状态引用必须提供有效文件和完整测试标题。");
  }
}

function vitestError(
  code: string,
  message: string,
): PluginResult<VitestStatusValue> {
  return { kind: "error", error: { code, message } };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
