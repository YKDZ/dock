import { binding, defineConfig } from "@ykdz/dock";
import { file } from "@ykdz/dock-reference-file";
import { markdown } from "@ykdz/dock-reference-markdown";

const guideTarget = process.env.DOCK_MARKDOWN_TARGET ?? "guide.md";
const sectionHeading =
  process.env.DOCK_MARKDOWN_SHORT_SECTION === "1" ? "安装" : ["指南", "安装"];

export const chapter = markdown
  .from(guideTarget)
  .section(sectionHeading)
  .node({ type: "paragraph", contains: "安装片段" })
  .reference("chapter");
export const stablePort = markdown
  .from("guide.md")
  .section("标记位置")
  .marker("stable-port")
  .reference("stable-port");
export const standaloneMarker = markdown
  .from("guide.md")
  .marker("standalone")
  .reference("standalone-marker");
export const markerDocument = markdown
  .from("markers-guide.md")
  .reference("marker-document");
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
      stablePort,
      code,
      list,
      inlineCode,
      link,
      table,
      tableCell,
      emptyCell,
      runtimePort,
    ]),
    binding("marker-document-policy", [markerDocument]),
    binding("ordinary-file-policy", [directFile]),
  ],
  baseline: "markdown.baseline.json",
});

export default config;
