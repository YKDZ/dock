import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  binding,
  check,
  defineConfig,
  file,
  filePluginId,
  MaintenanceError,
  readReference,
  selectTextRange,
  TextSelectionError,
  updateBaseline,
} from "@ykdz/dock";

void test("full plain file text can establish, check, and update a baseline via public maintenance APIs", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-file-maintenance-"));
  const target = join(root, "guide.md");
  const firstVersion =
    "<!-- Markdown comment stays plain text -->\nFirst edition body\n";
  const secondVersion =
    "<!-- Markdown comment stays plain text -->\nSecond edition body\n";

  try {
    await writeFile(target, firstVersion, "utf8");
    const guide = file.from("guide.md").reference("guide");
    const config = defineConfig({
      root,
      plugins: [file],
      bindings: [binding("guide-policy", [guide])],
    });

    const initial = await check(config);
    assert.deepEqual(initial.scope, ["guide-policy"]);
    assert.equal(initial.bindings[0]?.consistency, "inconsistent");
    assert.equal(initial.bindings[0]?.changes[0]?.kind, "binding-added");
    assert.equal(
      initial.bindings[0]?.current?.references.guide?.value,
      firstVersion,
    );
    assert.deepEqual(initial.bindings[0]?.current?.references.guide?.range, {
      path: "guide.md",
      start: 0,
      end: firstVersion.length,
    });
    await assert.rejects(readFile(join(root, "dock.baseline.json"), "utf8"), {
      code: "ENOENT",
    });

    const updated = await updateBaseline(config);
    assert.equal(updated.status, "updated");

    const unchanged = await check(config);
    assert.equal(unchanged.bindings[0]?.consistency, "consistent");

    await writeFile(target, secondVersion, "utf8");
    const changed = await check(config);
    assert.equal(changed.bindings[0]?.consistency, "inconsistent");
    assert.deepEqual(changed.bindings[0]?.changes, [
      {
        kind: "fact",
        referenceId: "guide",
        before: firstVersion,
        after: secondVersion,
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("file existence can be checked, and missing files cannot be written to baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-file-exists-"));
  const target = join(root, "guide.md");
  const baselinePath = join(root, "dock.baseline.json");

  try {
    const source = "<!-- Plain file preserves original text -->\nBody\n";
    await writeFile(target, source, "utf8");
    const reference = file.from("guide.md").exists().reference("guide-exists");
    const config = defineConfig({
      root,
      plugins: [file],
      bindings: [binding("guide-policy", [reference])],
    });

    const initial = await check(config);
    assert.equal(initial.bindings[0]?.consistency, "inconsistent");
    assert.equal((await updateBaseline(config)).status, "updated");
    const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as {
      readonly bindings: Record<
        string,
        {
          readonly references: Record<string, { readonly value: unknown }>;
        }
      >;
    };
    assert.equal(
      baseline.bindings["guide-policy"]?.references["guide-exists"]?.value,
      true,
    );
    const originalBaseline = await readFile(baselinePath);

    await rm(target);
    const missing = await check(config);
    const failedBinding = missing.bindings[0];
    assert.ok(failedBinding && "errors" in failedBinding);
    assert.equal(failedBinding.errors[0]?.code, "missing-file");

    const rejected = await updateBaseline(config);
    assert.equal(rejected.status, "rejected");
    assert.deepEqual(await readFile(baselinePath), originalBaseline);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("unique text selection preserves source UTF-16 offsets and preceding unrelated text does not change the fact", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-file-quote-"));
  const target = join(root, "guide.md");
  const source = "😀x\nTARGET\n";

  try {
    await writeFile(target, source, "utf8");
    const reference = file.from("guide.md").quote("TARGET").reference("target");
    const config = defineConfig({
      root,
      plugins: [file],
      bindings: [binding("target-policy", [reference])],
    });

    const initial = await check(config);
    assert.deepEqual(initial.bindings[0]?.current?.references.target?.range, {
      path: "guide.md",
      start: 4,
      end: 10,
    });
    assert.equal((await updateBaseline(config)).status, "updated");

    await writeFile(target, `前置\n${source}`, "utf8");
    const moved = await check(config);
    assert.equal(moved.bindings[0]?.consistency, "consistent");
    assert.deepEqual(moved.bindings[0]?.current?.references.target?.range, {
      path: "guide.md",
      start: 7,
      end: 13,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("readReference reads current text and range of unbound references and fails without falling back to baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-file-read-reference-"));
  const target = join(root, "guide.md");
  const source = "😀说明\nTARGET\n";

  try {
    await writeFile(target, source, "utf8");
    const bound = file.from("guide.md").quote("TARGET").reference("bound");
    const standalone = file
      .from("guide.md")
      .quote("TARGET")
      .reference("standalone");
    const config = defineConfig({
      root,
      plugins: [file],
      bindings: [binding("guide-policy", [bound])],
    });
    assert.equal((await updateBaseline(config)).status, "updated");

    assert.deepEqual(await readReference(config, standalone), {
      value: "TARGET",
      range: { path: "guide.md", start: 5, end: 11 },
    });
    const movedSource = `前置\n${source}`;
    await writeFile(target, movedSource, "utf8");
    assert.deepEqual(await readReference(config, standalone), {
      value: "TARGET",
      range: { path: "guide.md", start: 8, end: 14 },
    });

    await writeFile(target, "😀说明\nchanged\n", "utf8");
    await assert.rejects(
      readReference(config, standalone),
      (error: unknown) => {
        assert.ok(error instanceof MaintenanceError);
        assert.equal(error.code, "missing-selection");
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("selectTextRange narrows UTF-16 ranges directly and throws TextSelectionError on invalid input", () => {
  const source = "😀prefix\n#region env\nport=4173\n#endregion env\n";
  const initialRange = { path: "env.txt", start: 0, end: source.length };
  const narrowed = selectTextRange(
    source,
    selectTextRange(source, initialRange, { kind: "region", name: "env" }),
    { kind: "match", pattern: "port=(\\d+)", group: 1 },
  );
  assert.deepEqual(narrowed, {
    path: "env.txt",
    start: source.indexOf("4173"),
    end: source.indexOf("4173") + 4,
  });

  assert.throws(
    () =>
      selectTextRange(source, initialRange, {
        kind: "quote",
        text: "absent",
      }),
    (error: unknown) => {
      assert.ok(error instanceof TextSelectionError);
      assert.equal(error.code, "missing-selection");
      return true;
    },
  );
});

void test("region selection can be narrowed further with unique regex capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-file-region-match-"));
  const source =
    "😀title\n#region outer\nouter body\n#region settings\nport=4173\n#endregion settings\nafter\n#endregion outer\n";

  try {
    await writeFile(join(root, "settings.txt"), source, "utf8");
    const port = file
      .from("settings.txt")
      .region("outer")
      .region("settings")
      .quote("port=4173")
      .match("port=(\\d+)", 1)
      .reference("port");
    const config = defineConfig({
      root,
      plugins: [file],
      bindings: [binding("port-policy", [port])],
    });

    const report = await check(config);
    const current = report.bindings[0]?.current?.references.port;
    assert.equal(current?.value, "4173");
    assert.deepEqual(current?.range, {
      path: "settings.txt",
      start: source.indexOf("4173"),
      end: source.indexOf("4173") + 4,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("duplicate, missing, and invalid text selection boundaries all reject baseline updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-file-selection-errors-"));
  const cases = [
    {
      id: "overlapping-quote",
      path: "overlapping.txt",
      source: "ababa",
      reference: file
        .from("overlapping.txt")
        .quote("aba")
        .reference("overlapping-quote"),
      code: "ambiguous-selection",
    },
    {
      id: "missing-quote",
      path: "missing.txt",
      source: "current value",
      reference: file
        .from("missing.txt")
        .quote("absent")
        .reference("missing-quote"),
      code: "missing-selection",
    },
    {
      id: "repeated-quote",
      path: "repeated-quote.txt",
      source: "guide guide",
      reference: file
        .from("repeated-quote.txt")
        .quote("guide")
        .reference("repeated-quote"),
      code: "ambiguous-selection",
    },
    {
      id: "empty-quote",
      path: "empty-quote.txt",
      source: "text",
      reference: file
        .from("empty-quote.txt")
        .quote("")
        .reference("empty-quote"),
      code: "invalid-selector",
    },
    {
      id: "selection-cannot-widen",
      path: "selection-cannot-widen.txt",
      source: "outside TARGET inside",
      reference: file
        .from("selection-cannot-widen.txt")
        .quote("TARGET")
        .quote("outside")
        .reference("selection-cannot-widen"),
      code: "missing-selection",
    },
    {
      id: "multiple-matches",
      path: "multiple.txt",
      source: "a a",
      reference: file
        .from("multiple.txt")
        .match("(a)", 1)
        .reference("multiple-matches"),
      code: "ambiguous-selection",
    },
    {
      id: "overlapping-matches",
      path: "overlapping-matches.txt",
      source: "ababa",
      reference: file
        .from("overlapping-matches.txt")
        .match("aba")
        .reference("overlapping-matches"),
      code: "ambiguous-selection",
    },
    {
      id: "empty-pattern",
      path: "empty-pattern.txt",
      source: "text",
      reference: file
        .from("empty-pattern.txt")
        .match("")
        .reference("empty-pattern"),
      code: "invalid-selector",
    },
    {
      id: "invalid-regex",
      path: "invalid-regex.txt",
      source: "text",
      reference: file
        .from("invalid-regex.txt")
        .match("(")
        .reference("invalid-regex"),
      code: "invalid-regex",
    },
    {
      id: "empty-match",
      path: "empty-match.txt",
      source: "bbb",
      reference: file
        .from("empty-match.txt")
        .match("a*")
        .reference("empty-match"),
      code: "empty-match",
    },
    {
      id: "missing-capture",
      path: "missing-capture.txt",
      source: "a",
      reference: file
        .from("missing-capture.txt")
        .match("(a)", 2)
        .reference("missing-capture"),
      code: "missing-capture",
    },
    {
      id: "empty-capture",
      path: "empty-capture.txt",
      source: "b",
      reference: file
        .from("empty-capture.txt")
        .match("(a*)b", 1)
        .reference("empty-capture"),
      code: "empty-capture",
    },
    {
      id: "repeated-region",
      path: "repeated-region.txt",
      source:
        "#region repeated\none\n#endregion repeated\n#region repeated\ntwo\n#endregion repeated\n",
      reference: file
        .from("repeated-region.txt")
        .region("repeated")
        .reference("repeated-region"),
      code: "ambiguous-region",
    },
    {
      id: "unclosed-region",
      path: "unclosed-region.txt",
      source: "#region open\nbody\n",
      reference: file
        .from("unclosed-region.txt")
        .region("open")
        .reference("unclosed-region"),
      code: "malformed-region",
    },
    {
      id: "mismatched-region",
      path: "mismatched-region.txt",
      source: "#region open\nbody\n#endregion other\n",
      reference: file
        .from("mismatched-region.txt")
        .region("open")
        .reference("mismatched-region"),
      code: "malformed-region",
    },
    {
      id: "unnamed-region",
      path: "unnamed-region.txt",
      source: "#region\nbody\n",
      reference: file
        .from("unnamed-region.txt")
        .region("named")
        .reference("unnamed-region"),
      code: "malformed-region",
    },
    {
      id: "empty-region",
      path: "empty-region.txt",
      source: "#region empty\n \t\n#endregion empty\n",
      reference: file
        .from("empty-region.txt")
        .region("empty")
        .reference("empty-region"),
      code: "empty-region",
    },
    {
      id: "missing-region",
      path: "missing-region.txt",
      source: "#region another\nbody\n#endregion another\n",
      reference: file
        .from("missing-region.txt")
        .region("missing")
        .reference("missing-region"),
      code: "missing-region",
    },
  ];

  try {
    for (const item of cases) {
      await writeFile(join(root, item.path), item.source, "utf8");
    }
    const config = defineConfig({
      root,
      plugins: [file],
      bindings: cases.map((item) => binding(item.id, [item.reference])),
    });

    const report = await check(config);
    for (const item of cases) {
      const result = report.bindings.find(
        (bindingResult) => bindingResult.bindingId === item.id,
      );
      assert.ok(result && "errors" in result, item.id);
      assert.equal(result.errors[0]?.code, item.code, item.id);
    }

    assert.equal((await updateBaseline(config)).status, "rejected");
    await assert.rejects(readFile(join(root, "dock.baseline.json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("explicit empty complete declaration untracks the last binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-file-untracking-"));
  const baselinePath = join(root, "dock.baseline.json");

  try {
    await writeFile(join(root, "guide.txt"), "Body\n", "utf8");
    const initial = defineConfig({
      root,
      plugins: [file],
      bindings: [
        binding("guide-policy", [file.from("guide.txt").reference("guide")]),
      ],
    });
    assert.equal((await updateBaseline(initial)).status, "updated");

    const untrack = defineConfig({ root, plugins: [], bindings: [] });
    const result = await updateBaseline(untrack);
    assert.equal(result.status, "updated");
    assert.deepEqual(result.report.scope, ["guide-policy"]);
    const removedBinding = result.report.bindings[0];
    assert.ok(removedBinding && "untracked" in removedBinding);
    assert.equal(removedBinding.untracked, true);

    const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as {
      readonly bindings: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(baseline.bindings), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("plain file reference rejects invalid selection during declaration assembly", () => {
  const invalidConfig = {
    plugins: [file],
    bindings: [
      {
        id: "selected-policy",
        references: [
          {
            id: "selected-guide",
            pluginId: filePluginId,
            target: "guide.md",
            selection: { start: 0 },
          },
        ],
      },
    ],
  };
  assert.throws(
    () => Reflect.apply(defineConfig, undefined, [invalidConfig]),
    /invalid selection/i,
  );
});

void test("collection errors block baseline updates and preserve original bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-file-error-"));
  const target = join(root, "guide.txt");
  const baselinePath = join(root, "dock.baseline.json");

  try {
    await writeFile(target, "Still plain text\n", "utf8");
    const reference = file.from("guide.txt").reference("guide");
    const config = defineConfig({
      root,
      plugins: [file],
      bindings: [binding("guide-policy", [reference])],
    });
    assert.equal((await updateBaseline(config)).status, "updated");
    const originalBytes = await readFile(baselinePath);

    await rm(target);
    const report = await check(config);
    const failedBinding = report.bindings[0];
    assert.ok(failedBinding && "errors" in failedBinding);
    assert.equal(failedBinding.errors[0]?.code, "missing-file");

    const rejected = await updateBaseline(config);
    assert.equal(rejected.status, "rejected");
    assert.deepEqual(await readFile(baselinePath), originalBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("target change still reports a reference-definition diff when effective text is unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-file-target-"));

  try {
    await writeFile(join(root, "first.md"), "Same content\n", "utf8");
    await writeFile(join(root, "second.md"), "Same content\n", "utf8");
    const configFor = (target: string) =>
      defineConfig({
        root,
        plugins: [file],
        bindings: [
          binding("guide-policy", [file.from(target).reference("guide")]),
        ],
      });

    assert.equal(
      (await updateBaseline(configFor("first.md"))).status,
      "updated",
    );
    const changedTarget = await check(configFor("second.md"));
    const definitionChange = changedTarget.bindings[0]?.changes[0];
    assert.equal(definitionChange?.kind, "reference-definition");
    assert.equal(
      definitionChange?.kind === "reference-definition"
        ? definitionChange.referenceId
        : undefined,
      "guide",
    );
    assert.notDeepEqual(definitionChange?.before, definitionChange?.after);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("corrupted baseline fails explicitly instead of treating it as initial maintenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-file-baseline-"));
  const baselinePath = join(root, "dock.baseline.json");

  try {
    await writeFile(join(root, "guide.md"), "Body\n", "utf8");
    await writeFile(baselinePath, "{not json", "utf8");
    const config = defineConfig({
      root,
      plugins: [file],
      bindings: [
        binding("guide-policy", [file.from("guide.md").reference("guide")]),
      ],
    });

    await assert.rejects(check(config), (error: unknown) => {
      assert.ok(error instanceof MaintenanceError);
      assert.equal(error.code, "baseline-invalid");
      return true;
    });
    assert.equal(await readFile(baselinePath, "utf8"), "{not json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("plain file preflight rejects misspelled, missing, and mistyped text selector fields with reference ID", () => {
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
    const referenceId = `invalid-file-step-${index}`;
    const reference = {
      id: referenceId,
      pluginId: filePluginId,
      target: "guide.md",
      selection: { kind: "text", steps: [step] },
    };
    assert.throws(
      () => Reflect.apply(file.validate, file, [reference]),
      (error: unknown) =>
        error instanceof Error && error.message.includes(referenceId),
      `file.validate should reject step ${JSON.stringify(step)} with referenceId`,
    );
    assert.throws(
      () =>
        Reflect.apply(defineConfig, undefined, [
          {
            plugins: [file],
            bindings: [{ id: "invalid-policy", references: [reference] }],
          },
        ]),
      (error: unknown) =>
        error instanceof Error && error.message.includes(referenceId),
      `defineConfig should reject step ${JSON.stringify(step)} with referenceId`,
    );
  }

  assert.throws(
    () => file.from("guide.md").match("port=(\\d+)", -1),
    TypeError,
  );
  assert.throws(
    () => file.from("guide.md").match("port=(\\d+)", 1.5),
    TypeError,
  );
  assert.throws(() => file.from("guide.md").quote(JSON.parse("42")), TypeError);
  assert.throws(
    () => file.from("guide.md").region(JSON.parse("42")),
    TypeError,
  );
});

void test("plain file public entry supports quote, match with capture group, and region with source UTF-16 ranges", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-file-text-steps-"));
  const source =
    "😀header\n#region runtime\nport=4173\nhost=localhost\n#endregion runtime\n";

  try {
    await writeFile(join(root, "app.env"), source, "utf8");
    const quoted = file
      .from("app.env")
      .quote("host=localhost")
      .reference("quoted");
    const matched = file
      .from("app.env")
      .match("port=(\\d+)", 1)
      .reference("matched");
    const regional = file
      .from("app.env")
      .region("runtime")
      .reference("regional");
    const config = defineConfig({
      root,
      plugins: [file],
      bindings: [binding("env-policy", [quoted, matched, regional])],
    });

    const readMatched = await readReference(config, matched);
    assert.equal(readMatched.value, "4173");
    assert.deepEqual(readMatched.range, {
      path: "app.env",
      start: source.indexOf("4173"),
      end: source.indexOf("4173") + 4,
    });

    const report = await check(config);
    const entry = report.bindings[0];
    assert.ok(entry && "current" in entry);
    assert.equal(entry.current.references.quoted?.value, "host=localhost");
    assert.deepEqual(entry.current.references.quoted?.range, {
      path: "app.env",
      start: source.indexOf("host=localhost"),
      end: source.indexOf("host=localhost") + "host=localhost".length,
    });
    assert.equal(entry.current.references.matched?.value, "4173");
    assert.deepEqual(
      entry.current.references.matched?.range,
      readMatched.range,
    );
    assert.equal(
      entry.current.references.regional?.value,
      "port=4173\nhost=localhost\n",
    );
    assert.deepEqual(entry.current.references.regional?.range, {
      path: "app.env",
      start: source.indexOf("port=4173"),
      end: source.indexOf("#endregion runtime"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
