import { file } from "@dock/reference-file";
import { markdown } from "@dock/reference-markdown";
import { binding, defineConfig } from "@dock/sdk";

const sectionHeading =
  process.env.DOCK_MARKDOWN_SHORT_SECTION === "1" ? "安装" : ["指南", "安装"];

export const chapter = markdown
  .from("guide.md")
  .section(sectionHeading)
  .node({ type: "paragraph", contains: "安装片段" })
  .reference("chapter");
export const code = markdown
  .from("guide.md")
  .node({ type: "code", language: "ts", contains: "const answer" })
  .reference("code");
export const list = markdown
  .from("guide.md")
  .node({ type: "listItem", contains: "列表选项" })
  .reference("list");
export const inlineCode = markdown
  .from("guide.md")
  .node({ type: "inlineCode", contains: "内联调用" })
  .reference("inline-code");
export const link = markdown
  .from("guide.md")
  .node({ type: "link", url: "https://example.test/help" })
  .reference("link");
export const table = markdown
  .from("guide.md")
  .node({ type: "table" })
  .reference("table");
export const tableCell = markdown
  .from("guide.md")
  .tableCell({ column: "说明", row: { column: "名称", value: "api" } })
  .reference("table-cell");
export const emptyCell = markdown
  .from("guide.md")
  .tableCell({ column: "说明", row: { column: "名称", value: "空项" } })
  .reference("empty-cell");
export const runtimePort = markdown
  .from("guide.md")
  .section(["指南", "安装"])
  .region("runtime")
  .match("port=(\\d+)", 1)
  .reference("runtime-port");
export const standalone = markdown
  .from("guide.md")
  .section(["指南", "安装"])
  .node({ type: "paragraph", contains: "安装片段" })
  .reference("standalone");
export const directFile = file.from("guide.md").reference("ordinary-file");

export const config = defineConfig({
  plugins: [markdown, file],
  bindings: [
    binding("markdown-policy", [
      chapter,
      code,
      list,
      inlineCode,
      link,
      table,
      tableCell,
      emptyCell,
      runtimePort,
    ]),
    binding("ordinary-file-policy", [directFile]),
  ],
  baseline: "markdown.baseline.json",
});

export default config;
