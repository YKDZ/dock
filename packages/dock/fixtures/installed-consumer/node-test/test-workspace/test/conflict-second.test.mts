import { writeFile } from "node:fs/promises";
import { test } from "node:test";

test("second conflicting command must not start", async () => {
  await writeFile(
    new URL("../conflict-started.marker", import.meta.url),
    "second",
  );
});
