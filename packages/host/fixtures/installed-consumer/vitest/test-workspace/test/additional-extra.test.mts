import { appendFileSync } from "node:fs";

import { test } from "vitest";

test("additional test with different title", () => {
  appendFileSync("additional-test.marker", "additional test executed\n");
  throw new Error("unrelated assertion failure in additional test");
});
