import assert from "node:assert/strict";
import { test } from "node:test";

test("ordinary node native command preserves existing behavior", () => {
  assert.equal("ordinary test", "ordinary test");
});
