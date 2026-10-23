import { writeFile } from "node:fs/promises";
import { test } from "node:test";

test("不执行未选运行", async () => {
  await writeFile("unselected-run.marker", "started");
});
