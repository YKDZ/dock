import { file } from "@dock/reference-file";
import {
  binding,
  createReference,
  defineConfig,
  definePlugin,
  type PluginReadResult,
  type PluginResult,
  type Reference,
  type ReferencePlugin,
} from "@dock/sdk";

import { splitConfig } from "./composition.mjs";
import { catalogReference } from "./external-plugin.mjs";

// @ts-expect-error 关联至少需要一条引用。
binding("empty", []);

const missingPlugin = createReference<
  "unregistered-plugin",
  "unregistered-reference",
  string,
  string
>("unregistered-plugin", "unregistered-reference", "guide.md");

const invalidBinding = binding("invalid-policy", [missingPlugin]);

defineConfig({
  plugins: [file],
  // @ts-expect-error 配置必须登记引用声明使用的插件。
  bindings: [invalidBinding],
});

// @ts-expect-error 配置入口必须显式提供 bindings 列表。
defineConfig({ plugins: [] });

// @ts-expect-error 配置入口必须显式提供 plugins 列表。
defineConfig({ bindings: [] });

type StringFactReference = Reference<
  "typed-plugin",
  "string-fact",
  string,
  string
>;

const invalidPlugin = {
  id: "typed-plugin",
  validate(_reference: StringFactReference): void {},
  collect(_reference: StringFactReference): PluginResult<string> {
    // @ts-expect-error 插件结果必须符合声明的事实类型。
    return { kind: "value", value: 42 };
  },
} satisfies ReferencePlugin<"typed-plugin", StringFactReference, string>;

definePlugin(invalidPlugin);

type StringReaderReference = Reference<
  "typed-reader",
  "string-reader",
  string,
  string
>;

// @ts-expect-error 插件采集成功值必须符合引用声明的 string 类型。
const inconsistentCollector = definePlugin({
  id: "typed-collector",
  validate(_reference: StringReaderReference): void {},
  collect(_reference: StringReaderReference): PluginResult<number> {
    return { kind: "value", value: 42 };
  },
});
void inconsistentCollector;

// @ts-expect-error 插件读取成功值必须符合引用声明的 string 类型。
const inconsistentReader = definePlugin({
  id: "typed-reader",
  validate(_reference: StringReaderReference): void {},
  collect(_reference: StringReaderReference): PluginResult<string> {
    return { kind: "value", value: "correct" };
  },
  read(_reference: StringReaderReference): PluginReadResult<number> {
    return { value: 42 };
  },
});
void inconsistentReader;

const directConfigMismatch = {
  id: "typed-direct-config",
  validate(_reference: StringReaderReference): void {},
  collect(_reference: StringReaderReference): PluginResult<number> {
    return { kind: "value", value: 42 };
  },
  read(_reference: StringReaderReference): PluginReadResult<number> {
    return { value: 42 };
  },
};
// @ts-expect-error defineConfig 也必须拒绝未经过 definePlugin 的错配实现。
defineConfig({ plugins: [directConfigMismatch], bindings: [] });

const invalidCollection: PluginResult<string> = {
  kind: "collection",
  collection: {
    completeness: "complete",
    members: [
      {
        id: "invalid-string-member",
        // @ts-expect-error 成员成功值必须符合插件声明的 string 类型。
        value: 42,
      },
    ],
  },
};
void invalidCollection;

// @ts-expect-error 普通文件引用当前只支持全文，不接受文本选择器。
file.from("guide.md").reference("selected", { selection: { start: 0 } });

// @ts-expect-error 普通文件目标必须是路径文本或 file: URL。
file.from(42);

// @ts-expect-error 目录目标需要具体 path 和 kind。
catalogReference("bad-target", { path: "x" }, { field: "title" });

catalogReference(
  "bad-selection",
  { kind: "catalog", path: "x" },
  // @ts-expect-error 目录选择不接受未声明字段。
  { field: "summary" },
);

// @ts-expect-error 自由拆分后 config 仍检查每条引用的插件注册。
defineConfig({ plugins: [file], bindings: splitConfig.bindings });
