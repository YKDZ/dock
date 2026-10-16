import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { markdown } from "@dock/reference-markdown";
import { readReference } from "@dock/sdk";

import config, {
  chapter,
  code,
  directFile,
  emptyCell,
  inlineCode,
  link,
  list,
  runtimePort,
  standalone,
  table,
  tableCell,
} from "./dock.config.mjs";

const source = await readFile("guide.md", "utf8");
const selected = {};
for (const reference of [
  chapter,
  code,
  list,
  inlineCode,
  link,
  table,
  tableCell,
  emptyCell,
  runtimePort,
  standalone,
]) {
  const result = await readReference(config, reference);
  const collected = await markdown.collect(reference, { root: process.cwd() });
  assert.equal(collected.kind, "value");
  assert.deepEqual({ value: collected.value, range: collected.range }, result);
  assert.equal(
    source.slice(result.range.start, result.range.end),
    result.value,
  );
  selected[reference.id] = result;
}

const raw = await readReference(config, directFile);
assert.equal(raw.value, source);
assert.equal(raw.range.start, 0);
assert.equal(raw.range.end, source.length);
selected[directFile.id] = raw;
process.stdout.write(`${JSON.stringify(selected)}\n`);
