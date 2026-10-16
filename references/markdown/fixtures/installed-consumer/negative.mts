import { file } from "@dock/reference-file";
import { markdown } from "@dock/reference-markdown";
import { defineConfig, readReference } from "@dock/sdk";

const config = defineConfig({ plugins: [markdown], bindings: [] });
const builder = markdown.from("guide.md");

// @ts-expect-error language 只适用于代码块。
builder.node({ type: "paragraph", language: "ts" });
// @ts-expect-error url 只适用于链接。
builder.node({ type: "code", url: "https://example.test" });
// @ts-expect-error 不支持未声明的 Markdown 节点。
builder.node({ type: "heading" });
// @ts-expect-error Markdown 选择只能由公开定位器构造。
builder.reference("invalid", { selection: { kind: "markdown", steps: [] } });
// @ts-expect-error 表格行键必须明确提供列和值。
builder.tableCell({ column: "值", row: { column: "名称" } });

const fileReference = file.from("guide.md").reference("file-only");
// @ts-expect-error 当前配置未登记普通文件插件。
void readReference(config, fileReference);

void builder;
