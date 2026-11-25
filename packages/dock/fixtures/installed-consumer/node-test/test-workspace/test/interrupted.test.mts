import { existsSync } from "node:fs";
import { test } from "node:test";

import { beginExecution } from "@ykdz/dock/node-test";

test("exits after signal", () => {
  beginExecution();
  if (existsSync(new URL("../../interrupted.marker", import.meta.url))) {
    process.kill(process.ppid, "SIGTERM");
  }
});
