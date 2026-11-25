import { test } from "node:test";

import { beginExecution } from "@boringparts/dock/node-test";

test("parent fails", () => {
  test("subtest entered callback", async () => {
    beginExecution();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  test("subtest did not enter callback", () => {
    beginExecution();
  });
  throw new Error("parent failed before subtests finished");
});
