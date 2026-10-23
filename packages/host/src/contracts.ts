import type {
  JsonValue,
  MemberDiscoveryCompleteness,
  ReferenceMemberResult,
  TextRange,
} from "@ykdz/dock-core";

export type { JsonValue, TextRange } from "@ykdz/dock-core";

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

/** 插件明确提供的声明说明或操作诊断。 */
export type PluginInformation = {
  readonly data: JsonValue;
  readonly text: readonly string[];
};

/** 一次批量采集收到的完整声明、本次选定引用和可选准备数据。 */
export type PluginRequest<
  Ref extends Reference = Reference,
  Prepared extends JsonValue = JsonValue,
> = {
  readonly references: readonly Ref[];
  readonly selectedReferences: readonly Ref[];
  readonly prepared?: Prepared;
};

/** 一条结果由插件给出，宿主按当前插件调用补上并核对引用归属。 */
export type PluginReferenceResult<Value extends JsonValue = JsonValue> =
  PluginResult<Value> & { readonly referenceId: string };

/** 批量采集保持逐引用结果，诊断与事实分别交接。 */
export type PluginBatchResult<Value extends JsonValue = JsonValue> = {
  readonly results: readonly PluginReferenceResult<Value>[];
  readonly diagnostics?: PluginInformation;
};

type BivariantHandler<Arguments extends unknown[], Result> = {
  bivarianceHack(...arguments_: Arguments): Result;
}["bivarianceHack"];

export type Awaitable<Value> = Value | Promise<Value>;

/**
 * 类别中立的引用插件。目标解释、执行和类别诊断均由插件自己拥有。
 */
export interface ReferencePlugin<
  PluginId extends string = string,
  Ref extends Reference<PluginId> = Reference<PluginId>,
  Value extends ReferenceValue<Ref> = ReferenceValue<Ref>,
  Prepared extends JsonValue = JsonValue,
> {
  readonly id: PluginId;
  readonly validate: BivariantHandler<[reference: Ref], void>;
  readonly collect: BivariantHandler<
    [request: PluginRequest<Ref, Prepared>, context: PluginContext],
    Awaitable<PluginBatchResult<Value>>
  >;
  /** 按插件公开语义提供引用的一个文件目标；不得读取文件内容。 */
  readonly fileInfo?: BivariantHandler<
    [reference: Ref, context: PluginContext],
    string | URL
  >;
  /** 对插件的完整引用声明执行一次预检，并可返回本次独立准备数据。 */
  readonly prepare?: BivariantHandler<
    [references: readonly Ref[], context: PluginContext],
    Awaitable<Prepared | undefined>
  >;
  /** 根据完整声明、选定范围及本次准备数据提供查看信息。 */
  readonly describe?: BivariantHandler<
    [request: PluginRequest<Ref, Prepared>, context: PluginContext],
    Awaitable<PluginInformation>
  >;
}

export type PluginReadResult<Value extends JsonValue = JsonValue> = {
  readonly value: Value;
  readonly range?: TextRange;
};

/** 具备稳定引用读取能力的插件。 */
export interface ReadableReferencePlugin<
  PluginId extends string = string,
  Ref extends Reference<PluginId> = Reference<PluginId>,
  Value extends ReferenceValue<Ref> = ReferenceValue<Ref>,
  Prepared extends JsonValue = JsonValue,
> extends ReferencePlugin<PluginId, Ref, Value, Prepared> {
  readonly read: BivariantHandler<
    [reference: Ref, context: PluginContext],
    Awaitable<PluginReadResult<Value>>
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
  Ref extends Reference<string, string, JsonValue, infer Value> ? Value : never;

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
