import { writeFileSync } from "node:fs";

import { test } from "vitest";

test("unstarted first", () => {
  writeFileSync("conflict-started.marker", "started\n");
});
