import type {
  Binding,
  Config,
  ConfigInput,
  DeclarationSource,
  PluginIdentityMatches,
  Reference,
  ReferencePlugin,
  ReferenceValue,
  RegisteredReference,
} from "./contracts.ts";
import { canonicalJson, isJsonValue, type JsonValue } from "./core/index.ts";
import { ownReference } from "./owned-data.ts";

export type {
  Binding,
  Config,
  DeclarationSource,
  Reference,
} from "./contracts.ts";

export type ReferenceOptions<Selection extends JsonValue = JsonValue> = {
  readonly selection?: Selection;
  readonly note?: string;
  readonly declaredAt?: DeclarationSource;
};

export function createReference<
  PluginId extends string,
  Id extends string,
  Target extends JsonValue,
  Value extends JsonValue = JsonValue,
  Selection extends JsonValue = JsonValue,
>(
  pluginId: PluginId,
  id: Id,
  target: Target,
  options: ReferenceOptions<Selection> = {},
): Reference<PluginId, Id, Target, Value, Selection> {
  const result = {
    id,
    pluginId,
    target,
    ...options,
  };
  assertReferenceDefinition(result);
  assertDeclarationSource(result.declaredAt, `Reference ${id}`);
  return result;
}

type PluginReferenceArgument<
  Plugin,
  Method extends "validate" | "read" | "fileInfo" | "comparableTarget",
> = Method extends keyof Plugin
  ? Plugin[Method] extends (...arguments_: infer Arguments) => unknown
    ? Arguments extends readonly [infer Ref, ...unknown[]]
      ? Ref extends Reference
        ? Ref
        : never
      : never
    : never
  : never;

type PluginReferenceListArgument<
  Plugin,
  Method extends string = "prepare",
> = Method extends keyof Plugin
  ? Plugin[Method] extends (...arguments_: infer Arguments) => unknown
    ? Arguments extends readonly [infer References, ...unknown[]]
      ? References extends readonly (infer Ref)[]
        ? Ref extends Reference
          ? Ref
          : never
        : never
      : never
    : never
  : never;

type PluginReferenceType<Plugin> = [
  PluginReferenceArgument<Plugin, "validate">,
] extends [never]
  ? [PluginRequestReference<Plugin, "collect">] extends [never]
    ? Reference
    : PluginRequestReference<Plugin, "collect">
  : PluginReferenceArgument<Plugin, "validate">;

type PluginRequestArgument<
  Plugin,
  Method extends "collect" | "describe",
> = Method extends keyof Plugin
  ? Plugin[Method] extends (...arguments_: infer Arguments) => unknown
    ? Arguments extends readonly [infer Request, ...unknown[]]
      ? Request
      : never
    : never
  : never;

type PluginRequestReference<Plugin, Method extends "collect" | "describe"> =
  PluginRequestArgument<Plugin, Method> extends {
    readonly references: readonly (infer Ref)[];
  }
    ? Ref extends Reference
      ? Ref
      : never
    : never;

type PluginSuccessValue<Result> = Result extends {
  readonly kind: "value";
  readonly value: infer Value;
}
  ? Value
  : Result extends {
        readonly kind: "collection";
        readonly collection: {
          readonly members: readonly (infer Member)[];
        };
      }
    ? Member extends { readonly value: infer Value }
      ? Value
      : never
    : never;

type PluginCollectedValue<Plugin> = Plugin extends {
  readonly collect: (...arguments_: never[]) => infer Result;
}
  ? Awaited<Result> extends {
      readonly results: readonly (infer Entry)[];
    }
    ? PluginSuccessValue<Entry>
    : never
  : never;

type PluginReadValue<Plugin> = Plugin extends {
  readonly read: (...arguments_: never[]) => infer Result;
}
  ? Awaited<Result> extends { readonly value: infer Value }
    ? Value
    : never
  : never;

type PluginIdType<Plugin> = Plugin extends {
  readonly id: infer PluginId extends string;
}
  ? PluginId
  : string;

type AcceptsPluginReference<Ref extends Reference, Accepted> = [
  Accepted,
] extends [never]
  ? true
  : [Ref] extends [Accepted]
    ? true
    : false;

type RequestAcceptsReference<Ref extends Reference, Request> = Request extends {
  readonly references: readonly (infer Accepted)[];
}
  ? AcceptsPluginReference<Ref, Accepted>
  : [Request] extends [never]
    ? true
    : false;

type PluginPreparedValue<Plugin> = Plugin extends {
  readonly prepare: (...arguments_: never[]) => infer Result;
}
  ? Exclude<Awaited<Result>, undefined>
  : never;

type PreparedValueAcceptedByRequest<Prepared, Request> = [Prepared] extends [
  never,
]
  ? true
  : Request extends { readonly prepared?: infer Accepted }
    ? [Prepared] extends [Exclude<Accepted, undefined>]
      ? true
      : false
    : [Request] extends [never]
      ? true
      : false;

type PluginHookReferenceContract<Plugin, Ref extends Reference> =
  AcceptsPluginReference<
    Ref,
    PluginReferenceArgument<Plugin, "validate">
  > extends true
    ? AcceptsPluginReference<
        Ref,
        PluginReferenceArgument<Plugin, "fileInfo">
      > extends true
      ? AcceptsPluginReference<
          Ref,
          PluginReferenceArgument<Plugin, "comparableTarget">
        > extends true
        ? AcceptsPluginReference<
            Ref,
            PluginReferenceArgument<Plugin, "read">
          > extends true
          ? AcceptsPluginReference<
              Ref,
              PluginReferenceListArgument<Plugin>
            > extends true
            ? RequestAcceptsReference<
                Ref,
                PluginRequestArgument<Plugin, "collect">
              > extends true
              ? RequestAcceptsReference<
                  Ref,
                  PluginRequestArgument<Plugin, "describe">
                > extends true
                ? unknown
                : never
              : never
            : never
          : never
        : never
      : never
    : never;

type PluginPreparedContract<Plugin> =
  PreparedValueAcceptedByRequest<
    PluginPreparedValue<Plugin>,
    PluginRequestArgument<Plugin, "collect">
  > extends true
    ? PreparedValueAcceptedByRequest<
        PluginPreparedValue<Plugin>,
        PluginRequestArgument<Plugin, "describe">
      > extends true
      ? unknown
      : never
    : never;

/** Pure preflight, fileInfo, and comparableTarget hooks must accept the same reference type declared by the plugin. */
type PluginValueContractForReference<Plugin, Ref extends Reference> = [
  PluginHookReferenceContract<Plugin, Ref>,
] extends [never]
  ? never
  : [PluginCollectedValue<Plugin>] extends [ReferenceValue<Ref>]
    ? Plugin extends { readonly read: (...arguments_: never[]) => unknown }
      ? [PluginReadValue<Plugin>] extends [ReferenceValue<Ref>]
        ? PluginPreparedContract<Plugin>
        : never
      : PluginPreparedContract<Plugin>
    : never;

type PluginValueContract<Plugin> =
  PluginReferenceType<Plugin> extends infer Ref extends Reference
    ? PluginIdentityMatches<PluginIdType<Plugin>, Ref> extends true
      ? PluginValueContractForReference<Plugin, Ref> &
          PluginPreparedContract<Plugin>
      : never
    : never;

type ValidatedPlugins<Plugins extends readonly ReferencePlugin[]> = {
  readonly [Index in keyof Plugins]: Plugins[Index] &
    PluginValueContract<NoInfer<Plugins[Index]>>;
};

export function definePlugin<const Plugin extends ReferencePlugin>(
  plugin: Plugin & PluginValueContract<NoInfer<Plugin>>,
): Plugin {
  assertPlugin(plugin);
  return plugin;
}

export function binding<
  const References extends readonly [Reference, ...Reference[]],
>(
  id: string,
  references: References,
  options: {
    readonly note?: string;
    readonly declaredAt?: DeclarationSource;
  } = {},
): Binding<References> {
  assertBindingDefinitionLocal(
    id,
    references.map((reference) => reference.id),
    options.note,
  );
  assertDeclarationSource(options.declaredAt, `Binding ${id}`);
  return { id, references, ...options };
}

export function defineConfig<
  const Plugins extends readonly ReferencePlugin[],
  const Bindings extends readonly Binding<
    readonly RegisteredReference<Plugins>[]
  >[],
>(
  input: ConfigInput<Plugins, Bindings> & {
    readonly plugins: ValidatedPlugins<Plugins>;
  },
): Config<Plugins, Bindings> {
  validateConfig(input);
  return input;
}

export type NormalizedReference = Reference & {
  readonly declarationSources: readonly DeclarationSource[];
};

export type NormalizedConfig = {
  readonly config: Config;
  readonly references: readonly NormalizedReference[];
};

export function validateConfig(value: unknown): asserts value is Config {
  normalizeConfig(value);
}

export function normalizeConfig(value: unknown): NormalizedConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Config entry must export an object.");
  }
  const config = value as Record<string, unknown>;
  if (!Array.isArray(config.plugins)) {
    throw new TypeError("Config must provide a plugins list.");
  }
  const plugins = new Map<string, ReferencePlugin>();
  for (const candidate of config.plugins) {
    assertPlugin(candidate);
    if (plugins.has(candidate.id)) {
      throw new TypeError(`Duplicate reference plugin ID: ${candidate.id}`);
    }
    const read = "read" in candidate ? candidate.read : undefined;
    const fileInfo = candidate.fileInfo;
    const comparableTarget = candidate.comparableTarget;
    const prepare = candidate.prepare;
    const describe = candidate.describe;
    plugins.set(
      candidate.id,
      Object.freeze({
        ...candidate,
        id: candidate.id,
        validate: candidate.validate.bind(candidate),
        collect: candidate.collect.bind(candidate),
        ...(fileInfo === undefined
          ? {}
          : { fileInfo: fileInfo.bind(candidate) }),
        ...(comparableTarget === undefined
          ? {}
          : { comparableTarget: comparableTarget.bind(candidate) }),
        ...(prepare === undefined ? {} : { prepare: prepare.bind(candidate) }),
        ...(describe === undefined
          ? {}
          : { describe: describe.bind(candidate) }),
        ...(typeof read === "function" ? { read: read.bind(candidate) } : {}),
      }),
    );
  }

  if (!Array.isArray(config.bindings)) {
    throw new TypeError("Config must provide a bindings list.");
  }
  if (
    config.root !== undefined &&
    (typeof config.root !== "string" || config.root.length === 0)
  ) {
    throw new TypeError("Config root must be a non-empty path string.");
  }
  if (
    config.baseline !== undefined &&
    (typeof config.baseline !== "string" || config.baseline.length === 0)
  ) {
    throw new TypeError("Config baseline must be a non-empty path string.");
  }
  if (config.declarationSources !== undefined) {
    if (!Array.isArray(config.declarationSources)) {
      throw new TypeError(
        "Config declarationSources must be a list of sources.",
      );
    }
    for (const source of config.declarationSources) {
      assertDeclarationSource(source, "Config declarationSources");
    }
  }

  const root = config.root;
  const baseline = config.baseline;
  const sources = (
    config.declarationSources as DeclarationSource[] | undefined
  )?.map((source) => (source instanceof URL ? source.href : source));
  const bindings = new Map<string, Binding>();
  const references = new Map<string, NormalizedReference>();
  for (const candidate of config.bindings) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new TypeError("Binding declaration must be an object.");
    }
    const current = candidate as Binding;
    assertBindingDefinitionLocal(
      current.id,
      referenceIds(current.references),
      current.note,
    );
    assertDeclarationSource(current.declaredAt, `Binding ${current.id}`);
    const priorBinding = bindings.get(current.id);
    if (priorBinding !== undefined) {
      throw new TypeError(
        `Duplicate binding ID: ${current.id}${formatDeclarationSources([priorBinding.declaredAt, current.declaredAt])}`,
      );
    }
    bindings.set(current.id, {
      id: current.id,
      references: [...current.references],
      ...(current.note === undefined ? {} : { note: current.note }),
      ...(current.declaredAt === undefined
        ? {}
        : {
            declaredAt:
              current.declaredAt instanceof URL
                ? current.declaredAt.href
                : current.declaredAt,
          }),
    });

    for (const reference of current.references) {
      assertReference(reference);
      const prior = references.get(reference.id);
      if (prior !== undefined && !sameReferenceDefinition(prior, reference)) {
        throw new TypeError(
          `Reference ID ${reference.id} maps to multiple distinct definitions${formatDeclarationSources([...prior.declarationSources, reference.declaredAt])}.`,
        );
      }
      references.set(
        reference.id,
        prior === undefined
          ? {
              ...ownReference(reference),
              declarationSources: declarationSources([reference.declaredAt]),
            }
          : {
              ...prior,
              declarationSources: declarationSources([
                ...prior.declarationSources,
                reference.declaredAt,
              ]),
            },
      );
    }
  }

  for (const [id, reference] of references) {
    references.set(
      id,
      Object.freeze({
        ...reference,
        declarationSources: Object.freeze(
          reference.declarationSources.map((source) =>
            source instanceof URL ? source.href : source,
          ),
        ),
      }),
    );
  }
  const normalizedConfig: Config = Object.freeze({
    plugins: Object.freeze([...plugins.values()]),
    bindings: Object.freeze(
      [...bindings.values()].map((binding) =>
        Object.freeze({
          ...binding,
          references: Object.freeze(
            binding.references.map((reference) =>
              references.get(reference.id)!,
            ),
          ),
        }),
      ),
    ),
    ...(root === undefined ? {} : { root }),
    ...(baseline === undefined ? {} : { baseline }),
    ...(sources === undefined
      ? {}
      : { declarationSources: Object.freeze(sources) }),
  });
  for (const reference of references.values()) {
    const plugin = plugins.get(reference.pluginId);
    if (plugin === undefined) {
      throw new TypeError(
        `Reference ${reference.id} uses an unregistered plugin: ${reference.pluginId}${formatDeclarationSources(reference.declarationSources)}.`,
      );
    }
    try {
      plugin.validate(reference);
    } catch (error) {
      throw new TypeError(
        `Plugin ${reference.pluginId} rejected declaration of reference ${reference.id}: ${errorMessage(error)}${formatDeclarationSources(reference.declarationSources)}`,
        { cause: error },
      );
    }
  }

  return {
    config: normalizedConfig,
    references: Object.freeze([...references.values()]),
  };
}

function assertPlugin(value: unknown): asserts value is ReferencePlugin {
  const isObject = typeof value === "object" && value !== null;
  const fileInfo = isObject
    ? (value as { readonly fileInfo?: unknown }).fileInfo
    : undefined;
  const comparableTarget = isObject
    ? (value as { readonly comparableTarget?: unknown }).comparableTarget
    : undefined;
  const prepare = isObject
    ? (value as { readonly prepare?: unknown }).prepare
    : undefined;
  const describe = isObject
    ? (value as { readonly describe?: unknown }).describe
    : undefined;
  if (
    !isObject ||
    Array.isArray(value) ||
    typeof (value as { id?: unknown }).id !== "string" ||
    (value as { id: string }).id.length === 0 ||
    typeof (value as { collect?: unknown }).collect !== "function" ||
    typeof (value as { validate?: unknown }).validate !== "function" ||
    (fileInfo !== undefined && typeof fileInfo !== "function") ||
    (comparableTarget !== undefined &&
      typeof comparableTarget !== "function") ||
    (prepare !== undefined && typeof prepare !== "function") ||
    (describe !== undefined && typeof describe !== "function") ||
    "execution" in value ||
    "validateReferences" in value
  ) {
    throw new TypeError(
      "Reference plugin must provide non-empty id, validate, and collect functions; optional fileInfo, comparableTarget, prepare, and describe must be functions; legacy execution protocols are unsupported.",
    );
  }
}

function referenceIds(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((reference) => {
    if (typeof reference !== "object" || reference === null) return undefined;
    return (reference as { readonly id?: unknown }).id;
  });
}

function assertReference(value: unknown): asserts value is Reference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(
      "Binding references must be created by plugin-provided reference builders.",
    );
  }
  const reference = value as Reference;
  assertReferenceDefinition(reference);
  if (
    typeof reference.pluginId !== "string" ||
    reference.pluginId.length === 0
  ) {
    throw new TypeError(`Reference ${reference.id} is missing pluginId.`);
  }
  assertDeclarationSource(reference.declaredAt, `Reference ${reference.id}`);
}

function assertReferenceDefinition(value: Reference): void {
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new TypeError("Reference ID must be a non-empty string.");
  }
  if (!Object.hasOwn(value, "target") || !isJsonValue(value.target)) {
    throw new TypeError(
      `Reference ${value.id} target must be a valid JSON value.`,
    );
  }
  if (value.selection !== undefined && !isJsonValue(value.selection)) {
    throw new TypeError(
      `Reference ${value.id} selection must be a valid JSON value.`,
    );
  }
  if (value.note !== undefined && typeof value.note !== "string") {
    throw new TypeError(`Reference ${value.id} note must be a string.`);
  }
}

function assertBindingDefinitionLocal(
  id: unknown,
  referenceIds: unknown,
  note: unknown,
): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError("Binding ID must be a non-empty string.");
  }
  if (!Array.isArray(referenceIds) || referenceIds.length === 0) {
    throw new TypeError(`Reference list for binding ${id} cannot be empty.`);
  }
  const seen = new Set<string>();
  for (const referenceId of referenceIds) {
    if (typeof referenceId !== "string" || referenceId.length === 0) {
      throw new TypeError(
        `Reference ID in binding ${id} must be a non-empty string.`,
      );
    }
    if (seen.has(referenceId)) {
      throw new TypeError(
        `Reference list for binding ${id} contains duplicate ID: ${referenceId}`,
      );
    }
    seen.add(referenceId);
  }
  if (note !== undefined && typeof note !== "string") {
    throw new TypeError(`Binding ${id} note must be a string.`);
  }
}

function sameReferenceDefinition(left: Reference, right: Reference): boolean {
  return (
    left.pluginId === right.pluginId &&
    canonicalJson(left.target) === canonicalJson(right.target) &&
    (left.selection === undefined || right.selection === undefined
      ? left.selection === right.selection
      : canonicalJson(left.selection) === canonicalJson(right.selection))
  );
}

function declarationSources(
  sources: readonly (DeclarationSource | undefined)[],
): DeclarationSource[] {
  return [
    ...new Map(
      sources
        .filter((source): source is DeclarationSource => source !== undefined)
        .map((source) => [
          source instanceof URL ? source.href : source,
          source,
        ]),
    ).values(),
  ];
}

function formatDeclarationSources(
  sources: readonly (DeclarationSource | undefined)[],
): string {
  const locations = declarationSources(sources).map((source) =>
    source instanceof URL ? source.href : source,
  );
  return locations.length === 0
    ? ""
    : `; declaration sources: ${locations.join(", ")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertDeclarationSource(
  source: DeclarationSource | undefined,
  context: string,
): void {
  if (
    source !== undefined &&
    typeof source !== "string" &&
    !(source instanceof URL)
  ) {
    throw new TypeError(`${context} declaredAt must be a path string or URL.`);
  }
}
