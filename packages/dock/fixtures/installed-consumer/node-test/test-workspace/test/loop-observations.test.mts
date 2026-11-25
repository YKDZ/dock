import { test } from "node:test";

import { amount } from "../../loop-observations.config.mts";

for (const [name, value] of [
  ["alpha", 1],
  ["beta", 2],
] as const) {
  test(name, () => amount.record(value));
}
