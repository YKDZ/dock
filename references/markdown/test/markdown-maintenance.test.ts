import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { file } from "@dock/reference-file";
import { defineConfig, readReference } from "@dock/sdk";

import { markdown } from "../src/index.ts";

async function withDocument<T>(
  source: string,
  run: (root: string, config: ReturnType<typeof createConfig>) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "dock-markdown-test-"));
  try {
    await writeFile(join(root, "guide.md"), source, "utf8");
    return await run(root, createConfig(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createConfig(root: string) {
  return defineConfig({ plugins: [markdown], bindings: [], root });
}

test("章节、完整标题路径和文本步骤连续取得原文 UTF-16 范围", async () => {
  const source =
    "😀前言\n\n# 概览\n\n## 状态\n\n  保留缩进：结果🟢\n\n> ## 内嵌标题\n> 仍属于本章节。\n\n# 其他\n\n## 状态\n\n另一个状态。\n";
  await withDocument(source, async (_root, config) => {
    const section = markdown.from("guide.md").section(["概览", "状态"]);
    const body = await readReference(
      config,
      markdown.from("guide.md").section(["概览", "状态"]).reference("body"),
    );
    assert.match(body.value, /^  保留缩进/u);
    assert.match(body.value, /> ## 内嵌标题/u);

    const selected = await readReference(
      config,
      section
        .node({ type: "paragraph", contains: "结果" })
        .quote("结果🟢")
        .reference("value"),
    );
    assert.equal(selected.value, "结果🟢");
    assert.equal(
      source.slice(selected.range!.start, selected.range!.end),
      selected.value,
    );
    assert.equal(selected.range!.start, source.indexOf("结果🟢"));

    await assert.rejects(
      readReference(
        config,
        markdown.from("guide.md").section("状态").reference("ambiguous"),
      ),
      /匹配到 2 处/u,
    );
  });
});

test("六类结构节点与表格行键选择保留 Markdown 原文", async () => {
  const source = [
    "一段正文。",
    "",
    "- 列表项目。",
    "",
    "```ts",
    "const answer = 42;",
    "```",
    "",
    "行内 `调用函数()` 与 [帮助链接](https://example.test/help)。",
    "",
    "| 名称 | 说明 |",
    "| --- | --- |",
    "| api | **当前值** |",
    "| 空项 |  |",
    "",
  ].join("\n");
  await withDocument(source, async (_root, config) => {
    const selectors = [
      [
        markdown
          .from("guide.md")
          .node({ type: "paragraph", contains: "正文" })
          .reference("paragraph"),
        "一段正文。",
      ],
      [
        markdown
          .from("guide.md")
          .node({ type: "listItem", contains: "列表项目" })
          .reference("list"),
        "- 列表项目。",
      ],
      [
        markdown
          .from("guide.md")
          .node({ type: "code", language: "ts" })
          .reference("code"),
        "```ts\nconst answer = 42;\n```",
      ],
      [
        markdown
          .from("guide.md")
          .node({ type: "inlineCode", contains: "调用函数" })
          .reference("inline"),
        "`调用函数()`",
      ],
      [
        markdown
          .from("guide.md")
          .node({ type: "link", url: "https://example.test/help" })
          .reference("link"),
        "[帮助链接](https://example.test/help)",
      ],
      [
        markdown.from("guide.md").node({ type: "table" }).reference("table"),
        [
          "| 名称 | 说明 |",
          "| --- | --- |",
          "| api | **当前值** |",
          "| 空项 |  |",
        ].join("\n"),
      ],
      [
        markdown
          .from("guide.md")
          .tableCell({ column: "说明", row: { column: "名称", value: "api" } })
          .reference("cell"),
        "**当前值**",
      ],
    ] as const;
    for (const [reference, expected] of selectors) {
      const result = await readReference(config, reference);
      assert.equal(result.value, expected);
      assert.equal(
        source.slice(result.range!.start, result.range!.end),
        expected,
      );
    }

    const empty = await readReference(
      config,
      markdown
        .from("guide.md")
        .tableCell({ column: "说明", row: { column: "名称", value: "空项" } })
        .reference("empty"),
    );
    assert.equal(empty.value, "");
    assert.equal(empty.range!.start, empty.range!.end);
    assert.equal(source[empty.range!.start - 1], " ");
    assert.equal(source[empty.range!.end], "|");
  });
});

test("重复标题路径、表格列和行键明确报告歧义", async () => {
  const duplicateSections =
    "# 根\n\n## 同名\n\n第一段。\n\n## 同名\n\n第二段。\n";
  await withDocument(duplicateSections, async (_root, config) => {
    await assert.rejects(
      readReference(
        config,
        markdown.from("guide.md").section(["根", "同名"]).reference("section"),
      ),
      /匹配到 2 处/u,
    );
  });

  const duplicateColumns =
    "| 名称 | 值 | 值 |\n| --- | --- | --- |\n| api | 一 | 二 |\n";
  await withDocument(duplicateColumns, async (_root, config) => {
    await assert.rejects(
      readReference(
        config,
        markdown
          .from("guide.md")
          .tableCell({ column: "值", row: { column: "名称", value: "api" } })
          .reference("column"),
      ),
      /列标题重复/u,
    );
  });

  const duplicateRows =
    "| 名称 | 值 |\n| --- | --- |\n| api | 一 |\n| api | 二 |\n";
  await withDocument(duplicateRows, async (_root, config) => {
    await assert.rejects(
      readReference(
        config,
        markdown
          .from("guide.md")
          .tableCell({ column: "值", row: { column: "名称", value: "api" } })
          .reference("row"),
      ),
      /行键值重复/u,
    );
  });
});

test("同一 Markdown 文件显式选普通文件插件时保留原文", async () => {
  const source = "# 标题\n\n<!-- 普通注释 -->\n";
  await withDocument(source, async (root) => {
    const config = defineConfig({
      plugins: [file, markdown],
      bindings: [],
      root,
    });
    const reference = file.from("guide.md").reference("whole");
    const result = await readReference(config, reference);
    assert.equal(await readFile(join(root, "guide.md"), "utf8"), result.value);
  });
});
