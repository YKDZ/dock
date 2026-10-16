import { writeFileSync } from "node:fs";

import { test } from "vitest";

test("不能开始的次项", () => {
  writeFileSync("conflict-started.marker", "started\n");
});
