import { file } from "@dock/reference-file";
import {
  binding,
  createReference,
  defineConfig,
  definePlugin,
  type Reference,
} from "@dock/sdk";

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

definePlugin<
  "typed-plugin",
  Reference<"typed-plugin", "string-fact", string, string>,
  string
>({
  id: "typed-plugin",
  // @ts-expect-error 插件结果必须符合声明的事实类型。
  collect() {
    return { kind: "value", value: 42 };
  },
});

// @ts-expect-error 普通文件引用当前只支持全文，不接受文本选择器。
file.from("guide.md").reference("selected", { selection: { start: 0 } });

// @ts-expect-error 普通文件目标必须是路径文本或 file: URL。
file.from(42);
