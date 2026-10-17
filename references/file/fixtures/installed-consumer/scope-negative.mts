import {
  createReference,
  definePlugin,
  check,
  type PluginContext,
  type PluginExecutionContext,
  type RunDeclaration,
  type PluginResult,
  type Reference,
} from "@dock/sdk";

type ScopeReference = Reference<
  "fixture:scope-negative",
  "scope-negative-reference",
  { readonly path: string },
  string
>;

const reference = createReference<
  "fixture:scope-negative",
  "scope-negative-reference",
  { readonly path: string },
  string
>("fixture:scope-negative", "scope-negative-reference", { path: "guide.md" });
void reference;
const plugin = definePlugin({
  id: "fixture:scope-negative",
  validate(_reference: ScopeReference): void {},
  collect(_reference: ScopeReference): PluginResult<string> {
    return { kind: "value", value: "scope fact" };
  },
  fileInfo(_reference: ScopeReference, _context: PluginContext): string {
    return "guide.md";
  },
});
void plugin;

// @ts-expect-error 范围筛选项必须使用公开的字符串 ID。
void check({ plugins: [], bindings: [] }, { binding: [42] });

definePlugin({
  id: "fixture:scope-negative",
  validate(_reference: ScopeReference): void {},
  collect(_reference: ScopeReference): PluginResult<string> {
    return { kind: "value", value: "scope fact" };
  },
  // @ts-expect-error 插件文件信息只能返回路径文本或 file: URL。
  fileInfo(): number {
    return 1;
  },
});

definePlugin({
  id: "fixture:scope-negative",
  validate(_reference: ScopeReference): void {},
  collect(_reference: ScopeReference): PluginResult<string> {
    return { kind: "value", value: "scope fact" };
  },
  execution: {
    // @ts-expect-error 运行声明的身份必须是文本，配置必须是 JSON 值。
    declare() {
      return [
        {
          identity: 1,
          configuration: new Date(),
          references: ["scope-negative-reference"],
        },
      ];
    },
    execute() {
      return {
        lifecycle: "complete",
        commandAttempts: 1,
        testExecutions: 0,
        tests: [],
        errors: [],
      };
    },
  },
});

const wrongConfiguration = {
  id: "fixture:scope-negative" as const,
  validate(_reference: ScopeReference): void {},
  execution: {
    declare(
      _references: readonly ScopeReference[],
    ): readonly RunDeclaration<{ count: number }>[] {
      return [
        {
          identity: "typed",
          configuration: { count: 1 },
          references: ["scope-negative-reference"],
        },
      ];
    },
    execute(_request: {
      declaration: RunDeclaration<{ count: string }>;
      selectedReferences: readonly ScopeReference[];
    }) {
      return {
        lifecycle: "complete" as const,
        commandAttempts: 1,
        testExecutions: 0,
        tests: [],
        errors: [],
      };
    },
  },
  collect(_reference: ScopeReference): PluginResult<string> {
    return { kind: "value", value: "fact" };
  },
};
// @ts-expect-error 执行入口必须接受声明阶段产生的配置类型。
definePlugin(wrongConfiguration);

const wrongExecutionReference = {
  ...wrongConfiguration,
  execution: {
    declare(
      _references: readonly Reference<
        "fixture:scope-negative",
        string,
        string,
        string
      >[],
    ): readonly RunDeclaration<{ count: number }>[] {
      return [
        {
          identity: "typed",
          configuration: { count: 1 },
          references: ["scope-negative-reference"],
        },
      ];
    },
    execute() {
      return {
        lifecycle: "complete" as const,
        commandAttempts: 1,
        testExecutions: 0,
        tests: [],
        errors: [],
      };
    },
  },
};
// @ts-expect-error 声明运行的入口必须接受插件所处理的引用目标类型。
definePlugin(wrongExecutionReference);

declare const context: PluginExecutionContext<{ count: number }>;
// @ts-expect-error 不能指定任意类型来解释已完成的运行。
context.execution.get<{ count: string }>("typed");
// @ts-expect-error 运行配置保留插件声明的数字类型。
const wrongCount: string =
  context.execution.get("typed")!.declaration.configuration.count;
void wrongCount;
