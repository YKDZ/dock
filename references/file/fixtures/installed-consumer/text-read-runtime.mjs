import assert from "node:assert/strict";

import {
  createReference,
  defineConfig,
  definePlugin,
  readReference,
} from "@ykdz/dock";
import { file } from "@ykdz/dock-reference-file";

const expectedValue = process.argv[2];
const expectedStart = Number(process.argv[3]);
const config = defineConfig({ plugins: [file], bindings: [] });
const selected = file
  .from("guide.md")
  .region("runtime")
  .match("port=(\\d+)", 1)
  .reference("standalone-port");
const current = await readReference(config, selected);
assert.deepEqual(current, {
  value: expectedValue,
  range: {
    path: "guide.md",
    start: expectedStart,
    end: expectedStart + expectedValue.length,
  },
});

await assert.rejects(
  readReference(
    config,
    file.from("guide.md").quote("stale value").reference("stale-quote"),
  ),
  (error) => error.code === "missing-selection",
);

let collected = 0;
const readable = definePlugin({
  id: "fixture:readable",
  validate() {},
  collect() {
    collected += 1;
    return { results: [] };
  },
  read(reference) {
    return { value: reference.target };
  },
});
const readableConfig = defineConfig({ plugins: [readable], bindings: [] });
assert.deepEqual(
  await readReference(
    readableConfig,
    createReference("fixture:readable", "unbound", "read-current-value"),
  ),
  { value: "read-current-value" },
);
assert.equal(collected, 0, "读取不得隐式执行采集或其他测试。");

const unreadable = definePlugin({
  id: "fixture:unreadable",
  validate() {},
  collect() {
    return { results: [] };
  },
});
const unreadableConfig = defineConfig({ plugins: [unreadable], bindings: [] });
await assert.rejects(
  readReference(
    unreadableConfig,
    createReference("fixture:unreadable", "unreadable", "target"),
  ),
  (error) => error.code === "reference-not-readable",
);

await assert.rejects(
  readReference(
    config,
    createReference("fixture:missing-plugin", "missing", "target"),
  ),
  (error) => error.code === "plugin-not-registered",
);

const invalidReader = definePlugin({
  id: "fixture:invalid-reader",
  validate() {},
  collect() {
    return { results: [] };
  },
  read() {
    return { value: undefined };
  },
});
const invalidConfig = defineConfig({ plugins: [invalidReader], bindings: [] });
await assert.rejects(
  readReference(
    invalidConfig,
    createReference("fixture:invalid-reader", "invalid-result", "target"),
  ),
  (error) => error.code === "invalid-plugin-read-result",
);

process.stdout.write("安装制品普通文本定位与稳定读取通过。\n");
