import { writeFileSync } from "node:fs";

import { test } from "vitest";

test("unstarted second", () => {
  writeFileSync("conflict-started.marker", "started\n");
});
