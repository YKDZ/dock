import {
  binding,
  check,
  createReference,
  defineConfig,
  updateBaseline,
} from "@ykdz/dock";

import {
  makeBinding,
  physicalPlugin,
  physicalPluginId,
  readCollectionCount,
  resetCollectionCount,
  sharedReference,
  type PhysicalTarget,
  type PhysicalValue,
} from "./secondary/physical-author.mts";

const primarySharedReference = createReference<
  typeof physicalPluginId,
  "shared-reference",
  PhysicalTarget,
  PhysicalValue
>(
  physicalPluginId,
  "shared-reference",
  { path: "shared.json" },
  {
    declaredAt: "primary-author.mts",
  },
);
const primaryReference = createReference<
  typeof physicalPluginId,
  "primary-reference",
  PhysicalTarget,
  PhysicalValue
>(physicalPluginId, "primary-reference", { path: "primary.json" });

const config = defineConfig({
  plugins: [physicalPlugin],
  bindings: [
    makeBinding("secondary-policy", [sharedReference, primaryReference]),
    binding("primary-policy", [primarySharedReference]),
  ],
  baseline: "physical-multiversion.baseline.json",
});

resetCollectionCount();
const updated = await updateBaseline(config);
assert(
  updated.status === "updated",
  "Same-version multi-instance baseline should succeed.",
);
assert(
  readCollectionCount() === 1,
  "Same plugin receives only one batch collection per maintenance run.",
);
const current = await check(config);
assert(
  readCollectionCount() === 2,
  "Subsequent maintenance re-collects current facts.",
);
assert(
  current.bindings.every((result) => result.consistency === "consistent"),
  "Same-version multi-instance current report should be consistent.",
);

const conflictingReference = createReference<
  typeof physicalPluginId,
  "shared-reference",
  PhysicalTarget,
  PhysicalValue
>(physicalPluginId, "shared-reference", { path: "different.json" });
let conflict: unknown;
try {
  defineConfig({
    plugins: [physicalPlugin],
    bindings: [
      makeBinding("first-policy", [sharedReference]),
      binding("second-policy", [conflictingReference]),
    ],
  });
} catch (error) {
  conflict = error;
}
assert(
  conflict instanceof Error &&
    /Reference ID shared-reference maps to multiple distinct definitions/.test(
      conflict.message,
    ),
  "Conflicting definitions must be rejected during config assembly.",
);
assert(
  readCollectionCount() === 2,
  "Conflicts must be rejected before any collection.",
);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
