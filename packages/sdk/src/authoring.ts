import { isJsonValue, type JsonValue } from "@dock/core";

import type {
  Binding,
  Config,
  ConfigInput,
  DeclarationSource,
  Reference,
  ReferencePlugin,
} from "./contracts.ts";

export type {
  Binding,
  Config,
  DeclarationSource,
  Reference,
} from "./contracts.ts";

export type ReferenceOptions = {
  readonly selection?: JsonValue;
  readonly note?: string;
  readonly declaredAt?: DeclarationSource;
};

export function createReference<
  PluginId extends string,
  Id extends string,
  Target extends JsonValue,
  Value extends JsonValue = JsonValue,
>(
  pluginId: PluginId,
  id: Id,
  target: Target,
  options: ReferenceOptions = {},
): Reference<PluginId, Id, Target, Value> {
  const result = {
    id,
    pluginId,
    target,
    ...options,
  };
  assertReferenceDefinition(result);
  assertDeclarationSource(result.declaredAt, `引用 ${id}`);
  return result;
}

export function definePlugin<
  PluginId extends string,
  Ref extends Reference<PluginId>,
  Value extends JsonValue,
>(
  plugin: ReferencePlugin<PluginId, Ref, Value>,
): ReferencePlugin<PluginId, Ref, Value> {
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
  assertDeclarationSource(options.declaredAt, `关联 ${id}`);
  return { id, references, ...options };
}

export function defineConfig<const Plugins extends readonly ReferencePlugin[]>(
  input: ConfigInput<Plugins>,
): Config<Plugins> {
  validateConfig(input);
  return input;
}

export function validateConfig(value: unknown): asserts value is Config {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("配置入口必须导出对象。");
  }
  const config = value as Record<string, unknown>;
  if (!Array.isArray(config.plugins)) {
    throw new TypeError("配置必须提供 plugins 插件列表。");
  }
  const plugins = new Map<string, ReferencePlugin>();
  for (const candidate of config.plugins) {
    assertPlugin(candidate);
    if (plugins.has(candidate.id)) {
      throw new TypeError(`引用插件身份重复：${candidate.id}`);
    }
    plugins.set(candidate.id, candidate);
  }

  if (!Array.isArray(config.bindings)) {
    throw new TypeError("配置必须提供 bindings 关联列表。");
  }
  if (
    config.root !== undefined &&
    (typeof config.root !== "string" || config.root.length === 0)
  ) {
    throw new TypeError("配置 root 必须是非空路径文本。");
  }
  if (
    config.baseline !== undefined &&
    (typeof config.baseline !== "string" || config.baseline.length === 0)
  ) {
    throw new TypeError("配置 baseline 必须是非空路径文本。");
  }
  if (config.declarationSources !== undefined) {
    if (!Array.isArray(config.declarationSources)) {
      throw new TypeError("配置 declarationSources 必须是来源列表。");
    }
    for (const source of config.declarationSources) {
      assertDeclarationSource(source, "配置 declarationSources");
    }
  }

  const bindings = new Map<string, Binding>();
  const references = new Map<string, Reference>();
  for (const candidate of config.bindings) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new TypeError("关联声明必须是对象。");
    }
    const current = candidate as Binding;
    assertBindingDefinitionLocal(
      current.id,
      Array.isArray(current.references)
        ? current.references.map((reference) => reference.id)
        : current.references,
      current.note,
    );
    assertDeclarationSource(current.declaredAt, `关联 ${current.id}`);
    const priorBinding = bindings.get(current.id);
    if (priorBinding !== undefined) {
      throw new TypeError(
        `关联身份重复：${current.id}${formatDeclarationSources([priorBinding.declaredAt, current.declaredAt])}`,
      );
    }
    bindings.set(current.id, current);

    for (const reference of current.references) {
      assertReference(reference);
      const plugin = plugins.get(reference.pluginId);
      if (plugin === undefined) {
        throw new TypeError(
          `引用 ${reference.id} 使用了未登记插件：${reference.pluginId}${formatDeclarationSources([reference.declaredAt])}`,
        );
      }
      if (!isPluginReference(plugin, reference)) {
        throw new TypeError(
          `插件 ${reference.pluginId} 不支持引用 ${reference.id} 的声明类型。`,
        );
      }
      plugin.validate?.(reference);
      const prior = references.get(reference.id);
      if (prior !== undefined && !sameReferenceDefinition(prior, reference)) {
        throw new TypeError(
          `引用身份 ${reference.id} 对应多个不同定义${formatDeclarationSources([prior.declaredAt, reference.declaredAt])}。`,
        );
      }
      if (prior === undefined) references.set(reference.id, reference);
    }
  }
}

function assertPlugin(value: unknown): asserts value is ReferencePlugin {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { id?: unknown }).id !== "string" ||
    (value as { id: string }).id.length === 0 ||
    typeof (value as { collect?: unknown }).collect !== "function" ||
    ((value as { validate?: unknown }).validate !== undefined &&
      typeof (value as { validate?: unknown }).validate !== "function")
  ) {
    throw new TypeError(
      "引用插件必须提供非空 id 和 collect 函数；validate 若提供必须为函数。",
    );
  }
}

function assertReference(value: unknown): asserts value is Reference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("关联引用必须由插件提供的引用声明构造器创建。");
  }
  const reference = value as Reference;
  assertReferenceDefinition(reference);
  if (
    typeof reference.pluginId !== "string" ||
    reference.pluginId.length === 0
  ) {
    throw new TypeError(`引用 ${reference.id} 缺少插件身份。`);
  }
  assertDeclarationSource(reference.declaredAt, `引用 ${reference.id}`);
}

function assertReferenceDefinition(value: Reference): void {
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new TypeError("引用 ID 必须是非空文本。");
  }
  if (!Object.hasOwn(value, "target") || !isJsonValue(value.target)) {
    throw new TypeError(`引用 ${value.id} 的 target 必须是有效 JSON 值。`);
  }
  if (value.selection !== undefined && !isJsonValue(value.selection)) {
    throw new TypeError(`引用 ${value.id} 的 selection 必须是有效 JSON 值。`);
  }
  if (value.note !== undefined && typeof value.note !== "string") {
    throw new TypeError(`引用 ${value.id} 的 note 必须是文本。`);
  }
}

function assertBindingDefinitionLocal(
  id: unknown,
  referenceIds: unknown,
  note: unknown,
): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError("关联 ID 必须是非空文本。");
  }
  if (!Array.isArray(referenceIds) || referenceIds.length === 0) {
    throw new TypeError(`关联 ${id} 的引用集合不能为空。`);
  }
  const seen = new Set<string>();
  for (const referenceId of referenceIds) {
    if (typeof referenceId !== "string" || referenceId.length === 0) {
      throw new TypeError(`关联 ${id} 的引用 ID 必须是非空文本。`);
    }
    if (seen.has(referenceId)) {
      throw new TypeError(`关联 ${id} 的引用集合包含重复身份：${referenceId}`);
    }
    seen.add(referenceId);
  }
  if (note !== undefined && typeof note !== "string") {
    throw new TypeError(`关联 ${id} 的 note 必须是文本。`);
  }
}

function isPluginReference(
  plugin: ReferencePlugin,
  reference: Reference,
): boolean {
  return plugin.id === reference.pluginId;
}

function sameReferenceDefinition(left: Reference, right: Reference): boolean {
  return (
    left.pluginId === right.pluginId &&
    canonicalJson(left.target) === canonicalJson(right.target) &&
    canonicalJson(left.selection) === canonicalJson(right.selection)
  );
}

function canonicalJson(value: JsonValue | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

function formatDeclarationSources(
  sources: readonly (DeclarationSource | undefined)[],
): string {
  const locations = [
    ...new Set(
      sources
        .filter((source): source is DeclarationSource => source !== undefined)
        .map((source) => (source instanceof URL ? source.href : source)),
    ),
  ];
  return locations.length === 0 ? "" : `；声明来源：${locations.join("、")}`;
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
    throw new TypeError(`${context} 的 declaredAt 必须是路径文本或 URL。`);
  }
}
