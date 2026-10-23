import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { binding, check, defineConfig, readReference } from "@ykdz/dock";
import { markdown } from "@ykdz/dock-reference-markdown";

import config, {
  chapter,
  code,
  directFile,
  emptyCell,
  inlineCode,
  link,
  list,
  markerDocument,
  runtimePort,
  standalone,
  standaloneMarker,
  stablePort,
  table,
  tableCell,
} from "./dock.config.mjs";

const source = await readFile("guide.md", "utf8");
const markerSource = await readFile("markers-guide.md", "utf8");
const selected = {};
for (const reference of [
  chapter,
  stablePort,
  markerDocument,
  code,
  list,
  inlineCode,
  link,
  table,
  tableCell,
  emptyCell,
  runtimePort,
  standalone,
  standaloneMarker,
]) {
  const result = await readReference(config, reference);
  const report = await check(
    defineConfig({
      root: process.cwd(),
      plugins: [markdown],
      bindings: [binding("selected-reference", [reference])],
    }),
  );
  const collected = report.bindings[0]?.current?.references[reference.id];
  assert.ok(collected);
  assert.deepEqual({ value: collected.value, range: collected.range }, result);
  if (reference.id === "marker-document") {
    assert.equal(result.range.start, 0);
    assert.equal(result.range.end, markerSource.length);
  } else {
    assert.equal(
      source.slice(result.range.start, result.range.end),
      result.value,
    );
  }
  selected[reference.id] = result;
}

const raw = await readReference(config, directFile);
assert.equal(raw.value, source);
assert.equal(raw.range.start, 0);
assert.equal(raw.range.end, source.length);
selected[directFile.id] = raw;
process.stdout.write(`${JSON.stringify(selected)}\n`);
