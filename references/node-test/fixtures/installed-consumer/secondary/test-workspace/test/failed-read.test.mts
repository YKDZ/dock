import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  defineNodeTestObservation,
  nodeTest as secondaryNodeTest,
  beginExecution,
} from "@ykdz/dock-reference-node-test";

import {
  currentText,
  numericObservation,
  readConfig,
} from "../../../observations.config.mts";

const secondaryObservation = defineNodeTestObservation(
  numericObservation.key,
  0,
);

test("读取后业务断言失败", async () => {
  beginExecution();
  const result = await secondaryNodeTest.readReferenceInTest(
    readConfig,
    currentText,
  );
  const source = await readFile(
    new URL("../../../read-business.txt", import.meta.url),
    "utf8",
  );
  assert.equal(result.range?.start, source.indexOf(result.value));
  secondaryObservation.record(result.value.length);

  try {
    await access(new URL("../../../failed-read.marker", import.meta.url));
  } catch {
    return;
  }
  assert.fail("读取成功后的业务断言失败。");
});
