import assert from "node:assert/strict";
import { test } from "node:test";

test("skipped business status", { skip: "pending rollout" }, () => {
  assert.fail("skipped test must not enter callback");
});

test("todo business status", { todo: "not yet implemented" }, () => {
  assert.ok(false);
});
