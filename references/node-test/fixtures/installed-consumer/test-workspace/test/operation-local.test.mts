import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { beginExecution } from "@dock/reference-node-test";

test("每次维护都重新执行", () => {
  beginExecution();
  appendFileSync(resolve(process.cwd(), "operation-count.txt"), "x");
});
