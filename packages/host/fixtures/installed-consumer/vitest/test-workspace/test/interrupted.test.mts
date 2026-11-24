import { writeFileSync } from "node:fs";

import { test } from "vitest";

test("about to interrupt", () => {
  writeFileSync("interrupted-started.marker", "started\n");
  process.kill(process.pid, "SIGTERM");
});
