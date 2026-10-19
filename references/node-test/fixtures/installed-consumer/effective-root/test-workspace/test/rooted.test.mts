import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { beginExecution } from "@ykdz/dock-reference-node-test";

test("运行目录定位于有效 root", () => {
  beginExecution();
  assert.equal(process.cwd(), resolve(import.meta.dirname, "../.."));
  assert.equal(
    readFileSync("business.data", "utf8"),
    "Node 测试按有效 root 读取此业务资料。\n",
  );
});
