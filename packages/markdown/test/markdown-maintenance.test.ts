import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  binding,
  check,
  createReference,
  defineConfig,
  definePlugin,
  inspect,
  MaintenanceError,
  type PluginRequest,
  readReference,
  type Reference,
  updateBaseline,
} from "@dock/host";
import { markdown, markdownPluginId } from "@dock/markdown";

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

void test("markdown plugin uses dock:markdown plugin ID", () => {
  assert.equal(markdownPluginId, "dock:markdown");
  assert.equal(markdown.id, "dock:markdown");
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

void test("whole-document directive check reports multiple independent marker errors outside selected ranges", async () => {
  const source = [
    "# Usage",
    "",
    "Run dock check to verify documentation.",
    "",
    "<!-- dock:start orphan-unclosed -->",
    "Some unclosed content.",
    "",
    "<!-- dock:strat typo-directive -->",
    "",
    "<!-- dock:end orphan-end -->",
    "",
    "<!-- dock:start dup -->a<!-- dock:start dup -->b<!-- dock:end dup -->",
    "",
    "<!-- dock:end rev -->c<!-- dock:start rev -->",
    "",
    "<!-- dock:start -->",
    "",
  ].join("\n");

  await withDocument(source, async (root, config) => {
    const usage = markdown
      .from("guide.md")
      .section("Usage")
      .node({ type: "paragraph", contains: "Run dock check" })
      .reference("usage");

    await assert.rejects(
      readReference(config, usage),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "invalid-marker" &&
        error.message.includes("guide.md:5") &&
        error.message.includes("<!-- dock:start orphan-unclosed -->") &&
        error.message.includes("guide.md:8") &&
        error.message.includes("<!-- dock:strat typo-directive -->") &&
        error.message.includes("guide.md:10") &&
        error.message.includes("<!-- dock:end orphan-end -->") &&
        error.message.includes("guide.md:12") &&
        error.message.includes("guide.md:14") &&
        error.message.includes("guide.md:16") &&
        error.message.includes("<!-- dock:start -->"),
    );

    const report = await check(
      defineConfig({
        root,
        plugins: [markdown],
        bindings: [binding("usage-policy", [usage])],
      }),
    );
    const checked = report.bindings[0];
    assert.ok(checked && "errors" in checked);
    assert.equal(checked.errors.length, 1);
    assert.equal(checked.errors[0]?.code, "invalid-marker");
    const message = checked.errors[0]?.message ?? "";
    assert.match(message, /guide\.md:5.*dock:start orphan-unclosed/u);
    assert.match(message, /guide\.md:8.*dock:strat typo-directive/u);
    assert.match(message, /guide\.md:10.*dock:end orphan-end/u);
    assert.match(message, /guide\.md:12.*lines 12, 12/u);
    assert.match(message, /guide\.md:14.*precedes/u);
    assert.match(message, /guide\.md:16.*dock:start/u);
  });
});

void test("code examples, unused valid markers, and unreferenced files do not trigger directive errors", async () => {
  const source = [
    "# Documentation",
    "",
    "Primary statement.",
    "",
    "```md",
    "<!-- dock:start broken-in-fence -->",
    "<!-- dock:strat typo-in-fence -->",
    "```",
    "",
    "    <!-- dock:start broken-in-indented-code -->",
    "    <!-- dock:end orphan-in-indented-code -->",
    "",
    "Inline `<!-- dock:start broken-in-inline -->` example.",
    '<div data-example="<!-- dock:start broken-in-attr -->"></div>',
    '<script>const example = "<!-- dock:start broken-in-script -->";</script>',
    "",
    "<!-- dock:start standalone-test-only -->4173<!-- dock:end standalone-test-only -->",
    "",
  ].join("\n");

  const root = await mkdtemp(join(tmpdir(), "dock-markdown-scope-ignore-"));
  try {
    await writeFile(join(root, "guide.md"), source, "utf8");
    await writeFile(
      join(root, "unrelated.md"),
      "<!-- dock:start unclosed-elsewhere -->\n<!-- dock:strat bad -->\n",
      "utf8",
    );

    const primary = markdown
      .from("guide.md")
      .section("Documentation")
      .node({ type: "paragraph", contains: "Primary statement" })
      .reference("primary");
    const standalone = markdown
      .from("guide.md")
      .marker("standalone-test-only")
      .reference("standalone");

    const config = defineConfig({
      root,
      plugins: [markdown],
      bindings: [binding("doc-policy", [primary])],
    });

    const report = await check(config);
    const checked = report.bindings[0];
    assert.ok(checked && "current" in checked);
    assert.equal(checked.errors, undefined);
    assert.equal(
      checked.current.references.primary?.value,
      "Primary statement.",
    );

    const standaloneRead = await readReference(config, standalone);
    assert.equal(standaloneRead.value, "4173");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("explicit markdown.source fails with declaration-source-read-failed when unreadable and preserves baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-markdown-source-"));
  const baselinePath = join(root, "dock.baseline.json");
  try {
    const baselineRaw = `${JSON.stringify(
      {
        version: 3,
        bindings: {
          "existing-policy": {
            definition: { id: "existing-policy", references: ["body"] },
            references: {
              body: {
                definition: {
                  id: "body",
                  target: {
                    pluginId: markdownPluginId,
                    target: "missing-guide.md",
                    fileInfo: "missing-guide.md",
                  },
                },
                value: "Original",
              },
            },
          },
        },
      },
      null,
      2,
    )}\n`;
    await writeFile(baselinePath, baselineRaw, "utf8");

    assert.throws(() => markdown.source(""), TypeError);
    assert.throws(
      () => markdown.source(new URL("https://example.test/a.md")),
      TypeError,
    );

    const config = defineConfig({
      root,
      baseline: baselinePath,
      plugins: [markdown],
      sources: [markdown.source("missing-guide.md")],
    });

    for (const op of [
      () => inspect(config),
      () => check(config),
      () => updateBaseline(config),
    ]) {
      await assert.rejects(op, (error: unknown) => {
        assert.ok(error instanceof MaintenanceError);
        assert.equal(error.code, "declaration-source-read-failed");
        assert.match(error.message, /missing-guide\.md/);
        return true;
      });
      assert.equal(await readFile(baselinePath, "utf8"), baselineRaw);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("dock:bind selects following Markdown blocks, preserves spaces in with IDs, strips directives in markdownFact, and ignores code examples", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-markdown-bind-valid-"));
  try {
    const readmeSource = [
      "# Guide",
      "",
      "## Overview",
      "",
      "Intro paragraph.",
      "",
      '<!-- dock:bind {"id":"cli-failure","with":["cli exit code","cli.output"]} -->',
      "",
      "When a check fails, Dock exits with code 1.",
      "",
      '<!-- dock:bind {"id":"cli-code-block","with":["cli exit code"]} -->',
      "```sh",
      "dock check --config dock.config.ts",
      "```",
      "",
      '<!-- dock:bind {"id":"cli-list-block","with":["cli.output"]} -->',
      "",
      "- Step one",
      "- Step two",
      "",
      '<!-- dock:bind {"id":"cli-table-block","with":["cli.output"]} -->',
      "| Key | Value |",
      "| --- | --- |",
      "| mode | strict |",
      "",
      '<!-- dock:bind {"id":"cli-quote-block","with":["cli exit code"]} -->',
      "> Quoted rule.",
      "",
      "```md",
      '<!-- dock:bind {"id":"ignored-in-fence","with":["missing-ref"]} -->',
      "<!-- dock:bind {bad-json-in-fence -->",
      "```",
      "",
      'Inline `<!-- dock:bind {"id":"ignored-inline","with":["missing-ref"]} -->` example.',
      '<div data-example=\'<!-- dock:bind {"id":"ignored-attr"} -->\'></div>',
      '<script>const x = "<!-- dock:bind {broken} -->";</script>',
      "",
    ].join("\n");
    await writeFile(join(root, "README.md"), readmeSource, "utf8");
    await writeFile(join(root, "exit-code.txt"), "1\n", "utf8");
    await writeFile(join(root, "output.txt"), "Binding failed\n", "utf8");

    const overviewRef = markdown
      .from("README.md")
      .section("Overview")
      .reference("overview");
    const exitCodeRef = markdown
      .from("exit-code.txt")
      .reference("cli exit code");
    const outputRef = markdown.from("output.txt").reference("cli.output");

    const config = defineConfig({
      root,
      plugins: [markdown],
      bindings: [binding("overview-policy", [overviewRef])],
      references: [exitCodeRef, outputRef],
    });

    const inspected = await inspect(config);
    assert.deepEqual(
      inspected.context.bindings.map((entry) => entry.id),
      [
        "overview-policy",
        "cli-failure",
        "cli-code-block",
        "cli-list-block",
        "cli-table-block",
        "cli-quote-block",
      ],
    );
    const failureBinding = inspected.context.bindings.find(
      (entry) => entry.id === "cli-failure",
    );
    assert.deepEqual(failureBinding, {
      id: "cli-failure",
      references: ["dock:bind:cli-failure", "cli exit code", "cli.output"],
    });
    assert.deepEqual(inspected.declarationSources.bindings["cli-failure"], [
      "README.md:7",
    ]);

    const bodyDef = inspected.context.references.find(
      (ref) => ref.id === "dock:bind:cli-failure",
    );
    assert.deepEqual(bodyDef, {
      id: "dock:bind:cli-failure",
      target: {
        pluginId: markdownPluginId,
        target: "README.md",
        fileInfo: "README.md",
      },
      selection: {
        kind: "markdown",
        steps: [{ kind: "bind", id: "cli-failure" }],
      },
    });

    const report = await check(config);
    const failureResult = report.bindings.find(
      (entry) => entry.bindingId === "cli-failure",
    );
    assert.ok(failureResult && "current" in failureResult);
    assert.equal(
      failureResult.current.references["dock:bind:cli-failure"]?.value,
      "When a check fails, Dock exits with code 1.",
    );
    assert.equal(
      failureResult.current.references["cli exit code"]?.value,
      "1\n",
    );
    assert.equal(
      failureResult.current.references["cli.output"]?.value,
      "Binding failed\n",
    );

    const codeResult = report.bindings.find(
      (entry) => entry.bindingId === "cli-code-block",
    );
    assert.ok(codeResult && "current" in codeResult);
    assert.equal(
      codeResult.current.references["dock:bind:cli-code-block"]?.value,
      "```sh\ndock check --config dock.config.ts\n```",
    );

    const listResult = report.bindings.find(
      (entry) => entry.bindingId === "cli-list-block",
    );
    assert.ok(listResult && "current" in listResult);
    assert.equal(
      listResult.current.references["dock:bind:cli-list-block"]?.value,
      "- Step one\n- Step two",
    );

    const tableResult = report.bindings.find(
      (entry) => entry.bindingId === "cli-table-block",
    );
    assert.ok(tableResult && "current" in tableResult);
    assert.equal(
      tableResult.current.references["dock:bind:cli-table-block"]?.value,
      "| Key | Value |\n| --- | --- |\n| mode | strict |",
    );

    const quoteResult = report.bindings.find(
      (entry) => entry.bindingId === "cli-quote-block",
    );
    assert.ok(quoteResult && "current" in quoteResult);
    assert.equal(
      quoteResult.current.references["dock:bind:cli-quote-block"]?.value,
      "> Quoted rule.",
    );

    const overviewResult = report.bindings.find(
      (entry) => entry.bindingId === "overview-policy",
    );
    assert.ok(overviewResult && "current" in overviewResult);
    const overviewValue = overviewResult.current.references.overview?.value;
    assert.equal(typeof overviewValue, "string");
    if (typeof overviewValue !== "string") return;
    assert.ok(!overviewValue.includes('dock:bind {"id":"cli-failure"'));
    assert.ok(overviewValue.includes('dock:bind {"id":"ignored-in-fence"'));
    assert.ok(overviewValue.includes('dock:bind {"id":"ignored-inline"'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("dock:bind lossless JSON and placement validation reports file, line, and offending field across multiple independent errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-markdown-bind-invalid-"));
  try {
    await writeFile(join(root, "ref.txt"), "ok\n", "utf8");
    const ref = markdown.from("ref.txt").reference("r1");

    const cases: readonly {
      readonly name: string;
      readonly content: string;
      readonly patterns: readonly RegExp[];
    }[] = [
      {
        name: "missing payload",
        content: "# Guide\n\n<!-- dock:bind -->\n\nBody.\n",
        patterns: [/guide\.md:3/, /missing JSON object parameter/],
      },
      {
        name: "invalid JSON syntax",
        content: '# Guide\n\n<!-- dock:bind {"id":"a", -->\n\nBody.\n',
        patterns: [/guide\.md:3/, /Invalid JSON in "dock:bind"/],
      },
      {
        name: "non-object JSON",
        content: '# Guide\n\n<!-- dock:bind ["a"] -->\n\nBody.\n',
        patterns: [/guide\.md:3/, /expected a JSON object/],
      },
      {
        name: "missing id and with",
        content: "# Guide\n\n<!-- dock:bind {} -->\n\nBody.\n",
        patterns: [
          /guide\.md:3.*Missing required field "id"/,
          /guide\.md:3.*Missing required field "with"/,
        ],
      },
      {
        name: "unknown extra field",
        content:
          '# Guide\n\n<!-- dock:bind {"id":"a","with":["r1"],"extra":true} -->\n\nBody.\n',
        patterns: [/guide\.md:3/, /Unknown field "extra"/],
      },
      {
        name: "raw duplicate id and duplicate with keys",
        content: [
          "# Guide",
          "",
          '<!-- dock:bind {"id":"a","id":"b","with":["r1"]} -->',
          "",
          "Body 1.",
          "",
          '<!-- dock:bind {"id":"c","with":["r1"],"with":["r2"]} -->',
          "",
          "Body 2.",
          "",
        ].join("\n"),
        patterns: [
          /guide\.md:3.*Duplicate field "id"/,
          /guide\.md:7.*Duplicate field "with"/,
        ],
      },
      {
        name: "wrong types and empty values",
        content: [
          "# Guide",
          "",
          '<!-- dock:bind {"id":123,"with":"r1"} -->',
          "",
          "Body 1.",
          "",
          '<!-- dock:bind {"id":"","with":[]} -->',
          "",
          "Body 2.",
          "",
          '<!-- dock:bind {"id":"b","with":["r1",""]} -->',
          "",
          "Body 3.",
          "",
        ].join("\n"),
        patterns: [
          /guide\.md:3.*Invalid field "id"/,
          /guide\.md:3.*Invalid field "with"/,
          /guide\.md:7.*Invalid field "id"/,
          /guide\.md:7.*Invalid field "with".*empty/,
          /guide\.md:11.*Invalid field "with\[1\]"/,
        ],
      },
      {
        name: "inline phrasing comment",
        content:
          '# Guide\n\nInline text <!-- dock:bind {"id":"a","with":["r1"]} -->\n',
        patterns: [/guide\.md:3/, /standalone block-level HTML comment/],
      },
      {
        name: "followed by heading, thematicBreak, dock:bind, dock:end, and EOF",
        content: [
          "# Guide",
          "",
          '<!-- dock:bind {"id":"before-heading","with":["r1"]} -->',
          "## Next",
          "",
          '<!-- dock:bind {"id":"before-hr","with":["r1"]} -->',
          "---",
          "",
          '<!-- dock:bind {"id":"before-bind","with":["r1"]} -->',
          '<!-- dock:bind {"id":"valid-bind","with":["r1"]} -->',
          "Body.",
          "",
          "<!-- dock:start sec -->",
          '<!-- dock:bind {"id":"before-end","with":["r1"]} -->',
          "<!-- dock:end sec -->",
          "",
          '<!-- dock:bind {"id":"at-eof","with":["r1"]} -->',
        ].join("\n"),
        patterns: [
          /guide\.md:3.*before-heading.*heading/,
          /guide\.md:6.*before-hr.*thematicBreak/,
          /guide\.md:9.*before-bind.*dock:bind/,
          /guide\.md:14.*before-end.*dock:end/,
          /guide\.md:17.*at-eof.*end of document/,
        ],
      },
    ];

    for (const testCase of cases) {
      await writeFile(join(root, "guide.md"), testCase.content, "utf8");
      const config = defineConfig({
        root,
        plugins: [markdown],
        sources: [markdown.source("guide.md")],
        references: [ref],
      });
      for (const op of [() => inspect(config), () => check(config)]) {
        await assert.rejects(op, (error: unknown) => {
          assert.ok(error instanceof MaintenanceError, testCase.name);
          assert.equal(error.code, "declaration-invalid", testCase.name);
          for (const pattern of testCase.patterns) {
            assert.match(error.message, pattern, testCase.name);
          }
          return true;
        });
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("inline dock:bind keeps stable identity across paragraph reordering and preserves baseline when corrupted", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-markdown-bind-history-"));
  const baselinePath = join(root, "dock.baseline.json");
  try {
    await writeFile(join(root, "facts.txt"), "exit=1\n", "utf8");
    const readmeV1 = [
      "# Guide",
      "",
      "## Usage",
      "",
      "Run dock check regularly.",
      "",
      '<!-- dock:bind {"id":"cli-failure","with":["cli exit code"]} -->',
      "Dock exits with 1 on error.",
      "",
      "## Notes",
      "",
      "Extra context.",
      "",
    ].join("\n");
    await writeFile(join(root, "README.md"), readmeV1, "utf8");

    const config = defineConfig({
      root,
      baseline: baselinePath,
      plugins: [markdown],
      bindings: [
        binding("notes-policy", [
          markdown.from("README.md").section("Notes").reference("notes"),
        ]),
      ],
      references: [markdown.from("facts.txt").reference("cli exit code")],
    });

    const created = await updateBaseline(config);
    assert.equal(created.status, "updated");
    const savedBytes = await readFile(baselinePath, "utf8");

    // Reorder paragraphs/sections and insert blank lines between dock:bind and its body block.
    const readmeReordered = [
      "# Guide",
      "",
      "## Notes",
      "",
      "Extra context.",
      "",
      "## Usage",
      "",
      "Lead paragraph.",
      "",
      "Second paragraph.",
      "",
      '<!-- dock:bind {"id":"cli-failure","with":["cli exit code"]} -->',
      "",
      "",
      "Dock exits with 1 on error.",
      "",
      "Run dock check regularly.",
      "",
    ].join("\n");
    await writeFile(join(root, "README.md"), readmeReordered, "utf8");

    const reorderedInspect = await inspect(config);
    assert.deepEqual(
      reorderedInspect.declarationSources.bindings["cli-failure"],
      ["README.md:13"],
    );
    const reorderedCheck = await check(config);
    const failureCheck = reorderedCheck.bindings.find(
      (entry) => entry.bindingId === "cli-failure",
    );
    assert.ok(failureCheck && "current" in failureCheck);
    assert.equal(failureCheck.consistency, "consistent");
    assert.deepEqual(failureCheck.changes, []);
    assert.deepEqual(
      failureCheck.current.references["dock:bind:cli-failure"]?.range,
      {
        path: "README.md",
        start: readmeReordered.indexOf("Dock exits with 1 on error."),
        end:
          readmeReordered.indexOf("Dock exits with 1 on error.") +
          "Dock exits with 1 on error.".length,
      },
    );

    // Corrupting the baselined dock:bind must fail inspect, check, and updateBaseline without altering baseline bytes or inferring untracked.
    const readmeCorrupted = readmeReordered.replace(
      '<!-- dock:bind {"id":"cli-failure","with":["cli exit code"]} -->',
      '<!-- dock:bind {"id":"cli-failure","with":[]} -->',
    );
    await writeFile(join(root, "README.md"), readmeCorrupted, "utf8");

    for (const op of [
      () => inspect(config),
      () => check(config),
      () => updateBaseline(config),
    ]) {
      await assert.rejects(op, (error: unknown) => {
        assert.ok(error instanceof MaintenanceError);
        assert.equal(error.code, "declaration-invalid");
        assert.match(error.message, /README\.md:13/);
        assert.match(error.message, /"with"/);
        return true;
      });
      assert.equal(await readFile(baselinePath, "utf8"), savedBytes);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("broken external markdown reference target on baselined inline binding reports missing-file on affected binding without failing discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-markdown-broken-ext-"));
  const baselinePath = join(root, "dock.baseline.json");
  try {
    await writeFile(
      join(root, "guide.md"),
      [
        "# Guide",
        "",
        '<!-- dock:bind {"id":"inline-ext","with":["other-doc"]} -->',
        "See external doc.",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(root, "other.md"),
      "# Spec\n\nExternal body.\n",
      "utf8",
    );
    await writeFile(join(root, "keep.md"), "# Keep\n\nStill valid.\n", "utf8");

    const config = defineConfig({
      root,
      baseline: baselinePath,
      plugins: [markdown],
      sources: [markdown.source("guide.md")],
      references: [
        markdown.from("other.md").section("Spec").reference("other-doc"),
      ],
      bindings: [
        binding("keep-binding", [
          markdown.from("keep.md").section("Keep").reference("keep-ref"),
        ]),
      ],
    });

    const initial = await updateBaseline(config);
    assert.equal(initial.status, "updated");
    const savedBytes = await readFile(baselinePath);

    await rm(join(root, "other.md"));

    const checked = await check(config);
    const affected = checked.bindings.find(
      (entry) => entry.bindingId === "inline-ext",
    );
    const unaffected = checked.bindings.find(
      (entry) => entry.bindingId === "keep-binding",
    );
    assert.ok(affected && "errors" in affected);
    assert.equal(affected.errors[0]?.referenceId, "other-doc");
    assert.equal(affected.errors[0]?.code, "missing-file");
    assert.ok(unaffected && "consistency" in unaffected);
    assert.equal(unaffected.consistency, "consistent");

    const rejected = await updateBaseline(config);
    assert.equal(rejected.status, "rejected");
    assert.deepEqual(await readFile(baselinePath), savedBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("explicit markdown.source onboards a new guide with zero TypeScript bindings, shared declarations, and accurate scope filtering", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-markdown-new-guide-"));
  const baselinePath = join(root, "dock.baseline.json");
  try {
    await writeFile(
      join(root, "guide.md"),
      "# Empty Guide\n\nNo bindings yet.\n",
      "utf8",
    );
    await writeFile(join(root, "facts-a.txt"), "fact-a\n", "utf8");
    await writeFile(join(root, "facts-b.txt"), "fact-b\n", "utf8");
    await writeFile(join(root, "unused.txt"), "unused\n", "utf8");

    const refA = markdown.from("facts-a.txt").reference("ref a");
    const refB = markdown.from("facts-b.txt").reference("ref-b");
    const unusedRef = markdown.from("unused.txt").reference("unused-ref");

    // 0 inline bindings: inspect lists standalone references without guide.md in files; updateBaseline rejects empty-selection.
    const emptyGuideConfig = defineConfig({
      root,
      baseline: baselinePath,
      plugins: [markdown],
      sources: [markdown.source("guide.md")],
      references: [refA, refB, unusedRef],
    });
    const emptyInspected = await inspect(emptyGuideConfig);
    assert.deepEqual(emptyInspected.context.bindings, []);
    assert.deepEqual(emptyInspected.context.scope, []);
    assert.deepEqual(
      emptyInspected.context.references.map((ref) => ref.id),
      ["ref a", "ref-b", "unused-ref"],
    );
    assert.equal(
      emptyInspected.files.some((file) => file.path === join(root, "guide.md")),
      false,
    );
    const emptyChecked = await check(emptyGuideConfig);
    assert.deepEqual(emptyChecked.scope, []);
    assert.deepEqual(emptyChecked.bindings, []);
    const emptyUpdated = await updateBaseline(emptyGuideConfig);
    assert.equal(emptyUpdated.status, "rejected");
    if (emptyUpdated.status === "rejected") {
      assert.equal(emptyUpdated.errors[0]?.code, "empty-selection");
    }

    // Add inline dock:bind to guide.md while unused-ref remains standalone.
    await writeFile(
      join(root, "guide.md"),
      [
        "# New Guide",
        "",
        '<!-- dock:bind {"id":"guide-intro","with":["ref a","ref-b"]} -->',
        "",
        "Guide statement linked to ref a and ref-b.",
        "",
      ].join("\n"),
      "utf8",
    );

    const inspected = await inspect(emptyGuideConfig);
    assert.deepEqual(inspected.context.bindings, [
      {
        id: "guide-intro",
        references: ["dock:bind:guide-intro", "ref a", "ref-b"],
      },
    ]);
    assert.deepEqual(
      inspected.context.references.map((ref) => ref.id),
      ["ref a", "ref-b", "unused-ref", "dock:bind:guide-intro"],
    );
    assert.deepEqual(inspected.declarationSources.bindings["guide-intro"], [
      "guide.md:3",
    ]);
    assert.ok(
      inspected.files.some(
        (file) =>
          file.path === join(root, "guide.md") &&
          file.references.includes("dock:bind:guide-intro"),
      ),
    );

    for (const scope of [
      { binding: ["guide-intro"] },
      { reference: ["ref a"] },
      { reference: ["dock:bind:guide-intro"] },
      { file: ["guide.md"] },
    ]) {
      const scopedInspected = await inspect(emptyGuideConfig, scope);
      assert.deepEqual(scopedInspected.context.scope, ["guide-intro"]);
      assert.deepEqual(scopedInspected.plugins[0]?.selectedReferences, [
        "ref a",
        "ref-b",
        "dock:bind:guide-intro",
      ]);
      const scopedChecked = await check(emptyGuideConfig, scope);
      assert.deepEqual(scopedChecked.scope, ["guide-intro"]);
      const scopedBinding = scopedChecked.bindings[0];
      assert.ok(scopedBinding && "current" in scopedBinding);
      assert.equal(
        scopedBinding.current.references["dock:bind:guide-intro"]?.value,
        "Guide statement linked to ref a and ref-b.",
      );
    }

    const updated = await updateBaseline(emptyGuideConfig, {
      file: ["guide.md"],
    });
    assert.equal(updated.status, "updated");
    const verified = await check(emptyGuideConfig);
    assert.equal(verified.bindings[0]?.consistency, "consistent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("multi-path inclusion deduplicates inline bindings and ignores unconfigured markdown files", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-markdown-dedup-"));
  try {
    const guidePath = join(root, "guide.md");
    await writeFile(
      guidePath,
      [
        "# Guide",
        "",
        "## Intro",
        "",
        "Intro text.",
        "",
        "## Rules",
        "",
        '<!-- dock:bind {"id":"rule-inline","with":["intro-ref","standalone-ref"]} -->',
        "Rules must match standalone-ref.",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(root, "facts.txt"), "fact=ok\n", "utf8");
    await writeFile(
      join(root, "random.md"),
      [
        "<!-- dock:start unclosed-random -->",
        '<!-- dock:bind {"id":"rule-inline","with":[]} -->',
        "<!-- dock:bind {broken json -->",
      ].join("\n"),
      "utf8",
    );

    const introRef = markdown
      .from("guide.md")
      .section("Intro")
      .reference("intro-ref");
    const rulesHeadingRef = markdown
      .from(pathToFileURL(guidePath))
      .section("Rules")
      .reference("rules-ref");
    const standaloneRef = markdown
      .from("facts.txt")
      .reference("standalone-ref");

    const config = defineConfig({
      root,
      plugins: [markdown],
      sources: [
        markdown.source("guide.md"),
        markdown.source(pathToFileURL(guidePath)),
      ],
      references: [rulesHeadingRef, standaloneRef],
      bindings: [binding("intro-policy", [introRef])],
    });

    const inspected = await inspect(config);
    assert.deepEqual(
      inspected.context.bindings.map((entry) => entry.id),
      ["intro-policy", "rule-inline"],
    );
    const report = await check(config);
    assert.equal(report.bindings.length, 2);
    assert.deepEqual(report.scope, ["intro-policy", "rule-inline"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("unreadable source, corrupted inline declaration, untracking, partial check safety, and scoped cleanup preserve history correctly", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-markdown-untrack-"));
  const baselinePath = join(root, "dock.baseline.json");
  const guidePath = join(root, "guide.md");
  try {
    await writeFile(join(root, "fact-1.txt"), "one\n", "utf8");
    await writeFile(join(root, "fact-2.txt"), "two\n", "utf8");
    await writeFile(join(root, "keep.txt"), "keep\n", "utf8");
    await writeFile(
      guidePath,
      [
        "# Guide",
        "",
        '<!-- dock:bind {"id":"inline-one","with":["ref-1"]} -->',
        "Statement one.",
        "",
        '<!-- dock:bind {"id":"inline-two","with":["ref-2"]} -->',
        "Statement two.",
        "",
      ].join("\n"),
      "utf8",
    );

    const ref1 = markdown.from("fact-1.txt").reference("ref-1");
    const ref2 = markdown.from("fact-2.txt").reference("ref-2");
    const keepRef = markdown.from("keep.txt").reference("keep-ref");
    const fullConfig = defineConfig({
      root,
      baseline: baselinePath,
      plugins: [markdown],
      sources: [markdown.source("guide.md")],
      references: [ref1, ref2],
      bindings: [binding("keep-binding", [keepRef])],
    });

    const initial = await updateBaseline(fullConfig);
    assert.equal(initial.status, "updated");
    const v3Bytes = await readFile(baselinePath, "utf8");

    // 1) Unreadable declaration source (deleted and directory conflict): rejects and preserves baseline without untracking.
    await rm(guidePath);
    for (const setupUnreadable of [
      async () => {},
      async () => {
        await mkdir(guidePath);
      },
    ]) {
      await setupUnreadable();
      for (const op of [
        () => check(fullConfig),
        () => updateBaseline(fullConfig),
      ]) {
        await assert.rejects(op, (error: unknown) => {
          assert.ok(error instanceof MaintenanceError);
          assert.equal(error.code, "declaration-source-read-failed");
          assert.match(error.message, /guide\.md/);
          return true;
        });
        assert.equal(await readFile(baselinePath, "utf8"), v3Bytes);
      }
      await rm(guidePath, { recursive: true, force: true });
    }

    // 2) Intentional untracking by removing both inline-one and inline-two from guide.md.
    await writeFile(
      guidePath,
      "# Guide\n\nAll inline bindings removed.\n",
      "utf8",
    );

    // Partial check on keep-binding does NOT infer or delete inline-one / inline-two.
    const partialCheck = await check(fullConfig, { binding: ["keep-binding"] });
    assert.deepEqual(partialCheck.scope, ["keep-binding"]);
    assert.equal(partialCheck.bindings.length, 1);
    assert.equal(partialCheck.bindings[0]?.consistency, "consistent");

    // Full check marks both removed bindings as untracked.
    const fullCheck = await check(fullConfig);
    for (const id of ["inline-one", "inline-two"]) {
      const entry = fullCheck.bindings.find((item) => item.bindingId === id);
      assert.ok(entry && "untracked" in entry && entry.untracked);
    }

    // Scoped update removes ONLY inline-one, leaving inline-two and keep-binding in baseline.
    const scopedUpdate = await updateBaseline(fullConfig, {
      binding: ["inline-one"],
    });
    assert.equal(scopedUpdate.status, "updated");
    const afterScopedBaseline = JSON.parse(
      await readFile(baselinePath, "utf8"),
    ) as { bindings: Record<string, unknown> };
    assert.deepEqual(Object.keys(afterScopedBaseline.bindings).sort(), [
      "inline-two",
      "keep-binding",
    ]);

    // Removing source from config AND deleting guide.md still untracks inline-two cleanly.
    await rm(guidePath);
    const sourceRemovedConfig = defineConfig({
      root,
      baseline: baselinePath,
      plugins: [markdown],
      bindings: [binding("keep-binding", [keepRef])],
    });
    const untrackedViaConfig = await check(sourceRemovedConfig);
    const twoEntry = untrackedViaConfig.bindings.find(
      (item) => item.bindingId === "inline-two",
    );
    assert.ok(twoEntry && "untracked" in twoEntry && twoEntry.untracked);

    const finalUpdate = await updateBaseline(sourceRemovedConfig);
    assert.equal(finalUpdate.status, "updated");
    const finalBaseline = JSON.parse(await readFile(baselinePath, "utf8")) as {
      bindings: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(finalBaseline.bindings), ["keep-binding"]);
    const finalCheck = await check(sourceRemovedConfig);
    assert.equal(finalCheck.bindings[0]?.consistency, "consistent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("mixed broken dock:bind and broken markers in the same document are all reported in source-line order", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-markdown-mixed-directives-"));
  try {
    await writeFile(
      join(root, "guide.md"),
      [
        "# Guide",
        "",
        "<!-- dock:start unclosed -->",
        "Some content.",
        "",
        '<!-- dock:bind {"id":"bad","with":[]} -->',
        "Body.",
        "",
        "<!-- dock:strat typo -->",
        "",
      ].join("\n"),
      "utf8",
    );
    const config = defineConfig({
      root,
      plugins: [markdown],
      sources: [markdown.source("guide.md")],
    });
    const boundConfig = defineConfig({
      root,
      plugins: [markdown],
      sources: [markdown.source("guide.md")],
      bindings: [
        binding("guide-section", [
          markdown.from("guide.md").section("Guide").reference("guide-sec"),
        ]),
      ],
    });
    for (const activeConfig of [config, boundConfig]) {
      for (const op of [
        () => inspect(activeConfig),
        () => check(activeConfig),
      ]) {
        await assert.rejects(op, (error: unknown) => {
          assert.ok(error instanceof MaintenanceError);
          assert.equal(error.code, "declaration-invalid");
          const idxUnclosed = error.message.indexOf("guide.md:3");
          const idxBind = error.message.indexOf("guide.md:6");
          const idxTypo = error.message.indexOf("guide.md:9");
          assert.ok(idxUnclosed >= 0, error.message);
          assert.ok(idxBind > idxUnclosed, error.message);
          assert.ok(idxTypo > idxBind, error.message);
          assert.match(error.message, /unclosed/);
          assert.match(error.message, /dock:strat/);
          return true;
        });
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("unbound config.references targeting a markdown file still validates markers when no binding reads the file", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "dock-markdown-unbound-ref-markers-"),
  );
  try {
    await writeFile(join(root, "a.txt"), "ok\n", "utf8");
    await writeFile(
      join(root, "guide.md"),
      [
        "<!-- dock:start m -->ok<!-- dock:end m -->",
        "",
        "<!-- dock:start unclosed -->",
        "",
        "<!-- dock:strat typo -->",
        "",
      ].join("\n"),
      "utf8",
    );

    type OtherReference = Reference<"fixture:other", string, string, string>;
    const otherPlugin = definePlugin({
      id: "fixture:other",
      validate(_ref: OtherReference) {},
      fileInfo(ref: OtherReference) {
        return ref.target;
      },
      collect(req: PluginRequest<OtherReference>) {
        return {
          results: req.selectedReferences.map((ref) => ({
            referenceId: ref.id,
            kind: "value" as const,
            value: "ok",
          })),
        };
      },
    });
    const otherRef = createReference<"fixture:other", string, string, string>(
      "fixture:other",
      "a",
      "a.txt",
    );

    for (const withSource of [true, false]) {
      const config = defineConfig({
        root,
        plugins: [markdown, otherPlugin],
        ...(withSource ? { sources: [markdown.source("guide.md")] } : {}),
        references: [markdown.from("guide.md").marker("m").reference("m")],
        bindings: [binding("b", [otherRef])],
      });

      for (const op of [() => inspect(config), () => check(config)]) {
        await assert.rejects(
          op,
          (error: unknown) => {
            assert.ok(error instanceof MaintenanceError);
            assert.equal(error.code, "invalid-marker");
            assert.match(error.message, /guide\.md:3.*unclosed/);
            assert.match(error.message, /guide\.md:5.*dock:strat/);
            return true;
          },
          `withSource=${String(withSource)}`,
        );
      }
    }

    // When m IS bound, collect handles marker validation on report.bindings instead of discover throwing.
    const boundConfig = defineConfig({
      root,
      plugins: [markdown],
      sources: [markdown.source("guide.md")],
      bindings: [
        binding("m-binding", [
          markdown.from("guide.md").marker("m").reference("m"),
        ]),
      ],
    });
    const report = await check(boundConfig);
    const checked = report.bindings[0];
    assert.ok(checked && "errors" in checked);
    assert.equal(checked.errors[0]?.code, "invalid-marker");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("dock:bind with cannot reference another inline binding's auto-generated dock:bind:<id> in any order", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "dock-markdown-bind-internal-ref-"),
  );
  try {
    await writeFile(join(root, "r1.txt"), "one\n", "utf8");
    const r1 = markdown.from("r1.txt").reference("r1");

    const b1 = '<!-- dock:bind {"id":"b1","with":["r1"]} -->\nBody 1.';
    const b2 =
      '<!-- dock:bind {"id":"b2","with":["dock:bind:b1"]} -->\nBody 2.';

    for (const content of [`${b1}\n\n${b2}\n`, `${b2}\n\n${b1}\n`]) {
      await writeFile(join(root, "guide.md"), content, "utf8");
      const config = defineConfig({
        root,
        plugins: [markdown],
        sources: [markdown.source("guide.md")],
        references: [r1],
      });
      await assert.rejects(
        () => check(config),
        (error: unknown) =>
          error instanceof MaintenanceError &&
          error.code === "declaration-invalid" &&
          /Unknown reference ID "dock:bind:b1"/.test(error.message),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
