import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createReference, definePlugin } from "@dock/sdk";
import type {
  JsonValue,
  PluginContext,
  PluginExecutionContext,
  PluginExecutionIdentity,
  PluginResult,
  Reference,
  ReferenceOptions,
  ReferencePlugin,
} from "@dock/sdk";

import { executeNodeTestRun } from "./native-runner.ts";
import { beginExecution } from "./test-context.ts";
import type {
  NodeEventTarget,
  NodeSelectedTest,
  NormalizedNodeRun,
} from "./types.ts";

export const nodeTestPluginId = "@dock/reference-node-test" as const;

export type NodeTestRun = {
  readonly identity: string;
  readonly files: [string, ...string[]];
  readonly testRoot?: string;
  readonly namePattern?: string;
};

export type NodeTestRunOptions = {
  readonly files: readonly [string, ...string[]];
  readonly testRoot?: string;
  readonly namePattern?: string;
};

export type NodeTestValue = { readonly status: "passed" };

export type NodeTestTarget = {
  readonly kind: "node-test-status";
  readonly run: NodeTestRun;
  readonly file: string;
  readonly name: string;
};

export type NodeTestReference<Id extends string = string> = Reference<
  typeof nodeTestPluginId,
  Id,
  NodeTestTarget,
  NodeTestValue,
  never
>;

/** 类型化地声明一次 Node 原生运行，不在声明时启动测试进程。 */
export function defineNodeTestRun(
  identity: string,
  options: NodeTestRunOptions,
): NodeTestRun {
  assertRun(identity, options);
  return {
    identity,
    files: [...options.files],
    ...(options.testRoot === undefined ? {} : { testRoot: options.testRoot }),
    ...(options.namePattern === undefined
      ? {}
      : { namePattern: options.namePattern }),
  };
}

/** 声明一条依赖原生测试成功终态的引用。 */
export function nodeTestStatus<Id extends string>(
  id: Id,
  run: NodeTestRun,
  target: { readonly file: string; readonly name: string },
  options: Pick<ReferenceOptions, "declaredAt" | "note"> = {},
): NodeTestReference<Id> {
  assertRun(run.identity, run);
  assertTestSelection(target);
  return createReference<
    typeof nodeTestPluginId,
    Id,
    NodeTestTarget,
    NodeTestValue,
    never
  >(
    nodeTestPluginId,
    id,
    {
      kind: "node-test-status",
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

type NodeTestPlugin = ReferencePlugin<
  typeof nodeTestPluginId,
  NodeTestReference,
  NodeTestValue
>;

const nodeTestImplementation: NodeTestPlugin = definePlugin({
  id: nodeTestPluginId,
  validate(reference: NodeTestReference): void {
    if (reference.selection !== undefined) {
      throw new TypeError("Node 测试状态引用不支持 selection。");
    }
    assertRun(reference.target.run.identity, reference.target.run);
    assertTestTarget(reference.target);
  },
  fileInfo(reference: NodeTestReference, context: PluginContext): string {
    const run = normalizeRun(reference.target.run, context.root);
    return resolveTargetFile(run.testRoot, reference.target.file);
  },
  validateReferences(
    references: readonly NodeTestReference[],
    context: PluginContext,
  ): readonly PluginExecutionIdentity[] {
    const declarations = new Map<
      string,
      {
        readonly declaration: PluginExecutionIdentity;
        readonly encoded: string;
      }
    >();
    for (const reference of references) {
      const run = normalizeRun(reference.target.run, context.root);
      const encoded = JSON.stringify(run.configuration);
      const prior = declarations.get(run.identity);
      if (prior !== undefined && prior.encoded !== encoded) {
        throw new TypeError(
          `Node 测试运行身份 ${run.identity} 在完整配置中对应不同设置。`,
        );
      }
      if (prior === undefined) {
        declarations.set(run.identity, {
          declaration: {
            identity: run.identity,
            configuration: run.configuration,
          },
          encoded,
        });
      }
    }
    return [...declarations.values()].map(({ declaration }) => declaration);
  },
  prepare(
    references: readonly NodeTestReference[],
    context: PluginExecutionContext,
  ): void {
    const groups = new Map<
      string,
      { readonly run: NormalizedNodeRun; readonly targets: NodeSelectedTest[] }
    >();
    for (const reference of references) {
      const target = reference.target;
      const run = normalizeRun(target.run, context.root);
      const groupKey = `${run.identity}\0${JSON.stringify(run.configuration)}`;
      const group = groups.get(groupKey) ?? { run, targets: [] };
      group.targets.push({
        file: resolveTargetFile(run.testRoot, target.file),
        name: target.name,
      });
      groups.set(groupKey, group);
    }
    for (const { run, targets } of groups.values()) {
      const selectedTests = uniqueSelectedTests(targets);
      context.execution.register(
        run.identity,
        run.configuration,
        async () => await executeNodeTestRun(run, selectedTests),
      );
    }
  },
  collect(
    reference: NodeTestReference,
    context: PluginExecutionContext,
  ): PluginResult<NodeTestValue> {
    const run = context.execution.get(reference.target.run.identity);
    if (run === undefined) {
      return {
        kind: "error",
        error: {
          code: "execution-record-missing",
          message: `Node 执行 ${reference.target.run.identity} 没有完成当前维护会话。`,
        },
      };
    }
    return factFromNodeRun(
      reference,
      run,
      normalizeRun(reference.target.run, context.root),
    );
  },
});

export const nodeTest = nodeTestImplementation;

/** 在 Node 原生测试回调入口标记实际开始，供取消用例区分是否进入回调。 */
export { beginExecution };

function factFromNodeRun(
  reference: NodeTestReference,
  run: Awaited<ReturnType<typeof executeNodeTestRun>>,
  normalized: NormalizedNodeRun,
): PluginResult<NodeTestValue> {
  if (run.lifecycle !== "complete" || run.errors.length > 0) {
    const detail = run.errors.map((error) => error.message).join("；");
    return {
      kind: "error",
      error: {
        code: "run-lifecycle-failed",
        message: detail || "Node 原生测试没有完整且一致地结束。",
      },
    };
  }

  const targetFile = resolveTargetFile(
    normalized.testRoot,
    reference.target.file,
  );
  const targetIdentity = JSON.stringify({
    file: relative(normalized.testRoot, targetFile).split("\\").join("/"),
    name: reference.target.name,
  });
  const matches = run.tests.filter((test) => test.id === targetIdentity);
  if (matches.length === 0) {
    if (!normalized.files.includes(targetFile)) {
      return nodeError(
        "test-not-executed",
        `运行 ${normalized.identity} 未包含目标文件 ${reference.target.file}。`,
      );
    }
    if (
      normalized.namePattern !== undefined &&
      !new RegExp(normalized.namePattern).test(reference.target.name)
    ) {
      return nodeError(
        "test-filtered",
        `测试 ${reference.target.name} 被 Node 原生名称筛选排除。`,
      );
    }
    return nodeError(
      "test-not-executed",
      `没有执行声明的测试：${reference.target.file} / ${reference.target.name}。`,
    );
  }
  if (matches.length > 1 || matches[0]?.status === "duplicate") {
    return nodeError(
      "duplicate-test-identity",
      `同一文件中有多个测试匹配身份 ${reference.target.name}。`,
    );
  }

  const [test] = matches;
  if (test?.status === "passed") {
    return { kind: "value", value: { status: "passed" } };
  }
  if (test === undefined) {
    return nodeError("test-not-executed", "没有找到声明的 Node 测试。");
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
  return nodeError(code, test.message ?? `关联测试最终状态为 ${test.status}。`);
}

function normalizeRun(run: NodeTestRun, root: string): NormalizedNodeRun {
  const testRoot = resolvePath(root, run.testRoot ?? ".");
  const files = run.files.map((file) => resolvePath(testRoot, file));
  const configuration: JsonValue = {
    framework: nodeTestPluginId,
    root,
    testRoot,
    files,
    ...(run.namePattern === undefined ? {} : { namePattern: run.namePattern }),
  };
  return {
    identity: run.identity,
    root,
    testRoot,
    files,
    ...(run.namePattern === undefined ? {} : { namePattern: run.namePattern }),
    configuration,
  };
}

function resolveTargetFile(testRoot: string, file: string): string {
  return resolvePath(testRoot, file);
}

function uniqueSelectedTests(
  targets: readonly NodeSelectedTest[],
): NodeSelectedTest[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const identity = `${target.file}\0${target.name}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
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
): asserts value is NodeTestRun {
  if (
    typeof identity !== "string" ||
    identity.length === 0 ||
    !isRecord(value) ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    !value.files.every(isNonEmptyString) ||
    (value.testRoot !== undefined && !isNonEmptyString(value.testRoot)) ||
    (value.namePattern !== undefined && typeof value.namePattern !== "string")
  ) {
    throw new TypeError(
      "Node 测试运行必须提供身份、至少一个测试文件和有效选项。",
    );
  }
  if (value.namePattern !== undefined) {
    try {
      new RegExp(value.namePattern);
    } catch (error) {
      throw new TypeError(
        `Node 测试 namePattern 无效：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}

function assertTestTarget(value: unknown): asserts value is NodeEventTarget {
  if (
    !isRecord(value) ||
    value.kind !== "node-test-status" ||
    !isRecord(value.run) ||
    typeof value.file !== "string" ||
    value.file.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0
  ) {
    throw new TypeError("Node 测试状态引用必须提供有效文件和测试名称。");
  }
  assertRun(value.run.identity, value.run);
  assertTestSelection(value);
}

function assertTestSelection(value: unknown): asserts value is {
  readonly file: string;
  readonly name: string;
} {
  if (
    !isRecord(value) ||
    typeof value.file !== "string" ||
    value.file.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0
  ) {
    throw new TypeError("Node 测试状态引用必须提供有效文件和测试名称。");
  }
}

function nodeError(code: string, message: string): PluginResult<NodeTestValue> {
  return { kind: "error", error: { code, message } };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
