import { writeFile } from "node:fs/promises";
import { test } from "node:test";

test("executes selected run", async () => {
  await writeFile("selected-run.marker", "started");
});
