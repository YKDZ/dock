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

test("标记选择读取段内当前内容并返回原文 UTF-16 范围", async () => {
  const source =
    "😀前言\n\n说明 <!-- dock:start port -->4173<!-- dock:end port --> 结束。\n";
  await withDocument(source, async (root, config) => {
    const reference = markdown
      .from("guide.md")
      .marker("port")
      .reference("port");

    const read = await readReference(config, reference);
    assert.equal(read.value, "4173");
    assert.deepEqual(read.range, {
      path: "guide.md",
      start: source.indexOf("4173"),
      end: source.indexOf("4173") + "4173".length,
    });
    assert.equal(source.slice(read.range!.start, read.range!.end), read.value);

    assert.deepEqual(await markdown.collect(reference, { root }), {
      kind: "value",
      value: read.value,
      range: read.range,
    });
  });
});

test("比较事实只移除真实定位注释并保留普通注释与示例文字", async () => {
  const source = [
    "😀事实 <!-- dock:start port -->4173<!-- dock:end port -->。",
    "<!-- 普通注释 -->",
    "",
    "```md",
    "<!-- dock:start code -->示例<!-- dock:end code -->",
    "```",
    "",
    "行内 `<!-- dock:start inline -->示例<!-- dock:end inline -->`。",
    '<div title="<!-- dock:start attribute -->"></div>',
    '<script>const text = "<!-- dock:start script -->";</script>',
    "",
  ].join("\n");
  await withDocument(source, async (root, config) => {
    const reference = markdown.from("guide.md").reference("whole");
    const read = await readReference(config, reference);
    assert.equal(
      read.value,
      [
        "😀事实 4173。",
        "<!-- 普通注释 -->",
        "",
        "```md",
        "<!-- dock:start code -->示例<!-- dock:end code -->",
        "```",
        "",
        "行内 `<!-- dock:start inline -->示例<!-- dock:end inline -->`。",
        '<div title="<!-- dock:start attribute -->"></div>',
        '<script>const text = "<!-- dock:start script -->";</script>',
        "",
      ].join("\n"),
    );
    assert.deepEqual(read.range, {
      path: "guide.md",
      start: 0,
      end: source.length,
    });
    assert.deepEqual(await markdown.collect(reference, { root }), {
      kind: "value",
      value: read.value,
      range: read.range,
    });
  });
});

test("标记支持段落、表格单元格、跨块及有序连续收窄", async () => {
  const paragraph =
    "# 安装\n\n默认端口 <!-- dock:start port -->4173<!-- dock:end port -->。\n";
  await withDocument(paragraph, async (_root, config) => {
    const result = await readReference(
      config,
      markdown
        .from("guide.md")
        .section("安装")
        .marker("port")
        .reference("port"),
    );
    assert.equal(result.value, "4173");
    assert.equal(
      paragraph.slice(result.range!.start, result.range!.end),
      "4173",
    );
  });

  const table = [
    "| 名称 | 说明 |",
    "| --- | --- |",
    "| api | 当前值 <!-- dock:start api -->4173<!-- dock:end api --> |",
    "",
  ].join("\n");
  await withDocument(table, async (_root, config) => {
    const result = await readReference(
      config,
      markdown.from("guide.md").marker("api").reference("api"),
    );
    assert.equal(result.value, "4173");
    assert.equal(table.slice(result.range!.start, result.range!.end), "4173");
  });

  const blocks =
    "<!-- dock:start scope -->\n\n第一段。\n\n- 第二块\n\n<!-- dock:end scope -->";
  await withDocument(blocks, async (_root, config) => {
    const reference = markdown.from("guide.md").marker("scope");
    const full = await readReference(config, reference.reference("scope"));
    assert.equal(full.value, "\n\n第一段。\n\n- 第二块\n\n");
    assert.equal(blocks.slice(full.range!.start, full.range!.end), full.value);

    const narrowed = await readReference(
      config,
      reference
        .node({ type: "listItem", contains: "第二块" })
        .reference("item"),
    );
    assert.equal(narrowed.value, "- 第二块");
    assert.equal(
      blocks.slice(narrowed.range!.start, narrowed.range!.end),
      "- 第二块",
    );
  });
});

test("标记缺失、重复、倒序及越出当前结构范围时明确失败", async () => {
  const cases: {
    readonly source: string;
    readonly id: string;
    readonly selection?: (
      builder: ReturnType<typeof markdown.from>,
    ) => ReturnType<typeof markdown.from>;
    readonly code: string;
  }[] = [
    {
      source: "<!-- dock:end value -->正文",
      id: "value",
      code: "missing-selection",
    },
    {
      source: "<!-- dock:start value -->正文",
      id: "value",
      code: "missing-selection",
    },
    {
      source: "<!-- dock:start value extra -->正文<!-- dock:end value -->",
      id: "value",
      code: "missing-selection",
    },
    {
      source: "<!-- dock:start first -->正文<!-- dock:end second -->",
      id: "first",
      code: "missing-selection",
    },
    {
      source:
        "<!-- dock:start value -->一<!-- dock:start value -->二<!-- dock:end value -->",
      id: "value",
      code: "ambiguous-selection",
    },
    {
      source:
        "<!-- dock:start value -->一<!-- dock:end value --><!-- dock:end value -->",
      id: "value",
      code: "ambiguous-selection",
    },
    {
      source: "<!-- dock:end value -->正文<!-- dock:start value -->",
      id: "value",
      code: "invalid-selector",
    },
    {
      source:
        "# 第一节\n\n普通内容。\n\n# 第二节\n\n<!-- dock:start value -->4173<!-- dock:end value -->",
      id: "value",
      selection: (builder) => builder.section("第一节"),
      code: "missing-selection",
    },
    {
      source:
        "# 第一节\n\n<!-- dock:start value -->一<!-- dock:end value -->\n\n# 第二节\n\n<!-- dock:start value -->二<!-- dock:end value -->",
      id: "value",
      selection: (builder) => builder.section("第一节"),
      code: "ambiguous-selection",
    },
    {
      source: [
        "```md",
        "<!-- dock:start value -->示例<!-- dock:end value -->",
        "```",
        "",
        "`<!-- dock:start value -->行内示例<!-- dock:end value -->`",
        '<div title="<!-- dock:start value -->"></div>',
        '<script>const text = "<!-- dock:start value -->";</script>',
      ].join("\n"),
      id: "value",
      code: "missing-selection",
    },
  ];

  for (const example of cases) {
    await withDocument(example.source, async (_root, config) => {
      let builder = markdown.from("guide.md");
      if (example.selection !== undefined) {
        builder = example.selection(builder);
      }
      const reference = builder.marker(example.id).reference("value");
      await assert.rejects(
        readReference(config, reference),
        (error: unknown) => {
          return (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === example.code
          );
        },
        example.source,
      );
      const collected = await markdown.collect(reference, { root: _root });
      assert.equal(collected.kind, "error", example.source);
      if (collected.kind === "error") {
        assert.equal(collected.error.code, example.code, example.source);
      }
    });
  }
});
