import assert from "node:assert/strict";
import { test } from "node:test";

import { beginExecution } from "@ykdz/dock/node-test";

test("should be excluded by name filter", () => {
  beginExecution();
  assert.ok(false, "excluded business test must not execute");
});

test("filter-kept business test", () => {
  beginExecution();
  assert.ok(true);
});
