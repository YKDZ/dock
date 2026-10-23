import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { binding, check, defineConfig, readReference } from "@ykdz/dock";
import { typescript } from "@ykdz/dock-reference-typescript";

void test("符号选择后继续收窄原文，读取与采集返回相同 UTF-16 范围", async () => {
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

void test("支持声明种类和嵌套路径，文本选择受符号范围约束", async () => {
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
      assert.ok(result.value.length > 0, `${label} (${declaration}) 应有源码`);
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

void test("缺失声明和语法错误明确失败，范围使用 UTF-16 偏移", async () => {
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

void test("无名调用和构造签名的返回类型不提升为接口成员", async () => {
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

void test("批量采集保留独立符号错误且不读取未选中的文件", async () => {
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
    assert.deepEqual(report.scope, ["missing-policy", "readable-policy"]);
    assert.deepEqual(report.pluginErrors, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
