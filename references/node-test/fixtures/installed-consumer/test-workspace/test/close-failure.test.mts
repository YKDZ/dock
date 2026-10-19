import assert from "node:assert/strict";
import { after, test } from "node:test";

import { beginExecution } from "@ykdz/dock-reference-node-test";

test("收尾前的业务断言通过", () => {
  beginExecution();
  assert.equal("资源已释放", "资源已释放");
});

after(() => {
  throw new Error("共同收尾失败");
});
