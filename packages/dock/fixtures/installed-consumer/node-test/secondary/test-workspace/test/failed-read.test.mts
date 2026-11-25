import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  beginExecution,
  defineNodeTestObservation,
  nodeTest as secondaryNodeTest,
} from "@boringparts/dock/node-test";

import {
  currentText,
  numericObservation,
  readConfig,
} from "../../../observations.config.mts";

const secondaryObservation = defineNodeTestObservation(
  numericObservation.key,
  0,
);

test("business assertion fails after read", async () => {
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
  assert.fail("Business assertion failed after successful read.");
});
