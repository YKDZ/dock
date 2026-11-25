import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import { beginExecution } from "@boringparts/dock/node-test";

test("primary business status meets expectation", () => {
  beginExecution();
  assert.equal(process.cwd(), resolve(import.meta.dirname, "../.."));
  assert.equal(2 + 2, 4);
});

test("secondary business status meets expectation", () => {
  beginExecution();
  assert.deepEqual({ committed: true }, { committed: true });
});
