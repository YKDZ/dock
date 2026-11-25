import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { binding, check, defineConfig, file, readReference } from "@ykdz/dock";
import { markdown, markdownPluginId } from "@ykdz/dock/markdown";

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

void test("markdown plugin preserves legacy plugin ID", () => {
  assert.equal(markdownPluginId, "@ykdz/dock-reference-markdown");
  assert.equal(markdown.id, "@ykdz/dock-reference-markdown");
});

void test("section, full heading path, and text steps sequentially select source UTF-16 ranges", async () => {
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
      /Found 2 matches/u,
    );
  });
});

void test("six node selectors and table cell row key selection preserve Markdown source text", async () => {
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

  const emptyCellEdgeCases = [
    {
      name: "quoted-table",
      source: "> | 名称 | 值 |\n> | --- | --- |\n> | api |  |\n",
    },
    {
      name: "unmatched-backtick",
      source:
        "| 名称 | 文本 | 值 |\n| --- | --- | --- |\n| api | `未闭合 |  |\n",
    },
    {
      name: "code-pipe-delimiter",
      source:
        "| 名称 | A | B | 值 |\n| --- | --- | --- | --- |\n| api | `a|b` |  |\n",
    },
  ] as const;
  for (const edgeCase of emptyCellEdgeCases) {
    await withDocument(edgeCase.source, async (root, config) => {
      const cell = markdown
        .from("guide.md")
        .tableCell({ column: "值", row: { column: "名称", value: "api" } })
        .reference("cell");
      const read = await readReference(config, cell);
      assert.equal(read.value, "", edgeCase.name);
      assert.equal(
        read.range?.start,
        edgeCase.source.indexOf("|  |") + 3,
        edgeCase.name,
      );
      assert.equal(read.range?.end, read.range?.start, edgeCase.name);
      assert.equal(edgeCase.source[read.range.start - 1], " ", edgeCase.name);
      assert.equal(edgeCase.source[read.range.end], "|", edgeCase.name);

      const batchConfig = defineConfig({
        root,
        plugins: [markdown],
        bindings: [binding("policy", [cell])],
      });
      const report = await check(batchConfig);
      assert.equal(
        report.bindings[0]?.current?.references.cell?.value,
        "",
        edgeCase.name,
      );
    });
  }
});

void test("duplicate heading paths, table columns, and row keys explicitly report ambiguity", async () => {
  const duplicateSections =
    "# 根\n\n## 同名\n\n第一段。\n\n## 同名\n\n第二段。\n";
  await withDocument(duplicateSections, async (_root, config) => {
    await assert.rejects(
      readReference(
        config,
        markdown.from("guide.md").section(["根", "同名"]).reference("section"),
      ),
      /Found 2 matches/u,
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
      /Duplicate row key column or target column header/u,
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
      /Duplicate row key value/u,
    );
  });
});

void test("plain file plugin preserves raw text when registered alongside markdown plugin", async () => {
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

void test("marker selection reads content between markers and returns source UTF-16 range", async () => {
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
    assert.equal(source.slice(read.range.start, read.range.end), read.value);

    const report = await check(
      defineConfig({
        root,
        plugins: [markdown],
        bindings: [binding("port-policy", [reference])],
      }),
    );
    const checked = report.bindings[0];
    assert.ok(checked && "current" in checked);
    assert.equal(checked.current.references.port?.value, read.value);
    assert.deepEqual(checked.current.references.port?.range, read.range);
  });
});

void test("marker-like comments inside inline script strings do not participate in marker selection or fact stripping", async () => {
  const script =
    '前文 <script>const example = "<!-- dock:start sample -->fake<!-- dock:end sample -->";</script> 后文';
  await withDocument(script, async (_root, config) => {
    const selection = markdown.from("guide.md").marker("sample");
    await assert.rejects(
      readReference(config, selection.reference("sample")),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "missing-selection",
    );

    const whole = await readReference(
      config,
      markdown.from("guide.md").reference("whole"),
    );
    assert.equal(whole.value, script);

    const withReal = `${script}\n\n<!-- dock:start sample -->real<!-- dock:end sample -->`;
    await writeFile(join(_root, "guide.md"), withReal, "utf8");
    const selected = await readReference(config, selection.reference("sample"));
    assert.equal(selected.value, "real");
    assert.equal(
      withReal.slice(selected.range!.start, selected.range!.end),
      "real",
    );
    const fact = await readReference(
      config,
      markdown.from("guide.md").reference("whole"),
    );
    assert.equal(fact.value, `${script}\n\nreal`);
  });
});

void test("markdown fact strips only real dock markers while preserving ordinary comments and sample text", async () => {
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
    const report = await check(
      defineConfig({
        root,
        plugins: [markdown],
        bindings: [binding("whole-document", [reference])],
      }),
    );
    const checked = report.bindings[0];
    assert.ok(checked && "current" in checked);
    assert.equal(checked.current.references.whole?.value, read.value);
    assert.deepEqual(checked.current.references.whole?.range, read.range);
  });
});

void test("markers support paragraphs, table cells, cross-block spans, and ordered narrowing", async () => {
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

void test("missing, duplicate, reversed, and out-of-scope markers fail explicitly", async () => {
  const cases: {
    readonly source: string;
    readonly id: string;
    readonly selection?: (
      builder: ReturnType<typeof markdown.from>,
    ) => ReturnType<ReturnType<typeof markdown.from>["section"]>;
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
      const builder = markdown.from("guide.md");
      const reference = (
        example.selection === undefined
          ? builder.marker(example.id)
          : example.selection(builder).marker(example.id)
      ).reference("value");
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
      const report = await check(
        defineConfig({
          root: _root,
          plugins: [markdown],
          bindings: [binding("invalid-selection", [reference])],
        }),
      );
      const checked = report.bindings[0];
      assert.ok(checked && "errors" in checked, example.source);
      assert.equal(checked.errors[0]?.code, example.code, example.source);
    });
  }
});

void test("batch collection isolates read errors and skips unselected references", async () => {
  const source = "# 概览\n\n当前内容。\n";
  const root = await mkdtemp(join(tmpdir(), "dock-markdown-batch-"));
  try {
    await writeFile(join(root, "guide.md"), source, "utf8");
    const readable = markdown
      .from("guide.md")
      .section("概览")
      .node({ type: "paragraph" })
      .reference("readable");
    const missingSelection = markdown
      .from("guide.md")
      .section("不存在的章节")
      .reference("missing-selection");
    const unselected = markdown.from("not-selected.md").reference("unselected");
    const config = defineConfig({
      root,
      plugins: [markdown],
      bindings: [
        binding("readable-policy", [readable]),
        binding("missing-policy", [missingSelection]),
        binding("unselected-policy", [unselected]),
      ],
    });

    const report = await check(config, {
      binding: ["readable-policy", "missing-policy"],
    });
    const readableResult = report.bindings.find(
      ({ bindingId }) => bindingId === "readable-policy",
    );
    const missingResult = report.bindings.find(
      ({ bindingId }) => bindingId === "missing-policy",
    );

    assert.ok(readableResult && "current" in readableResult);
    assert.equal(
      readableResult.current.references.readable?.value,
      "当前内容。",
    );
    assert.deepEqual(readableResult.current.references.readable?.range, {
      path: "guide.md",
      start: source.indexOf("当前内容。"),
      end: source.indexOf("当前内容。") + "当前内容。".length,
    });
    assert.ok(missingResult && "errors" in missingResult);
    assert.equal(missingResult.errors[0]?.code, "missing-selection");
    assert.deepEqual(report.scope, ["missing-policy", "readable-policy"]);
    assert.deepEqual(report.pluginErrors, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("markdown preflight rejects misspelled, missing, and mistyped text selector fields with reference ID", () => {
  const sharedMisspelledMatch = {
    kind: "match",
    pattern: "port=(\\d+)",
    gropu: 1,
  };
  const invalidSteps: readonly unknown[] = [
    sharedMisspelledMatch,
    { kind: "quote" },
    { kind: "quote", text: 42 },
    { kind: "quote", text: "ok", extra: true },
    { kind: "match" },
    { kind: "match", pattern: 42 },
    { kind: "match", pattern: "port=(\\d+)", group: -1 },
    { kind: "match", pattern: "port=(\\d+)", group: 1.5 },
    { kind: "match", pattern: "port=(\\d+)", group: "1" },
    { kind: "region" },
    { kind: "region", name: 42 },
    { kind: "region", name: "env", extra: true },
  ];

  for (const [index, step] of invalidSteps.entries()) {
    const referenceId = `invalid-markdown-step-${index}`;
    const reference = {
      id: referenceId,
      pluginId: markdownPluginId,
      target: "guide.md",
      selection: { kind: "markdown", steps: [step] },
    };
    assert.throws(
      () => Reflect.apply(markdown.validate, markdown, [reference]),
      (error: unknown) =>
        error instanceof Error && error.message.includes(referenceId),
      `markdown.validate should reject step ${JSON.stringify(step)} with referenceId`,
    );
    assert.throws(
      () =>
        Reflect.apply(defineConfig, undefined, [
          {
            plugins: [markdown],
            bindings: [{ id: "invalid-policy", references: [reference] }],
          },
        ]),
      (error: unknown) =>
        error instanceof Error && error.message.includes(referenceId),
      `defineConfig should reject step ${JSON.stringify(step)} with referenceId`,
    );
  }

  assert.throws(
    () => markdown.from("guide.md").match("port=(\\d+)", -1),
    TypeError,
  );
  assert.throws(
    () => markdown.from("guide.md").match("port=(\\d+)", 1.5),
    TypeError,
  );
  assert.throws(
    () => markdown.from("guide.md").quote(JSON.parse("42")),
    TypeError,
  );
  assert.throws(
    () => markdown.from("guide.md").region(JSON.parse("42")),
    TypeError,
  );
});

void test("markdown supports quote, match with capture group, and region both directly and scoped after Markdown steps", async () => {
  const source = [
    "😀说明",
    "",
    "# 开发",
    "",
    "只在开发出现。",
    "",
    "```env",
    "#region env",
    "port=4173",
    "#endregion env",
    "```",
    "",
    "# 生产",
    "",
    "| 键 | 值 |",
    "| --- | --- |",
    "| port | 生产端口：5173 |",
    "",
    "```env",
    "#region env",
    "port=5173",
    "#endregion env",
    "```",
    "",
  ].join("\n");

  await withDocument(source, async (root, config) => {
    const directQuote = markdown
      .from("guide.md")
      .quote("只在开发出现。")
      .reference("direct-quote");
    const directMatch = markdown
      .from("guide.md")
      .match("生产端口：(\\d+)", 1)
      .reference("direct-match");
    const scopedRegionMatch = markdown
      .from("guide.md")
      .section("生产")
      .region("env")
      .match("port=(\\d+)", 1)
      .reference("scoped-region-match");
    const tableCellMatch = markdown
      .from("guide.md")
      .section("生产")
      .tableCell({ column: "值", row: { column: "键", value: "port" } })
      .match("生产端口：(\\d+)", 1)
      .reference("table-cell-match");

    const quoteRead = await readReference(config, directQuote);
    assert.equal(quoteRead.value, "只在开发出现。");
    assert.deepEqual(quoteRead.range, {
      path: "guide.md",
      start: source.indexOf("只在开发出现。"),
      end: source.indexOf("只在开发出现。") + "只在开发出现。".length,
    });

    const matchRead = await readReference(config, directMatch);
    assert.equal(matchRead.value, "5173");
    assert.deepEqual(matchRead.range, {
      path: "guide.md",
      start: source.indexOf("5173"),
      end: source.indexOf("5173") + 4,
    });

    const prodSectionOffset = source.indexOf("# 生产");
    const scopedPortOffset = source.indexOf(
      "5173",
      source.indexOf("#region env", prodSectionOffset),
    );
    const scopedRead = await readReference(config, scopedRegionMatch);
    assert.equal(scopedRead.value, "5173");
    assert.deepEqual(scopedRead.range, {
      path: "guide.md",
      start: scopedPortOffset,
      end: scopedPortOffset + 4,
    });

    const cellRead = await readReference(config, tableCellMatch);
    assert.equal(cellRead.value, "5173");
    assert.deepEqual(cellRead.range, matchRead.range);

    const directRegion = markdown
      .from("guide.md")
      .section("开发")
      .region("env")
      .reference("dev-region");
    const report = await check(
      defineConfig({
        root,
        plugins: [markdown],
        bindings: [
          binding("markdown-text-steps", [
            directQuote,
            directMatch,
            scopedRegionMatch,
            directRegion,
          ]),
        ],
      }),
    );
    const checked = report.bindings[0];
    assert.ok(checked && "current" in checked);
    assert.equal(
      checked.current.references["dev-region"]?.value,
      "port=4173\n",
    );
    assert.equal(
      checked.current.references["scoped-region-match"]?.value,
      "5173",
    );

    await assert.rejects(
      readReference(
        config,
        markdown
          .from("guide.md")
          .section("生产")
          .quote("只在开发出现。")
          .reference("out-of-section"),
      ),
      { code: "missing-selection" },
    );

    await assert.rejects(
      readReference(
        config,
        markdown
          .from("guide.md")
          .section("不存在的章节")
          .quote("只在开发出现。")
          .reference("missing-section"),
      ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "missing-selection" &&
        error instanceof Error &&
        /No matching .*heading/u.test(error.message),
    );
  });
});

void test("batch collection reuses file reads, range parses, and marker scans while preserving nested markers, code examples, and refresh after edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-markdown-reuse-"));
  const unmarkedPath = join(root, "unmarked.md");
  const markedPath = join(root, "marked.md");
  const unmarkedSource = [
    "😀说明",
    "",
    "# Setup",
    "",
    "Install step 1.",
    "",
    "| Key | Value |",
    "| --- | --- |",
    "| port | 4173 |",
    "",
    "```ts",
    "const port = 4173;",
    "```",
    "",
  ].join("\n");
  const markedSourceV1 = [
    "😀前言",
    "",
    "# Config",
    "",
    "<!-- dock:start outer -->",
    "Header <!-- dock:start inner -->4173<!-- dock:end inner -->",
    "",
    "```md",
    "<!-- dock:start inner -->example<!-- dock:end inner -->",
    "```",
    "",
    "- item A",
    "<!-- dock:end outer -->",
    "",
  ].join("\n");
  const markedSourceV2 = [
    "😀更新前言",
    "",
    "# Config",
    "",
    "<!-- dock:start outer -->",
    "Header <!-- dock:start inner -->8080<!-- dock:end inner -->",
    "",
    "```md",
    "<!-- dock:start inner -->example<!-- dock:end inner -->",
    "```",
    "",
    "- item B",
    "<!-- dock:end outer -->",
    "",
  ].join("\n");

  try {
    await writeFile(unmarkedPath, unmarkedSource, "utf8");
    await writeFile(markedPath, markedSourceV1, "utf8");

    const unmarkedParagraph = markdown
      .from("unmarked.md")
      .section("Setup")
      .node({ type: "paragraph", contains: "Install" })
      .reference("unmarked-para");
    const unmarkedCell = markdown
      .from("./unmarked.md")
      .section("Setup")
      .tableCell({ column: "Value", row: { column: "Key", value: "port" } })
      .reference("unmarked-cell");
    const unmarkedWhole = markdown
      .from("unmarked.md")
      .reference("unmarked-whole");

    const nestedInner = markdown
      .from("marked.md")
      .section("Config")
      .marker("outer")
      .marker("inner")
      .reference("nested-inner");
    const outerExampleQuote = markdown
      .from("marked.md")
      .marker("outer")
      .quote("<!-- dock:start inner -->example<!-- dock:end inner -->")
      .reference("outer-example-quote");
    const outerListItem = markdown
      .from("marked.md")
      .marker("outer")
      .node({ type: "listItem", contains: "item" })
      .reference("outer-item");
    const markedWhole = markdown.from("marked.md").reference("marked-whole");

    const missingA = markdown
      .from("missing.md")
      .section("Any")
      .reference("missing-a");
    const missingB = markdown
      .from("missing.md")
      .marker("port")
      .reference("missing-b");

    const config = defineConfig({
      root,
      plugins: [markdown],
      bindings: [
        binding("unmarked-doc", [
          unmarkedParagraph,
          unmarkedCell,
          unmarkedWhole,
        ]),
        binding("marked-doc", [
          nestedInner,
          outerExampleQuote,
          outerListItem,
          markedWhole,
        ]),
        binding("missing-doc", [missingA, missingB]),
      ],
    });

    const firstReport = await check(config);

    const unmarkedResult = firstReport.bindings.find(
      (entry) => entry.bindingId === "unmarked-doc",
    );
    assert.ok(unmarkedResult && "current" in unmarkedResult);
    assert.equal(
      unmarkedResult.current.references["unmarked-para"]?.value,
      "Install step 1.",
    );
    assert.deepEqual(
      unmarkedResult.current.references["unmarked-para"]?.range,
      {
        path: "unmarked.md",
        start: unmarkedSource.indexOf("Install step 1."),
        end:
          unmarkedSource.indexOf("Install step 1.") + "Install step 1.".length,
      },
    );
    assert.equal(
      unmarkedResult.current.references["unmarked-cell"]?.value,
      "4173",
    );
    assert.deepEqual(
      unmarkedResult.current.references["unmarked-cell"]?.range,
      {
        path: "unmarked.md",
        start: unmarkedSource.indexOf("4173"),
        end: unmarkedSource.indexOf("4173") + 4,
      },
    );
    assert.equal(
      unmarkedResult.current.references["unmarked-whole"]?.value,
      unmarkedSource,
    );

    const markedResult = firstReport.bindings.find(
      (entry) => entry.bindingId === "marked-doc",
    );
    assert.ok(markedResult && "current" in markedResult);
    assert.equal(
      markedResult.current.references["nested-inner"]?.value,
      "4173",
    );
    assert.deepEqual(markedResult.current.references["nested-inner"]?.range, {
      path: "marked.md",
      start: markedSourceV1.indexOf("4173"),
      end: markedSourceV1.indexOf("4173") + 4,
    });
    assert.equal(
      markedResult.current.references["outer-example-quote"]?.value,
      "<!-- dock:start inner -->example<!-- dock:end inner -->",
    );
    assert.equal(
      markedResult.current.references["outer-item"]?.value,
      "- item A",
    );
    assert.equal(
      markedResult.current.references["marked-whole"]?.value,
      [
        "😀前言",
        "",
        "# Config",
        "",
        "",
        "Header 4173",
        "",
        "```md",
        "<!-- dock:start inner -->example<!-- dock:end inner -->",
        "```",
        "",
        "- item A",
        "",
        "",
      ].join("\n"),
    );

    const missingResult = firstReport.bindings.find(
      (entry) => entry.bindingId === "missing-doc",
    );
    assert.ok(missingResult && "errors" in missingResult);
    assert.deepEqual(
      missingResult.errors.map((error) => ({
        referenceId: error.referenceId,
        code: error.code,
      })),
      [
        { referenceId: "missing-a", code: "missing-file" },
        { referenceId: "missing-b", code: "missing-file" },
      ],
    );

    // Chained marker selection must fail when inner marker lies outside outer marker.
    await assert.rejects(
      readReference(
        config,
        markdown
          .from("marked.md")
          .section("Config")
          .quote("Header")
          .marker("inner")
          .reference("outside-quote"),
      ),
      { code: "missing-selection" },
    );

    // Modify files before the next independent check() call; latest text and positions must be observed.
    await writeFile(markedPath, markedSourceV2, "utf8");
    const refreshedConfig = defineConfig({
      root,
      plugins: [markdown],
      bindings: [
        binding("marked-doc", [nestedInner, outerListItem, markedWhole]),
      ],
    });
    const secondReport = await check(refreshedConfig);
    const refreshedMarked = secondReport.bindings[0];
    assert.ok(refreshedMarked && "current" in refreshedMarked);
    assert.equal(
      refreshedMarked.current.references["nested-inner"]?.value,
      "8080",
    );
    assert.deepEqual(
      refreshedMarked.current.references["nested-inner"]?.range,
      {
        path: "marked.md",
        start: markedSourceV2.indexOf("8080"),
        end: markedSourceV2.indexOf("8080") + 4,
      },
    );
    assert.equal(
      refreshedMarked.current.references["outer-item"]?.value,
      "- item B",
    );
    assert.deepEqual(refreshedMarked.current.references["outer-item"]?.range, {
      path: "marked.md",
      start: markedSourceV2.indexOf("- item B"),
      end: markedSourceV2.indexOf("- item B") + "- item B".length,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
