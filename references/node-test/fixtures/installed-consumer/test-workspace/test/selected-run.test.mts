import { writeFile } from "node:fs/promises";
import { test } from "node:test";

test("执行所选运行", async () => {
  await writeFile("selected-run.marker", "started");
});
