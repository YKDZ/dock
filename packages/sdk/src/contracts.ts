import type {
  JsonValue,
  MemberDiscoveryCompleteness,
  ReferenceMemberResult,
  TextRange,
} from "@dock/core";

export type { JsonValue, TextRange } from "@dock/core";

/** 显式记录的声明出处；它与引用目标和配置加载入口各自独立。 */
export type DeclarationSource = string | URL;

export type Reference<
  PluginId extends string = string,
  Id extends string = string,
  Target extends JsonValue = JsonValue,
  Value extends JsonValue = JsonValue,
> = {
  readonly id: Id;
  readonly pluginId: PluginId;
  readonly target: Target;
  readonly selection?: JsonValue;
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
        readonly members: readonly ReferenceMemberResult[];
      };
      readonly range?: TextRange;
    }
  | {
      readonly kind: "error";
      readonly error: { readonly code: string; readonly message: string };
      readonly range?: TextRange;
    };

export type PluginContext = { readonly root: string };

/**
 * 引用插件公开契约。插件只定位并采集事实，关联判断和基线规则由 core 独占。
 */
export interface ReferencePlugin<
  PluginId extends string = string,
  Ref extends Reference<PluginId> = Reference<PluginId>,
  Value extends JsonValue = JsonValue,
> {
  readonly id: PluginId;
  collect(
    reference: Ref,
    context: PluginContext,
  ): PluginResult<Value> | Promise<PluginResult<Value>>;
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
> = {
  readonly plugins: Plugins;
  readonly bindings: readonly Binding[];
  readonly root?: string;
  readonly baseline?: string;
  readonly declarationSources?: readonly DeclarationSource[];
};

export type RegisteredReference<Plugins extends readonly ReferencePlugin[]> =
  Plugins[number] extends ReferencePlugin<string, infer Ref, JsonValue>
    ? Ref
    : never;

export type ConfigInput<Plugins extends readonly ReferencePlugin[]> = {
  readonly plugins: Plugins;
  readonly bindings: readonly Binding<
    readonly RegisteredReference<Plugins>[]
  >[];
  readonly root?: string;
  readonly baseline?: string;
  readonly declarationSources?: readonly DeclarationSource[];
};
