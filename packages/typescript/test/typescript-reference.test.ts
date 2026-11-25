import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { binding, check, defineConfig, readReference } from "@dock/host";
import { typescript, typescriptPluginId } from "@dock/typescript";

void test("typescript plugin preserves legacy plugin ID", () => {
  assert.equal(typescriptPluginId, "@ykdz/dock-reference-typescript");
  assert.equal(typescript.id, "@ykdz/dock-reference-typescript");
});

void test("symbol selection narrowed by plain text steps returns identical UTF-16 ranges in readReference and check", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-typescript-reference-"));
  try {
    const source = await readFile(
      new URL("../fixtures/symbol-source.ts", import.meta.url),
      "utf8",
    );
    await writeFile(join(root, "symbol-source.ts"), source, "utf8");

    const selected = typescript
      .from("symbol-source.ts")
      .symbol("calculate", "function")
      .quote("return input + 1;")
      .match("input \\+ 1")
      .reference("calculate-expression");
    const config = defineConfig({
      root,
      plugins: [typescript],
      bindings: [binding("calculation", [selected])],
    });

    const read = await readReference(config, selected);
    const checked = await check(config);
    const collected =
      checked.bindings[0]?.current?.references["calculate-expression"];

    assert.equal(read.value, "input + 1");
    assert.deepEqual(read.range, {
      path: "symbol-source.ts",
      start: source.indexOf("input + 1"),
      end: source.indexOf("input + 1") + "input + 1".length,
    });
    assert.equal(collected?.value, read.value);
    assert.deepEqual(collected?.range, read.range);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("supports declaration kinds and nested paths while constraining text selection to symbol range", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-typescript-declarations-"));
  try {
    const source = [
      'export const marker = "🚀";',
      "export interface Contract { value: string; run(input: string): string }",
      'export class Service { value = "class"; run(input: string) { return input; } }',
      "export type Output = string;",
      'export const manager = { nested: { run() { return "nested"; } } };',
      'export function outer() { const inner = "inside"; return inner; }',
      'export function another() { return "outside"; }',
      'export const twin = "variable"; export function twin() { return "function"; }',
      'export const arrowOwner = () => { const hidden = "arrow"; return hidden; };',
      'export const expressionOwner = function namedExpression() { const privateValue = "expression"; return privateValue; };',
      'export const computed = { ["dynamic"]: { trapped() { return "computed"; } } };',
      'export default function () { const anonymousOnly = "anonymous"; return anonymousOnly; }',
    ].join("\n");
    await writeFile(join(root, "declarations.ts"), source, "utf8");
    const config = defineConfig({ root, plugins: [typescript], bindings: [] });

    const selections = [
      ["Contract", "interface"],
      ["Service", "class"],
      ["Output", "type"],
      [["Service", "value"], "property"],
      [["Service", "run"], "method"],
      [["Contract", "value"], "property"],
      [["Contract", "run"], "method"],
      [["manager", "nested", "run"], "method"],
      [["outer", "inner"], "variable"],
      ["twin", "function"],
      ["twin", "variable"],
    ] as const;

    for (const [name, declaration] of selections) {
      const label = typeof name === "string" ? name : name.join(".");
      const reference = typescript
        .from("declarations.ts")
        .symbol(name, declaration)
        .reference(`${declaration}-${label}`);
      const result = await readReference(config, reference);
      assert.ok(
        result.value.length > 0,
        `${label} (${declaration}) should have source text`,
      );
      assert.equal(
        source.slice(result.range?.start, result.range?.end),
        result.value,
      );
      assert.equal(result.range?.path, "declarations.ts");
    }

    await assert.rejects(
      readReference(
        config,
        typescript
          .from("declarations.ts")
          .symbol("twin")
          .reference("ambiguous"),
      ),
      { code: "ambiguous-symbol" },
    );
    await assert.rejects(
      readReference(
        config,
        typescript
          .from("declarations.ts")
          .symbol(["arrowOwner", "hidden"], "variable")
          .reference("arrow-private"),
      ),
      { code: "missing-symbol" },
    );
    await assert.rejects(
      readReference(
        config,
        typescript
          .from("declarations.ts")
          .symbol("anonymousOnly", "variable")
          .reference("anonymous-private"),
      ),
      { code: "missing-symbol" },
    );
    await assert.rejects(
      readReference(
        config,
        typescript
          .from("declarations.ts")
          .symbol(["expressionOwner", "privateValue"], "variable")
          .reference("expression-private"),
      ),
      { code: "missing-symbol" },
    );
    await assert.rejects(
      readReference(
        config,
        typescript
          .from("declarations.ts")
          .symbol(["computed", "trapped"], "method")
          .reference("computed-private"),
      ),
      { code: "missing-symbol" },
    );

    const selected = typescript
      .from("declarations.ts")
      .symbol("outer", "function")
      .quote('return "outside";')
      .reference("inner-declaration");
    await assert.rejects(readReference(config, selected), {
      code: "missing-selection",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("missing declarations and syntax errors fail explicitly and ranges use UTF-16 offsets", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-typescript-invalid-"));
  try {
    const source = 'const astral = "🚀";\nfunction present() { return 1; }\n';
    await writeFile(join(root, "valid.ts"), source, "utf8");
    await writeFile(join(root, "invalid.ts"), "function broken( {\n", "utf8");
    const config = defineConfig({ root, plugins: [typescript], bindings: [] });

    const present = typescript
      .from("valid.ts")
      .symbol("present", "function")
      .reference("present");
    const result = await readReference(config, present);
    assert.equal(result.range?.start, source.indexOf("function present"));
    assert.equal(
      result.range?.end,
      source.indexOf("\n", source.indexOf("function present")),
    );
    assert.equal(
      source.slice(result.range?.start, result.range?.end),
      result.value,
    );

    await assert.rejects(
      readReference(
        config,
        typescript.from("valid.ts").symbol("absent").reference("missing"),
      ),
      { code: "missing-symbol" },
    );
    await assert.rejects(
      readReference(
        config,
        typescript.from("invalid.ts").symbol("broken").reference("invalid"),
      ),
      { code: "typescript-syntax-error" },
    );
    assert.throws(() => typescript.from("plain.js"), TypeError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("anonymous call and construct signature return types are not promoted as interface members", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "dock-typescript-anonymous-signature-"),
  );
  try {
    const source = [
      "export interface Callable { (): { hidden: string } }",
      "export interface Constructable { new (): { hidden: string } }",
      "export interface Proper { nested: { hidden: string } }",
      "export namespace Space { export const stable = { nested: { value: 1 } }; }",
    ].join("\n");
    await writeFile(join(root, "anonymous-signatures.ts"), source, "utf8");
    const config = defineConfig({ root, plugins: [typescript], bindings: [] });

    for (const name of ["Callable", "Constructable"] as const) {
      await assert.rejects(
        readReference(
          config,
          typescript
            .from("anonymous-signatures.ts")
            .symbol([name, "hidden"], "property")
            .reference(`${name}-hidden`),
        ),
        { code: "missing-symbol" },
      );
    }

    for (const [path, declaration] of [
      [["Proper", "nested", "hidden"], "property"],
      [["Space", "stable", "nested", "value"], "property"],
    ] as const) {
      const result = await readReference(
        config,
        typescript
          .from("anonymous-signatures.ts")
          .symbol(path, declaration)
          .reference(path.join("-")),
      );
      assert.equal(
        source.slice(result.range?.start, result.range?.end),
        result.value,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("batch collection isolates symbol errors and skips unselected files", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-typescript-batch-"));
  try {
    const source = "export function calculate() { return 42; }\n";
    await writeFile(join(root, "symbols.ts"), source, "utf8");
    const readable = typescript
      .from("symbols.ts")
      .symbol("calculate", "function")
      .reference("readable");
    const missingSymbol = typescript
      .from("symbols.ts")
      .symbol("notPresent", "function")
      .reference("missing-symbol");
    const unselected = typescript
      .from("not-selected.ts")
      .symbol("neverRead", "function")
      .reference("unselected");
    const config = defineConfig({
      root,
      plugins: [typescript],
      bindings: [
        binding("readable-policy", [readable]),
        binding("missing-policy", [missingSymbol]),
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
      "export function calculate() { return 42; }",
    );
    assert.deepEqual(readableResult.current.references.readable?.range, {
      path: "symbols.ts",
      start: source.indexOf("export function calculate"),
      end: source.indexOf("\n"),
    });
    assert.ok(missingResult && "errors" in missingResult);
    assert.equal(missingResult.errors[0]?.code, "missing-symbol");
    assert.deepEqual(missingResult.errors[0]?.range, {
      path: "symbols.ts",
      start: 0,
      end: source.length,
    });
    assert.deepEqual(report.scope, ["missing-policy", "readable-policy"]);
    assert.deepEqual(report.pluginErrors, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("typescript preflight rejects misspelled, missing, and mistyped text selector fields and extra selection fields with reference ID", () => {
  const sharedMisspelledMatch = {
    kind: "match",
    pattern: "port=(\\d+)",
    gropu: 1,
  };
  const invalidSelections: readonly unknown[] = [
    {
      kind: "typescript",
      steps: [{ kind: "symbol", name: ["calculate"] }, sharedMisspelledMatch],
    },
    {
      kind: "typescript",
      steps: [{ kind: "symbol", name: ["calculate"] }, { kind: "quote" }],
    },
    {
      kind: "typescript",
      steps: [
        { kind: "symbol", name: ["calculate"] },
        { kind: "quote", text: 42 },
      ],
    },
    {
      kind: "typescript",
      steps: [
        { kind: "symbol", name: ["calculate"] },
        { kind: "quote", text: "ok", extra: true },
      ],
    },
    {
      kind: "typescript",
      steps: [{ kind: "symbol", name: ["calculate"] }, { kind: "match" }],
    },
    {
      kind: "typescript",
      steps: [
        { kind: "symbol", name: ["calculate"] },
        { kind: "match", pattern: 42 },
      ],
    },
    {
      kind: "typescript",
      steps: [
        { kind: "symbol", name: ["calculate"] },
        { kind: "match", pattern: "port=(\\d+)", group: -1 },
      ],
    },
    {
      kind: "typescript",
      steps: [
        { kind: "symbol", name: ["calculate"] },
        { kind: "match", pattern: "port=(\\d+)", group: 1.5 },
      ],
    },
    {
      kind: "typescript",
      steps: [
        { kind: "symbol", name: ["calculate"] },
        { kind: "match", pattern: "port=(\\d+)", group: "1" },
      ],
    },
    {
      kind: "typescript",
      steps: [{ kind: "symbol", name: ["calculate"] }, { kind: "region" }],
    },
    {
      kind: "typescript",
      steps: [
        { kind: "symbol", name: ["calculate"] },
        { kind: "region", name: 42 },
      ],
    },
    {
      kind: "typescript",
      steps: [
        { kind: "symbol", name: ["calculate"] },
        { kind: "region", name: "env", extra: true },
      ],
    },
    {
      kind: "typescript",
      steps: [{ kind: "symbol", name: ["calculate"] }],
      extra: 1,
    },
  ];

  for (const [index, selection] of invalidSelections.entries()) {
    const referenceId = `invalid-ts-step-${index}`;
    const reference = {
      id: referenceId,
      pluginId: typescriptPluginId,
      target: "symbol-source.ts",
      selection,
    };
    assert.throws(
      () => Reflect.apply(typescript.validate, typescript, [reference]),
      (error: unknown) =>
        error instanceof Error && error.message.includes(referenceId),
      `typescript.validate should reject selection ${JSON.stringify(selection)} with referenceId`,
    );
    assert.throws(
      () =>
        Reflect.apply(defineConfig, undefined, [
          {
            plugins: [typescript],
            bindings: [{ id: "invalid-policy", references: [reference] }],
          },
        ]),
      (error: unknown) =>
        error instanceof Error && error.message.includes(referenceId),
      `defineConfig should reject selection ${JSON.stringify(selection)} with referenceId`,
    );
  }

  assert.throws(
    () =>
      typescript
        .from("symbol-source.ts")
        .symbol("calculate")
        .match("port=(\\d+)", -1),
    TypeError,
  );
  assert.throws(
    () =>
      typescript
        .from("symbol-source.ts")
        .symbol("calculate")
        .match("port=(\\d+)", 1.5),
    TypeError,
  );
  assert.throws(
    () =>
      typescript
        .from("symbol-source.ts")
        .symbol("calculate")
        .quote(JSON.parse("42")),
    TypeError,
  );
  assert.throws(
    () =>
      typescript
        .from("symbol-source.ts")
        .symbol("calculate")
        .region(JSON.parse("42")),
    TypeError,
  );
});

void test("typescript symbol steps compose with quote, capture-group match, and region while scoping and preserving symbol errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-typescript-text-steps-"));
  try {
    const source = [
      'export const badge = "😀";',
      "export function primary() {",
      "  /*",
      "  #region settings",
      "  const port = 4173;",
      "  #endregion settings",
      "  */",
      "  return 'primary';",
      "}",
      "export function secondary() {",
      "  /*",
      "  #region settings",
      "  const port = 5173;",
      "  #endregion settings",
      "  #region secondary-only",
      "  const mode = 'strict';",
      "  #endregion secondary-only",
      "  */",
      "  return 'secondary';",
      "}",
    ].join("\n");
    await writeFile(join(root, "ports.ts"), source, "utf8");

    const quoted = typescript
      .from("ports.ts")
      .symbol("primary", "function")
      .quote("return 'primary';")
      .reference("primary-return");
    const matched = typescript
      .from("ports.ts")
      .symbol("secondary", "function")
      .match("const port = (\\d+);", 1)
      .reference("secondary-port");
    const regional = typescript
      .from("ports.ts")
      .symbol("secondary", "function")
      .region("settings")
      .reference("secondary-settings");
    const chained = typescript
      .from("ports.ts")
      .symbol("secondary", "function")
      .region("secondary-only")
      .match("mode = '([^']+)'", 1)
      .reference("secondary-mode");

    const config = defineConfig({
      root,
      plugins: [typescript],
      bindings: [
        binding("ts-text-steps", [quoted, matched, regional, chained]),
      ],
    });

    const readQuoted = await readReference(config, quoted);
    assert.equal(readQuoted.value, "return 'primary';");
    assert.deepEqual(readQuoted.range, {
      path: "ports.ts",
      start: source.indexOf("return 'primary';"),
      end: source.indexOf("return 'primary';") + "return 'primary';".length,
    });

    const readMatched = await readReference(config, matched);
    assert.equal(readMatched.value, "5173");
    const secondaryStart = source.indexOf("export function secondary");
    const matchedPortOffset = source.indexOf("5173", secondaryStart);
    assert.deepEqual(readMatched.range, {
      path: "ports.ts",
      start: matchedPortOffset,
      end: matchedPortOffset + 4,
    });

    const readRegional = await readReference(config, regional);
    assert.equal(readRegional.value, "  const port = 5173;\n");
    const secondaryRegionBodyStart =
      source.indexOf("  #region settings\n", secondaryStart) +
      "  #region settings\n".length;
    assert.deepEqual(readRegional.range, {
      path: "ports.ts",
      start: secondaryRegionBodyStart,
      end: source.indexOf("  #endregion settings", secondaryStart),
    });

    const report = await check(config);
    const checked = report.bindings[0];
    assert.ok(checked && "current" in checked);
    assert.equal(checked.current.references["secondary-mode"]?.value, "strict");
    assert.deepEqual(checked.current.references["secondary-mode"]?.range, {
      path: "ports.ts",
      start: source.indexOf("strict"),
      end: source.indexOf("strict") + "strict".length,
    });

    await assert.rejects(
      readReference(
        config,
        typescript
          .from("ports.ts")
          .symbol("primary", "function")
          .region("secondary-only")
          .reference("out-of-symbol-region"),
      ),
      { code: "missing-region" },
    );

    await assert.rejects(
      readReference(
        config,
        typescript
          .from("ports.ts")
          .symbol("missingFn", "function")
          .match("port = (\\d+)", 1)
          .reference("missing-symbol-chained"),
      ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "missing-symbol" &&
        error instanceof Error &&
        /missingFn/u.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("batch collection reads multiple symbols including nested paths and chained text steps from one file", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-typescript-multi-symbol-"));
  try {
    const source = [
      'export const badge = "🚀";',
      'export const version = "0.3.0";',
      "export function greet(name: string) {",
      "  /*",
      "  #region body",
      "  return `hello ${name}`;",
      "  #endregion body",
      "  */",
      "  return `hello ${name}`;",
      "}",
      "export class Registry {",
      "  items = { count: 2 };",
      "  lookup(id: string) { return id; }",
      "}",
    ].join("\n");
    const modulePath = join(root, "module.ts");
    await writeFile(modulePath, source, "utf8");

    const versionRef = typescript
      .from("module.ts")
      .symbol("version", "variable")
      .reference("version-ref");
    const lookupRef = typescript
      .from("./module.ts")
      .symbol(["Registry", "lookup"], "method")
      .reference("lookup-ref");
    const greetTextRef = typescript
      .from("module.ts")
      .symbol("greet", "function")
      .region("body")
      .quote("hello ${name}")
      .reference("greet-text-ref");
    const nestedCountRef = typescript
      .from(pathToFileURL(modulePath))
      .symbol(["Registry", "items", "count"], "property")
      .reference("nested-count-ref");

    const config = defineConfig({
      root,
      plugins: [typescript],
      bindings: [
        binding("multi-symbol", [
          versionRef,
          lookupRef,
          greetTextRef,
          nestedCountRef,
        ]),
      ],
    });

    const report = await check(config);
    const result = report.bindings[0];
    assert.ok(result !== undefined && result.current !== undefined);

    const expected = [
      ["version-ref", 'version = "0.3.0"'],
      ["lookup-ref", "lookup(id: string) { return id; }"],
      ["greet-text-ref", "hello ${name}"],
      ["nested-count-ref", "count: 2"],
    ] as const;

    for (const [id, value] of expected) {
      assert.equal(result.current.references[id]?.value, value);
      const start = source.indexOf(value);
      assert.deepEqual(result.current.references[id]?.range, {
        path: "module.ts",
        start,
        end: start + value.length,
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("batch collection reports per-reference syntax and read errors while collecting valid files in the same batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-typescript-syntax-batch-"));
  try {
    await writeFile(
      join(root, "broken.ts"),
      "const first = 1;\nexport function broken( {\n",
      "utf8",
    );
    const validSource = [
      "export const port = 4173;",
      "export class Server { start() { return port; } }",
    ].join("\n");
    await writeFile(join(root, "valid.ts"), validSource, "utf8");

    const config = defineConfig({
      root,
      plugins: [typescript],
      bindings: [
        binding("broken-policy", [
          typescript
            .from("broken.ts")
            .symbol("first", "variable")
            .reference("broken-first"),
          typescript
            .from("broken.ts")
            .symbol("broken", "function")
            .reference("broken-fn"),
        ]),
        binding("missing-policy", [
          typescript
            .from("missing.ts")
            .symbol("alpha", "variable")
            .reference("missing-alpha"),
          typescript
            .from("missing.ts")
            .symbol("beta", "function")
            .reference("missing-beta"),
        ]),
        binding("valid-policy", [
          typescript
            .from("valid.ts")
            .symbol("port", "variable")
            .reference("valid-port"),
          typescript
            .from("valid.ts")
            .symbol(["Server", "start"], "method")
            .reference("valid-start"),
        ]),
      ],
    });

    const report = await check(config);
    assert.deepEqual(report.pluginErrors, []);

    const brokenBinding = report.bindings.find(
      ({ bindingId }) => bindingId === "broken-policy",
    );
    assert.ok(brokenBinding && "errors" in brokenBinding);
    assert.deepEqual(
      brokenBinding.errors.map(({ referenceId, code }) => ({
        referenceId,
        code,
      })),
      [
        { referenceId: "broken-first", code: "typescript-syntax-error" },
        { referenceId: "broken-fn", code: "typescript-syntax-error" },
      ],
    );
    for (const error of brokenBinding.errors) {
      assert.match(error.message, /broken\.ts \(\d+:\d+\):/u);
    }

    const missingBinding = report.bindings.find(
      ({ bindingId }) => bindingId === "missing-policy",
    );
    assert.ok(missingBinding && "errors" in missingBinding);
    assert.deepEqual(
      missingBinding.errors.map(({ referenceId, code }) => ({
        referenceId,
        code,
      })),
      [
        { referenceId: "missing-alpha", code: "typescript-file-read-failed" },
        { referenceId: "missing-beta", code: "typescript-file-read-failed" },
      ],
    );

    const validBinding = report.bindings.find(
      ({ bindingId }) => bindingId === "valid-policy",
    );
    assert.ok(validBinding && "current" in validBinding);
    assert.equal(
      validBinding.current.references["valid-port"]?.value,
      "port = 4173",
    );
    assert.deepEqual(validBinding.current.references["valid-port"]?.range, {
      path: "valid.ts",
      start: validSource.indexOf("port = 4173"),
      end: validSource.indexOf("port = 4173") + "port = 4173".length,
    });
    assert.equal(
      validBinding.current.references["valid-start"]?.value,
      "start() { return port; }",
    );
    assert.deepEqual(validBinding.current.references["valid-start"]?.range, {
      path: "valid.ts",
      start: validSource.indexOf("start() { return port; }"),
      end:
        validSource.indexOf("start() { return port; }") +
        "start() { return port; }".length,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("independent checks observe symbol edits and syntax error fixes without stale caching", async () => {
  const root = await mkdtemp(join(tmpdir(), "dock-typescript-fresh-runs-"));
  try {
    const targetPath = join(root, "target.ts");
    const recoverablePath = join(root, "recoverable.ts");

    const initialTarget = [
      'export const greeting = "before";',
      "export function compute() { return 1; }",
    ].join("\n");
    await writeFile(targetPath, initialTarget, "utf8");
    await writeFile(recoverablePath, "export function broken( {\n", "utf8");

    const config = defineConfig({
      root,
      plugins: [typescript],
      bindings: [
        binding("target-policy", [
          typescript
            .from("target.ts")
            .symbol("greeting", "variable")
            .reference("greeting-ref"),
          typescript
            .from("target.ts")
            .symbol("compute", "function")
            .reference("compute-ref"),
        ]),
        binding("recoverable-policy", [
          typescript
            .from("recoverable.ts")
            .symbol("broken", "function")
            .reference("broken-ref"),
          typescript
            .from("recoverable.ts")
            .symbol("status", "variable")
            .reference("status-ref"),
        ]),
      ],
    });

    const first = await check(config);
    const firstTarget = first.bindings.find(
      ({ bindingId }) => bindingId === "target-policy",
    );
    const firstRecoverable = first.bindings.find(
      ({ bindingId }) => bindingId === "recoverable-policy",
    );
    assert.ok(firstTarget && "current" in firstTarget);
    assert.equal(
      firstTarget.current.references["greeting-ref"]?.value,
      'greeting = "before"',
    );
    assert.equal(
      firstTarget.current.references["greeting-ref"]?.range?.start,
      initialTarget.indexOf('greeting = "before"'),
    );
    assert.ok(firstRecoverable && "errors" in firstRecoverable);
    assert.deepEqual(
      firstRecoverable.errors.map(({ code }) => code),
      ["typescript-syntax-error", "typescript-syntax-error"],
    );

    const updatedTarget = [
      "// shifted header",
      'export const greeting = "after-edit";',
      "export function compute() { return 2; }",
    ].join("\n");
    const fixedRecoverable = [
      'export function broken() { return "fixed"; }',
      'export const status = "ok";',
    ].join("\n");
    await writeFile(targetPath, updatedTarget, "utf8");
    await writeFile(recoverablePath, fixedRecoverable, "utf8");

    const second = await check(config);
    const secondTarget = second.bindings.find(
      ({ bindingId }) => bindingId === "target-policy",
    );
    const secondRecoverable = second.bindings.find(
      ({ bindingId }) => bindingId === "recoverable-policy",
    );
    assert.ok(secondTarget && "current" in secondTarget);
    assert.equal(
      secondTarget.current.references["greeting-ref"]?.value,
      'greeting = "after-edit"',
    );
    assert.deepEqual(secondTarget.current.references["greeting-ref"]?.range, {
      path: "target.ts",
      start: updatedTarget.indexOf('greeting = "after-edit"'),
      end:
        updatedTarget.indexOf('greeting = "after-edit"') +
        'greeting = "after-edit"'.length,
    });
    assert.equal(
      secondTarget.current.references["compute-ref"]?.value,
      "export function compute() { return 2; }",
    );
    assert.ok(secondRecoverable && "current" in secondRecoverable);
    assert.equal(
      secondRecoverable.current.references["broken-ref"]?.value,
      'export function broken() { return "fixed"; }',
    );
    assert.equal(
      secondRecoverable.current.references["status-ref"]?.value,
      'status = "ok"',
    );

    await writeFile(recoverablePath, "export const status = ;\n", "utf8");
    const third = await check(config);
    const thirdRecoverable = third.bindings.find(
      ({ bindingId }) => bindingId === "recoverable-policy",
    );
    assert.ok(thirdRecoverable && "errors" in thirdRecoverable);
    assert.deepEqual(
      thirdRecoverable.errors.map(({ code }) => code),
      ["typescript-syntax-error", "typescript-syntax-error"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
