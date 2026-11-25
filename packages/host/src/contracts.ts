import type {
  JsonValue,
  MemberDiscoveryCompleteness,
  ReferenceMemberResult,
  TextRange,
} from "@dock/core";

export type { JsonValue, TextRange } from "@dock/core";

/** Explicitly recorded declaration source, independent of reference target and config entry. */
export type DeclarationSource = string | URL;

export type PluginDeclarationSource<
  PluginId extends string = string,
  Target extends JsonValue = JsonValue,
> = {
  readonly pluginId: PluginId;
  readonly target: Target;
  readonly declaredAt?: DeclarationSource;
};

export type PluginDiscoveryInput<
  Ref extends Reference = Reference,
  Source extends PluginDeclarationSource = PluginDeclarationSource,
> = {
  readonly references: readonly Ref[];
  readonly sources: readonly Source[];
  readonly missingBaselineFiles: readonly string[];
};

export type PluginDiscoveredBinding = {
  readonly id: string;
  readonly ownReferences: readonly Reference[];
  readonly referenceIds: readonly string[];
  readonly note?: string;
  readonly declaredAt?: DeclarationSource;
};

export type PluginDiscoveryIssue = {
  readonly code: string;
  readonly message: string;
  /** Optional normalized file path; retained only if a historical baseline binding referencing that file remains absent after discovery. */
  readonly missingFile?: string;
};

export type PluginDiscoveryResult = {
  readonly bindings: readonly PluginDiscoveredBinding[];
  readonly issues: readonly PluginDiscoveryIssue[];
};

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
  /** Used only for type inference; excluded from runtime definitions and domain comparison. */
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

/** Plugin member results reuse core's stable identity and error shape while constraining success value types. */
export type PluginMemberResult<Value extends JsonValue = JsonValue> =
  | { readonly id: string; readonly value: Value }
  | Extract<ReferenceMemberResult, { readonly error: unknown }>;

export type PluginContext = { readonly root: string };

/** Declaration description or operational diagnostics explicitly provided by a plugin. */
export type PluginInformation = {
  readonly data: JsonValue;
  readonly text: readonly string[];
};

/** Complete plugin declarations, currently selected references, and optional prepared data for a batch collection. */
export type PluginRequest<
  Ref extends Reference = Reference,
  Prepared extends JsonValue = JsonValue,
> = {
  readonly references: readonly Ref[];
  readonly selectedReferences: readonly Ref[];
  readonly prepared?: Prepared;
};

/** A single result returned by a plugin; the host attaches and verifies reference ownership per plugin call. */
export type PluginReferenceResult<Value extends JsonValue = JsonValue> =
  PluginResult<Value> & { readonly referenceId: string };

/** Batch collection keeps per-reference results while handing off diagnostics and facts separately. */
export type PluginBatchResult<Value extends JsonValue = JsonValue> = {
  readonly results: readonly PluginReferenceResult<Value>[];
  readonly diagnostics?: PluginInformation;
};

type BivariantHandler<Arguments extends unknown[], Result> = {
  bivarianceHack(...arguments_: Arguments): Result;
}["bivarianceHack"];

export type Awaitable<Value> = Value | Promise<Value>;

/**
 * Category-neutral reference plugin. Target interpretation, execution, and category diagnostics belong to the plugin itself.
 */
export interface ReferencePlugin<
  PluginId extends string = string,
  Ref extends Reference<PluginId> = Reference<PluginId>,
  Value extends ReferenceValue<Ref> = ReferenceValue<Ref>,
  Prepared extends JsonValue = JsonValue,
  Source extends PluginDeclarationSource<PluginId> =
    PluginDeclarationSource<PluginId>,
> {
  readonly id: PluginId;
  readonly validate: BivariantHandler<[reference: Ref], void>;
  /** Collects current facts for `request.selectedReferences`; shared reads or executions stay scoped to this single call and may report operational diagnostics. */
  readonly collect: BivariantHandler<
    [request: PluginRequest<Ref, Prepared>, context: PluginContext],
    Awaitable<PluginBatchResult<Value>>
  >;
  /** Validates an explicit plugin declaration source registered via `config.sources`. */
  readonly validateSource?: BivariantHandler<[source: Source], void>;
  /** Discovers inline declarations from plugin references and explicit sources before scope resolution. */
  readonly discover?: BivariantHandler<
    [input: PluginDiscoveryInput<Ref, Source>, context: PluginContext],
    Awaitable<PluginDiscoveryResult>
  >;
  /** Provides a single file target path for a reference by plugin semantics; must not read file contents. */
  readonly fileInfo?: BivariantHandler<
    [reference: Ref, context: PluginContext],
    string | URL
  >;
  /** Projects a reference target to the comparable JSON definition stored in baselines and checked for definition diffs. */
  readonly comparableTarget?: BivariantHandler<
    [reference: Ref, context: PluginContext],
    JsonValue
  >;
  /** Runs one preflight pass over all references of a plugin and may return isolated prepared data. */
  readonly prepare?: BivariantHandler<
    [references: readonly Ref[], context: PluginContext],
    Awaitable<Prepared | undefined>
  >;
  /** Provides inspection information from complete declarations, selected scope, and prepared data. */
  readonly describe?: BivariantHandler<
    [request: PluginRequest<Ref, Prepared>, context: PluginContext],
    Awaitable<PluginInformation>
  >;
}

export type PluginReadResult<Value extends JsonValue = JsonValue> = {
  readonly value: Value;
  readonly range?: TextRange;
};

/** Plugin capable of reading a stable reference directly. */
export interface ReadableReferencePlugin<
  PluginId extends string = string,
  Ref extends Reference<PluginId> = Reference<PluginId>,
  Value extends ReferenceValue<Ref> = ReferenceValue<Ref>,
  Prepared extends JsonValue = JsonValue,
  Source extends PluginDeclarationSource<PluginId> =
    PluginDeclarationSource<PluginId>,
> extends ReferencePlugin<PluginId, Ref, Value, Prepared, Source> {
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
  References extends readonly Reference[] = readonly Reference[],
  Sources extends readonly PluginDeclarationSource[] =
    readonly PluginDeclarationSource[],
> = {
  readonly plugins: Plugins;
  readonly bindings: Bindings;
  readonly references?: References;
  readonly sources?: Sources;
  readonly root?: string;
  readonly baseline?: string;
  readonly declarationSources?: readonly DeclarationSource[];
};

export type RegisteredReference<Plugins extends readonly ReferencePlugin[]> =
  PluginReference<Plugins[number]>;

export type RegisteredDeclarationSource<
  Plugins extends readonly ReferencePlugin[],
> = PluginSource<Plugins[number]>;

export type ReferenceValue<Ref extends Reference = Reference> =
  Ref extends Reference<string, string, JsonValue, infer Value> ? Value : never;

/** Requires plugin ID and target item pluginId to match exactly when both static identities are narrowed. */
export type PluginIdentityMatches<
  PluginId extends string,
  Item extends { readonly pluginId: string },
> = string extends PluginId
  ? true
  : string extends Item["pluginId"]
    ? true
    : [PluginId] extends [Item["pluginId"]]
      ? [Item["pluginId"]] extends [PluginId]
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

type PluginSource<Plugin> =
  Plugin extends ReferencePlugin<
    string,
    infer _Ref,
    infer _Value,
    infer _Prepared,
    infer Source
  >
    ? Plugin extends { readonly id: infer PluginId extends string }
      ? PluginIdentityMatches<PluginId, Source> extends true
        ? string extends PluginId
          ? Source
          : string extends Source["pluginId"]
            ? Plugin extends
                | { readonly discover: (...arguments_: never[]) => unknown }
                | {
                    readonly validateSource: (
                      ...arguments_: never[]
                    ) => unknown;
                  }
              ? Source & { readonly pluginId: PluginId }
              : never
            : Source
        : never
      : Source
    : never;

export type ConfigInput<
  Plugins extends readonly ReferencePlugin[],
  Bindings extends readonly Binding<readonly RegisteredReference<Plugins>[]>[] =
    readonly Binding<readonly RegisteredReference<Plugins>[]>[],
  References extends readonly RegisteredReference<Plugins>[] =
    readonly RegisteredReference<Plugins>[],
  Sources extends readonly RegisteredDeclarationSource<Plugins>[] =
    readonly RegisteredDeclarationSource<Plugins>[],
> =
  | {
      readonly plugins: Plugins;
      readonly bindings: Bindings;
      readonly references?: References;
      readonly sources?: Sources;
      readonly root?: string;
      readonly baseline?: string;
      readonly declarationSources?: readonly DeclarationSource[];
    }
  | {
      readonly plugins: Plugins;
      readonly sources: Sources;
      readonly bindings?: Bindings;
      readonly references?: References;
      readonly root?: string;
      readonly baseline?: string;
      readonly declarationSources?: readonly DeclarationSource[];
    };
