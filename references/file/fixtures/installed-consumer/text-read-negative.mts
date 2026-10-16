import { file, filePluginId } from "@dock/reference-file";
import {
  binding,
  createReference,
  defineConfig,
  definePlugin,
  readReference,
  type PluginContext,
  type PluginReadResult,
  type PluginResult,
  type Reference,
} from "@dock/sdk";

// @ts-expect-error 文本选择只能由公开定位器构造，不能传入任意 JSON 选择。
file.from("guide.md").reference("invalid", { selection: { start: 0 } });

const existsBuilder = file.from("guide.md").exists();
// @ts-expect-error 存在性引用完成后不再提供文本收窄步骤。
existsBuilder.quote("text");

type UnsupportedSelection = { readonly start: number };
const unsupportedSelection = createReference<
  typeof filePluginId,
  "unsupported-selection",
  string,
  string,
  UnsupportedSelection
>(filePluginId, "unsupported-selection", "guide.md", {
  selection: { start: 0 },
});
defineConfig({
  plugins: [file],
  // @ts-expect-error FilePlugin 不接受公开选择器之外的引用声明。
  bindings: [binding("unsupported-policy", [unsupportedSelection])],
});

type UnreadableReference = Reference<
  "fixture:unreadable",
  "unreadable",
  string,
  string
>;
const unreadable = definePlugin({
  id: "fixture:unreadable",
  validate(reference: UnreadableReference): void {
    void reference;
  },
  collect(
    reference: UnreadableReference,
    context: PluginContext,
  ): PluginResult<string> {
    void context;
    return { kind: "value", value: reference.target };
  },
});
const unreadableConfig = defineConfig({ plugins: [unreadable], bindings: [] });
const unreadableReference = createReference<
  "fixture:unreadable",
  "unreadable",
  string,
  string
>("fixture:unreadable", "unreadable", "current-value");
// @ts-expect-error 缺少 read 处理器的插件不能读取引用。
void readReference(unreadableConfig, unreadableReference);

const fileConfig = defineConfig({ plugins: [file], bindings: [] });
const missingPluginReference = createReference(
  "fixture:not-registered",
  "missing-plugin",
  "current-value",
);
// @ts-expect-error 配置没有登记该引用所属插件。
void readReference(fileConfig, missingPluginReference);

type InvalidReaderReference = Reference<
  "fixture:invalid-reader",
  "invalid-reader",
  string,
  number
>;
definePlugin({
  id: "fixture:invalid-reader",
  validate(reference: InvalidReaderReference): void {
    void reference;
  },
  collect(
    reference: InvalidReaderReference,
    context: PluginContext,
  ): PluginResult<number> {
    void reference;
    void context;
    return { kind: "value", value: 1 };
  },
  read(
    reference: InvalidReaderReference,
    context: PluginContext,
  ): PluginReadResult<number> {
    void reference;
    void context;
    // @ts-expect-error 插件声明 number 时不得返回字符串。
    return { value: "not-a-number" };
  },
});
