import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defineConfig, file, readReference } from "@ykdz/dock";
import { markdown } from "@ykdz/dock/markdown";

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
