import { binding, check, defineConfig, updateBaseline } from "@ykdz/dock";

import { catalogPlugin, catalogReference } from "./external-plugin.mts";

const original = defineConfig({
  plugins: [catalogPlugin],
  bindings: [
    binding("external-policy", [
      catalogReference(
        "external-catalog",
        { kind: "catalog", path: "catalog.json" },
        { field: "title", locale: "en" },
      ),
    ]),
  ],
  baseline: "external-plugin.baseline.json",
});
const first = await updateBaseline(original);
assert(
  first.status === "updated",
  "External plugin initial baseline should succeed.",
);
const stable = await check(original);
assert(
  stable.bindings[0]?.consistency === "consistent",
  "External plugin stable value should match the baseline.",
);

const changedSelection = defineConfig({
  ...original,
  bindings: [
    binding("external-policy", [
      catalogReference(
        "external-catalog",
        { kind: "catalog", path: "catalog.json" },
        { field: "entries", locale: "en" },
      ),
    ]),
  ],
});
const definitionChange = await check(changedSelection);
assert(
  definitionChange.bindings[0]?.changes.some(
    (change) => change.kind === "reference-definition",
  ),
  "Selection change must report reference-definition diff.",
);

const brokenTarget = defineConfig({
  ...original,
  bindings: [
    binding("external-policy", [
      catalogReference(
        "external-catalog",
        { kind: "catalog", path: "broken" },
        { field: "title", locale: "en" },
      ),
    ]),
  ],
});
const failed = await check(brokenTarget);
assert(
  JSON.stringify(failed.bindings[0]?.errors?.map((error) => error.code)) ===
    JSON.stringify(["catalog-missing"]),
  "Plugin business errors must be preserved in binding errors.",
);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
