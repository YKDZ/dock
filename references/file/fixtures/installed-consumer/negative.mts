import {
  binding,
  createReference,
  defineConfig,
  definePlugin,
  readReference,
  type Config,
  type PluginBatchResult,
  type PluginContext,
  type PluginReadResult,
  type PluginRequest,
  type PluginResult,
  type Reference,
} from "@ykdz/dock";
import { file } from "@ykdz/dock-reference-file";

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

type HookReference = Reference<"hook-plugin", "hook-reference", string, string>;
type WrongHookReference = Reference<
  "hook-plugin",
  "hook-reference",
  { readonly path: string },
  string
>;

// @ts-expect-error fileInfo 必须接受与 validate 相同的引用类型。
definePlugin({
  id: "hook-plugin",
  validate(_reference: HookReference): void {},
  collect(request: PluginRequest<HookReference>): PluginBatchResult<string> {
    return {
      results: request.selectedReferences.map(({ id }) => ({
        referenceId: id,
        kind: "value",
        value: "ok",
      })),
    };
  },
  fileInfo(reference: WrongHookReference): string {
    return reference.target.path.toUpperCase();
  },
});

// @ts-expect-error prepare 必须接收同一插件声明的引用类型。
definePlugin({
  id: "hook-plugin",
  validate(_reference: HookReference): void {},
  prepare(references: readonly WrongHookReference[]): undefined {
    for (const reference of references) void reference.target.path;
    return undefined;
  },
  collect(request: PluginRequest<HookReference>): PluginBatchResult<string> {
    return {
      results: request.selectedReferences.map(({ id }) => ({
        referenceId: id,
        kind: "value",
        value: "ok",
      })),
    };
  },
});

type StringFactReference = Reference<
  "typed-plugin",
  "string-fact",
  string,
  string
>;
const invalidPlugin = {
  id: "typed-plugin",
  validate(_reference: StringFactReference): void {},
  collect(
    request: PluginRequest<StringFactReference>,
  ): PluginBatchResult<string> {
    return {
      // @ts-expect-error 成功结果必须符合插件声明的 string 类型。
      results: request.selectedReferences.map(({ id }) => ({
        referenceId: id,
        kind: "value",
        value: 42,
      })),
    };
  },
};
definePlugin(invalidPlugin);

type PreparedReference = Reference<
  "prepared-plugin",
  "prepared-reference",
  string,
  string
>;
// @ts-expect-error collect 必须接受 prepare 返回的准备数据类型。
definePlugin({
  id: "prepared-plugin",
  validate(_reference: PreparedReference): void {},
  prepare(): { count: number } {
    return { count: 1 };
  },
  collect(
    _request: PluginRequest<PreparedReference, { count: string }>,
  ): PluginBatchResult<string> {
    return { results: [] };
  },
});

type StringReaderReference = Reference<
  "typed-reader",
  "string-reader",
  string,
  string
>;

// @ts-expect-error 插件采集成功值必须符合引用声明的 string 类型。
definePlugin({
  id: "typed-reader",
  validate(_reference: StringReaderReference): void {},
  collect(
    _request: PluginRequest<StringReaderReference>,
  ): PluginBatchResult<number> {
    return { results: [] };
  },
});

// @ts-expect-error 插件读取成功值必须符合引用声明的 string 类型。
definePlugin({
  id: "typed-reader",
  validate(_reference: StringReaderReference): void {},
  collect(
    _request: PluginRequest<StringReaderReference>,
  ): PluginBatchResult<string> {
    return { results: [] };
  },
  read(_reference: StringReaderReference): PluginReadResult<number> {
    return { value: 42 };
  },
});

const directConfigMismatch = {
  id: "typed-reader",
  validate(_reference: StringReaderReference): void {},
  collect(
    _request: PluginRequest<StringReaderReference>,
  ): PluginBatchResult<number> {
    return { results: [] };
  },
  read(_reference: StringReaderReference): PluginReadResult<number> {
    return { value: 42 };
  },
};
// @ts-expect-error defineConfig 也必须拒绝未经过 definePlugin 的错配实现。
defineConfig({ plugins: [directConfigMismatch], bindings: [] });

type WantedReference = Reference<"wanted", "registration", string, string>;
const wantedReference = createReference<
  "wanted",
  "registration",
  string,
  string
>("wanted", "registration", "target");

// @ts-expect-error definePlugin 应拒绝与静态引用身份不符的插件 ID。
definePlugin({
  id: "other",
  validate(_reference: WantedReference): void {},
  collect(request: PluginRequest<WantedReference>): PluginBatchResult<string> {
    return {
      results: request.selectedReferences.map(({ id }) => ({
        referenceId: id,
        kind: "value",
        value: "ok",
      })),
    };
  },
});

type MismatchedReadablePlugin = {
  readonly id: "other";
  validate(reference: WantedReference): void;
  collect(
    request: PluginRequest<WantedReference>,
    context: PluginContext,
  ): PluginBatchResult<string>;
  read(
    reference: WantedReference,
    context: PluginContext,
  ): PluginReadResult<string>;
};
declare const mismatchedConfig: Config<
  readonly [MismatchedReadablePlugin],
  readonly []
>;
// @ts-expect-error 读取类型推导不能接受 ID 不符的处理器。
void readReference(mismatchedConfig, wantedReference);

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

defineConfig({
  plugins: [file],
  // @ts-expect-error 配置仍检查每条引用的插件注册。
  bindings: [binding("catalog", [wantedReference])],
});

// @ts-expect-error 组合配置的 binding 仍需由当前注册插件提供。
defineConfig({ plugins: [file], bindings: splitConfig.bindings });
