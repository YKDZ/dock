import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { beginExecution } from "@ykdz/dock/node-test";

test("working directory resolves to effective root", () => {
  beginExecution();
  assert.equal(process.cwd(), resolve(import.meta.dirname, "../.."));
  assert.equal(
    readFileSync("business.data", "utf8"),
    "Node test reads this business fixture from effective root.\n",
  );
});
