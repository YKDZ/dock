import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { typescript } from "@dock/reference-typescript";
import { check, readReference } from "@dock/sdk";

import config, { expression } from "./dock.config.mjs";

const source = await readFile(
  process.env.DOCK_SYMBOL_TARGET ?? "symbol-source.ts",
  "utf8",
);
const read = await readReference(config, expression);
const collected = await typescript.collect(expression, { root: process.cwd() });
assert.equal(collected.kind, "value");
assert.deepEqual({ value: collected.value, range: collected.range }, read);
assert.equal(source.slice(read.range.start, read.range.end), read.value);
const report = await check(config);
const checked = report.bindings[0]?.current?.references[expression.id];
assert.equal(checked?.value, read.value);
assert.deepEqual(checked?.range, read.range);
process.stdout.write(`${JSON.stringify({ read, checked })}\n`);
