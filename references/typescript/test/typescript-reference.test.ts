import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { typescript } from "@dock/reference-typescript";
import { binding, check, defineConfig, readReference } from "@dock/sdk";

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
