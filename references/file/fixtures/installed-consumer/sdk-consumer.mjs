import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { file } from "@dock/reference-file";
import {
  binding,
  check,
  createReference,
  defineConfig,
  definePlugin,
  updateBaseline,
} from "@dock/sdk";

const target = "sdk-guide.txt";
const baseline = "dock.baseline.json";
await writeFile(target, "SDK 原始全文\n", "utf8");

const config = defineConfig({
  plugins: [file],
  bindings: [binding("sdk-policy", [file.from(target).reference("sdk-guide")])],
});

const initial = await check(config);
assert.deepEqual(initial.scope, ["sdk-policy"]);
assert.equal(initial.bindings[0]?.consistency, "inconsistent");
assert.equal("kind" in initial, false);
assert.equal("exitCode" in initial, false);
await assert.rejects(access(baseline), { code: "ENOENT" });

const update = await updateBaseline(config);
assert.equal(update.status, "updated");
assert.ok(update.report);
assert.equal("variant" in update, false);
assert.equal("exitCode" in update, false);

const current = await check(config);
assert.equal(current.bindings[0]?.consistency, "consistent");
assert.equal("kind" in current, false);
await writeFile(target, "SDK 更新后的全文\n", "utf8");
const changedFact = await check(config);
assert.equal(changedFact.bindings[0]?.changes[0]?.kind, "fact");
assert.equal((await updateBaseline(config)).status, "updated");
assert.equal((await check(config)).bindings[0]?.consistency, "consistent");

const identityRoot = "handler-identity-sdk";
await mkdir(identityRoot);
await writeFile(`${identityRoot}/guide.txt`, "同一份事实\n", "utf8");
const originalHandler = defineConfig({
  root: identityRoot,
  plugins: [file],
  bindings: [
    binding("handler-policy", [file.from("guide.txt").reference("same-file")]),
  ],
});
assert.equal((await updateBaseline(originalHandler)).status, "updated");

const alternateHandler = definePlugin({
  id: "@fixture/same-target-reader",
  validate(reference) {
    if (typeof reference.target !== "string") {
      throw new TypeError("目标必须是路径文本。");
    }
  },
  async collect(reference, context) {
    return {
      kind: "value",
      value: await readFile(resolve(context.root, reference.target), "utf8"),
    };
  },
});
const changedHandler = defineConfig({
  root: identityRoot,
  plugins: [alternateHandler],
  bindings: [
    binding("handler-policy", [
      createReference(alternateHandler.id, "same-file", "guide.txt"),
    ]),
  ],
});
const identityChange = await check(changedHandler);
assert.deepEqual(
  identityChange.bindings[0]?.changes.map((change) => change.kind),
  ["reference-definition"],
);
const definition = identityChange.bindings[0]?.changes[0];
assert.equal(definition?.kind, "reference-definition");
assert.deepEqual(definition?.before.target, {
  pluginId: "@dock/reference-file",
  target: "guide.txt",
});
assert.deepEqual(definition?.after.target, {
  pluginId: "@fixture/same-target-reader",
  target: "guide.txt",
});

const empty = defineConfig({ plugins: [], bindings: [] });
const untracked = await updateBaseline(empty);
assert.equal(untracked.status, "updated");
assert.deepEqual(untracked.report.scope, ["sdk-policy"]);
assert.equal(untracked.report.bindings[0]?.untracked, true);
const saved = JSON.parse(await readFile(baseline, "utf8"));
assert.deepEqual(Object.keys(saved.bindings), []);

await rm(baseline);
await rm(target);
process.stdout.write("安装制品 SDK 直接调用往返通过。\n");
