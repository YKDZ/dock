import { writeFileSync } from "node:fs";

import { test } from "vitest";

test("即将中断", () => {
  writeFileSync("interrupted-started.marker", "started\n");
  process.kill(process.pid, "SIGTERM");
});
