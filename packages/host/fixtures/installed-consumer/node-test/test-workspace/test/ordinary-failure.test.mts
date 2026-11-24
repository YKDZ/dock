import assert from "node:assert/strict";
import { test } from "node:test";

test("ordinary node test failure still returns failing exit code", () => {
  assert.equal(1 + 1, 3);
});
