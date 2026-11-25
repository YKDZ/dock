import { writeFile } from "node:fs/promises";
import { test } from "node:test";

test("does not execute unselected run", async () => {
  await writeFile("unselected-run.marker", "started");
});
