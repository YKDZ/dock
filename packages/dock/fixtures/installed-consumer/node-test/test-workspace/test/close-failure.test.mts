import assert from "node:assert/strict";
import { after, test } from "node:test";

import { beginExecution } from "@boringparts/dock/node-test";

test("business assertion passes before teardown", () => {
  beginExecution();
  assert.equal("resource released", "resource released");
});

after(() => {
  throw new Error("Shared teardown failed");
});
