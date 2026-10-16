import { file } from "@dock/reference-file";
import { markdown, type MarkdownReference } from "@dock/reference-markdown";
import {
  binding,
  defineConfig,
  readReference,
  type PluginReadResult,
  type ReferenceValue,
} from "@dock/sdk";

const chapter = markdown
  .from("guide.md")
  .section(["指南", "安装"])
  .node({ type: "code", language: "ts" })
  .match("(const answer = \\d+)", 1)
  .reference("answer");
const standalone: MarkdownReference<"standalone"> = markdown
  .from("guide.md")
  .node({ type: "paragraph", contains: "单独读取" })
  .reference("standalone");
const table = markdown
  .from("guide.md")
  .node({ type: "table" })
  .reference("table");
const directFile = file
  .from("guide.md")
  .quote("普通文本")
  .reference("file-text");
const config = defineConfig({
  plugins: [markdown, file],
  bindings: [binding("guide-policy", [chapter, table, directFile])],
});

const markdownValue: Promise<PluginReadResult<string>> = readReference(
  config,
  chapter,
);
const independentRead: Promise<PluginReadResult<string>> = readReference(
  config,
  standalone,
);
const tableRead: Promise<PluginReadResult<string>> = readReference(
  config,
  table,
);
const fileValue: Promise<PluginReadResult<string>> = readReference(
  config,
  directFile,
);
const selectedValue: ReferenceValue<typeof chapter> = "const answer = 42";

void markdownValue;
void independentRead;
void tableRead;
void fileValue;
void selectedValue;
