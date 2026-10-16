import { writeFile } from "node:fs/promises";
import { test } from "node:test";

test("首个冲突命令不应启动", async () => {
  await writeFile(
    new URL("../conflict-started.marker", import.meta.url),
    "first",
  );
});
