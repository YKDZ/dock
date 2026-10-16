import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { beginExecution } from "@dock/reference-node-test";

test("选择的原生测试通过", () => {
  beginExecution();
  if (!existsSync(resolve(process.cwd(), "after-end.marker"))) return;
  const failure = readFileSync(
    resolve(process.cwd(), "after-end.marker"),
    "utf8",
  );
  setImmediate(() => {
    if (failure === "uncaught") {
      throw new Error("late-unhandled-error");
    }
    if (failure === "rejection") {
      void Promise.reject(new Error("late-unhandled-rejection"));
    }
    if (failure === "exit") process.exit(1);
  });
});
