import type {
  JsonValue,
  MemberDiscoveryCompleteness,
  ReferenceMemberResult,
  TextRange,
} from "@dock/core";

import type { ExecutionRegistry } from "./execution.ts";

export type { JsonValue, TextRange } from "@dock/core";

/** 显式记录的声明出处；它与引用目标和配置加载入口各自独立。 */
export type DeclarationSource = string | URL;

export type Reference<
  PluginId extends string = string,
  Id extends string = string,
  Target extends JsonValue = JsonValue,
  Value extends JsonValue = JsonValue,
  Selection extends JsonValue = JsonValue,
> = {
  readonly id: Id;
  readonly pluginId: PluginId;
  readonly target: Target;
  readonly selection?: Selection;
  readonly note?: string;
  readonly declaredAt?: DeclarationSource;
  /** 仅供类型推导，不参与运行时定义或领域比较。 */
  readonly __value?: Value;
};

export type PluginResult<Value extends JsonValue = JsonValue> =
  | {
      readonly kind: "value";
      readonly value: Value;
      readonly range?: TextRange;
    }
  | {
      readonly kind: "collection";
      readonly collection: {
        readonly completeness: MemberDiscoveryCompleteness;
        readonly members: readonly PluginMemberResult<Value>[];
      };
      readonly range?: TextRange;
    }
  | {
      readonly kind: "error";
      readonly error: { readonly code: string; readonly message: string };
      readonly range?: TextRange;
    };

/** 插件成员结果沿用 core 的稳定身份与错误形状，并约束成功值类型。 */
export type PluginMemberResult<Value extends JsonValue = JsonValue> =
  | { readonly id: string; readonly value: Value }
  | Extract<ReferenceMemberResult, { readonly error: unknown }>;

export type PluginContext = { readonly root: string };

/** 采集插件可使用的执行会话；读取插件只获得 root。 */
export type PluginExecutionContext = PluginContext & {
  readonly execution: ExecutionRegistry;
};

export type PluginReadResult<Value extends JsonValue = JsonValue> = {
  readonly value: Value;
  readonly range?: TextRange;
};

type BivariantHandler<Arguments extends unknown[], Result> = {
  bivarianceHack(...arguments_: Arguments): Result;
}["bivarianceHack"];

/**
 * 引用插件公开契约。插件只定位并采集事实，关联判断和基线规则由 core 独占。
 */
export interface ReferencePlugin<
  PluginId extends string = string,
  Ref extends Reference<PluginId> = Reference<PluginId>,
  Value extends ReferenceValue<Ref> = ReferenceValue<Ref>,
> {
  readonly id: PluginId;
  /** 在任何引用开始采集前验证插件专属声明形状；不得读取外部目标。 */
  readonly validate: BivariantHandler<[reference: Ref], void>;
  readonly collect: BivariantHandler<
    [reference: Ref, context: PluginExecutionContext],
    PluginResult<Value> | Promise<PluginResult<Value>>
  >;
  /** 在执行启动前一次准备该插件本次涉及的全部引用。 */
  readonly prepare?: BivariantHandler<
    [references: readonly Ref[], context: PluginExecutionContext],
    void | Promise<void>
  >;
}

/** 具备稳定引用读取能力的插件；读取结果与引用声明保留相同值类型。 */
export interface ReadableReferencePlugin<
  PluginId extends string = string,
  Ref extends Reference<PluginId> = Reference<PluginId>,
  Value extends ReferenceValue<Ref> = ReferenceValue<Ref>,
> extends ReferencePlugin<PluginId, Ref, Value> {
  readonly read: BivariantHandler<
    [reference: Ref, context: PluginContext],
    PluginReadResult<Value> | Promise<PluginReadResult<Value>>
  >;
}

export type Binding<
  References extends readonly Reference[] = readonly Reference[],
> = {
  readonly id: string;
  readonly references: References;
  readonly note?: string;
  readonly declaredAt?: DeclarationSource;
};

export type Config<
  Plugins extends readonly ReferencePlugin[] = readonly ReferencePlugin[],
  Bindings extends readonly Binding[] = readonly Binding[],
> = {
  readonly plugins: Plugins;
  readonly bindings: Bindings;
  readonly root?: string;
  readonly baseline?: string;
  readonly declarationSources?: readonly DeclarationSource[];
};

export type RegisteredReference<Plugins extends readonly ReferencePlugin[]> =
  PluginReference<Plugins[number]>;

export type ReferenceValue<Ref extends Reference = Reference> =
  Ref extends Reference<string, string, JsonValue, infer Value, JsonValue>
    ? Value
    : never;

/** 静态身份都已收窄时要求插件 ID 与引用处理器 ID 精确一致。 */
export type PluginIdentityMatches<
  PluginId extends string,
  Ref extends Reference,
> = string extends PluginId
  ? true
  : string extends Ref["pluginId"]
    ? true
    : [PluginId] extends [Ref["pluginId"]]
      ? [Ref["pluginId"]] extends [PluginId]
        ? true
        : false
      : false;

export type ReadableReferenceOf<Plugins extends readonly ReferencePlugin[]> =
  PluginReadableReference<Plugins[number]>;

type PluginReference<Plugin> =
  Plugin extends ReferencePlugin<string, infer Ref, infer _Value>
    ? Plugin extends { readonly id: infer PluginId extends string }
      ? PluginIdentityMatches<PluginId, Ref> extends true
        ? Ref
        : never
      : Ref
    : never;

type PluginReadableReference<Plugin> =
  Plugin extends ReadableReferencePlugin<string, infer Ref, infer _Value>
    ? Plugin extends { readonly id: infer PluginId extends string }
      ? PluginIdentityMatches<PluginId, Ref> extends true
        ? Ref
        : never
      : Ref
    : never;

export type ConfigInput<
  Plugins extends readonly ReferencePlugin[],
  Bindings extends readonly Binding<readonly RegisteredReference<Plugins>[]>[] =
    readonly Binding<readonly RegisteredReference<Plugins>[]>[],
> = {
  readonly plugins: Plugins;
  readonly bindings: Bindings;
  readonly root?: string;
  readonly baseline?: string;
  readonly declarationSources?: readonly DeclarationSource[];
};
