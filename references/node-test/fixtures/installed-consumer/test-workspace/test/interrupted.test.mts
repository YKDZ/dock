import { existsSync } from "node:fs";
import { test } from "node:test";

import { beginExecution } from "@dock/reference-node-test";

test("等待信号后结束", () => {
  beginExecution();
  if (existsSync(new URL("../../interrupted.marker", import.meta.url))) {
    process.kill(process.ppid, "SIGTERM");
  }
});
