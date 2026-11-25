import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defineConfig, file, readReference } from "@boringparts/dock";
import { markdown } from "@boringparts/dock/markdown";

void test("plain file plugin preserves raw text when registered alongside markdown plugin", async () => {
  const source = "# 标题\n\n<!-- 普通注释 -->\n";
  const root = await mkdtemp(join(tmpdir(), "dock-markdown-file-test-"));
  try {
    await writeFile(join(root, "guide.md"), source, "utf8");
    const config = defineConfig({
      plugins: [file, markdown],
      bindings: [],
      root,
    });
    const reference = file.from("guide.md").reference("whole");
    const result = await readReference(config, reference);
    assert.equal(await readFile(join(root, "guide.md"), "utf8"), result.value);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("@boringparts/dock/core exposes only the public domain API without internal CST helpers", async () => {
  const coreModule = (await import("@boringparts/dock/core")) as Record<
    string,
    unknown
  >;
  for (const expected of [
    "assertBaseline",
    "assertJsonValue",
    "BaselineValidationError",
    "canonicalJson",
    "check",
    "copyJsonValue",
    "isJsonValue",
    "parseBaselineJson",
    "resolveCheckScope",
    "updateBaseline",
  ]) {
    assert.equal(
      expected in coreModule,
      true,
      `Expected @boringparts/dock/core to export ${expected}`,
    );
  }
  for (const internal of [
    "parseJsonDocument",
    "cstToJsonValue",
    "isWellFormedJsonString",
    "JsonSyntaxError",
    "assertBindingDefinition",
    "assertReferenceDefinition",
  ]) {
    assert.equal(
      internal in coreModule,
      false,
      `Expected @boringparts/dock/core NOT to export internal helper ${internal}`,
    );
  }
});
