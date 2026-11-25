import { defineConfig, file, readReference } from "@ykdz/dock";
import { markdown } from "@ykdz/dock/markdown";
import { nodeTest } from "@ykdz/dock/node-test";

const config = defineConfig({ plugins: [markdown], bindings: [] });
const builder = markdown.from("guide.md");
const markdownChapter = builder.section(["指南", "安装"]).reference("chapter");

// @ts-expect-error language only applies to code blocks.
builder.node({ type: "paragraph", language: "ts" });
// @ts-expect-error url only applies to links.
builder.node({ type: "code", url: "https://example.test" });
// @ts-expect-error Undeclared Markdown node types are not supported.
builder.node({ type: "heading" });
// @ts-expect-error Markdown selection must be constructed through public selectors.
builder.reference("invalid", { selection: { kind: "markdown", steps: [] } });
// @ts-expect-error Table row key must explicitly specify both column and value.
builder.tableCell({ column: "值", row: { column: "名称" } });
// @ts-expect-error Marker selector requires a string ID.
builder.marker(42);
// @ts-expect-error Marker selector requires an ID.
builder.marker();

const fileReference = file.from("guide.md").reference("file-only");
// @ts-expect-error Plain file plugin is not registered in this config.
void readReference(config, fileReference);

// @ts-expect-error Config must provide bindings or sources.
defineConfig({ plugins: [] });

// @ts-expect-error Config with only references must still provide bindings or sources.
defineConfig({ plugins: [markdown], references: [markdownChapter] });

// @ts-expect-error Markdown source target must be a path string or file: URL.
markdown.source(42);

// @ts-expect-error Config must register the plugin used by the declaration source.
defineConfig({ plugins: [file], sources: [markdown.source("guide.md")] });

// @ts-expect-error Config must register the plugin used by the declaration source even when another plugin without sources is present.
defineConfig({ plugins: [nodeTest], sources: [markdown.source("guide.md")] });

// @ts-expect-error Config must register the plugin used by standalone references.
defineConfig({ plugins: [file], sources: [], references: [markdownChapter] });

void builder;
