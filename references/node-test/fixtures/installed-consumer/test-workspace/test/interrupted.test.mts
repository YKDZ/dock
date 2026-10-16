import { test } from "node:test";

import { beginExecution } from "@dock/reference-node-test";

test("主动中断本次 Node runner", () => {
  beginExecution();
  process.kill(process.ppid, "SIGTERM");
});
