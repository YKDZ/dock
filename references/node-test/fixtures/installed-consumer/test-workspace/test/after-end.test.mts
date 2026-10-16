import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { beginExecution } from "@dock/reference-node-test";

test("选择的原生测试通过", () => {
  beginExecution();
  if (!existsSync(resolve(process.cwd(), "after-end.marker"))) return;
  setImmediate(() => {
    throw new Error("late-unhandled-error");
  });
});
