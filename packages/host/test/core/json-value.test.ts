import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalJson, copyJsonValue, isJsonValue } from "@ykdz/dock/core";

void test("comparable values reject special properties and cycles without invoking accessors or toJSON", () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 1;
    },
  });
  const nonEnumerableAccessor = Object.defineProperty({}, "hidden", {
    enumerable: false,
    get() {
      getterCalls += 1;
      return 1;
    },
  });
  const converted = {
    toJSON() {
      getterCalls += 1;
      return 1;
    },
  };
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const sparse: unknown[] = [];
  sparse.length = 1;
  const arrayAccessor = Object.defineProperty([1], "0", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 1;
    },
  });
  const nestedAccessor = { outer: [{ inner: accessor }] };
  const nestedArrayAccessor = { list: [arrayAccessor] };
  for (const value of [
    accessor,
    nonEnumerableAccessor,
    nestedAccessor,
    converted,
    Object.defineProperty({}, "hidden", { value: 1 }),
    { [Symbol("extra")]: 1 },
    Object.assign([1], { extra: 2 }),
    Object.assign([1], { [Symbol("extra")]: 2 }),
    Object.defineProperty([1], "hidden", { value: 2 }),
    Object.setPrototypeOf([1], null),
    Object.create({ inherited: 1 }),
    arrayAccessor,
    nestedArrayAccessor,
    sparse,
    NaN,
    Infinity,
    -Infinity,
    cycle,
  ]) {
    assert.equal(isJsonValue(value), false);
    assert.throws(() => copyJsonValue(value), TypeError);
    assert.throws(() => canonicalJson(value as never), TypeError);
  }
  assert.equal(getterCalls, 0);
});

void test("comparable values copy isolated data, preserve shared subvalues, and canonicalize encoding", () => {
  const shared = { values: [1, 2] };
  const original = { left: shared, right: shared };
  const copied = copyJsonValue(original);
  shared.values[0] = 9;
  assert.deepEqual(copied, {
    left: { values: [1, 2] },
    right: { values: [1, 2] },
  });
  assert.equal(canonicalJson({ b: [2, 1], a: -0 }), '{"a":0,"b":[2,1]}');
  assert.equal(canonicalJson({ a: 0, b: [2, 1] }), '{"a":0,"b":[2,1]}');
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  const value = Object.assign(Object.create(null) as Record<string, unknown>, {
    nested: [null, true],
  });
  Object.defineProperty(value, "__proto__", {
    enumerable: true,
    value: "data",
  });
  assert.deepEqual(
    copyJsonValue(value),
    JSON.parse('{"nested":[null,true],"__proto__":"data"}'),
  );
  assert.throws(() => copyJsonValue(new Date()), TypeError);
});
