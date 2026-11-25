import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { beginExecution } from "@ykdz/dock/node-test";

test("re-executes on every maintenance operation", () => {
  beginExecution();
  appendFileSync(resolve(process.cwd(), "operation-count.txt"), "x");
});
