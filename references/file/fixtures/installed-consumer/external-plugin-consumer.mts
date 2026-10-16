import { binding, check, defineConfig, updateBaseline } from "@dock/sdk";

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
assert(first.status === "updated", "外部插件首次基线应成功。");
const stable = await check(original);
assert(
  stable.bindings[0]?.consistency === "consistent",
  "外部插件稳定值应与基线一致。",
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
  "选择变化必须报告引用定义变化。",
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
  "插件业务错误必须保留在关联错误中。",
);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
