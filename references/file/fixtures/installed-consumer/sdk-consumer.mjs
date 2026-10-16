import assert from "node:assert/strict";
import { access, readFile, rm, writeFile } from "node:fs/promises";

import { file } from "@dock/reference-file";
import { binding, check, defineConfig, updateBaseline } from "@dock/sdk";

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
