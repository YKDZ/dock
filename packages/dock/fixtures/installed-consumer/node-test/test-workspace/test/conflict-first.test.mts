import { writeFile } from "node:fs/promises";
import { test } from "node:test";

test("first conflicting command must not start", async () => {
  await writeFile(
    new URL("../conflict-started.marker", import.meta.url),
    "first",
  );
});
