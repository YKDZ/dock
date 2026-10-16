import { file } from "@dock/reference-file";
import { binding, check, defineConfig } from "@dock/sdk";

import { splitConfig } from "./composition.mts";
import { catalogPlugin, catalogReference } from "./external-plugin.mts";

const inline = defineConfig({
  plugins: [file, catalogPlugin],
  bindings: [
    binding("split-policy", [
      catalogReference(
        "catalog-shared",
        { kind: "catalog", path: "shared.json" },
        { field: "entries" },
        { declaredAt: "shared-catalog.mts" },
      ),
    ]),
    binding("catalog-policy", [
      catalogReference(
        "catalog-home",
        { kind: "catalog", path: "guide.json" },
        { field: "title", locale: "en" },
      ),
    ]),
  ],
});
const reversedPlugins = defineConfig({
  plugins: [catalogPlugin, file],
  bindings: inline.bindings,
});

assertEqual(await check(splitConfig), await check(inline));
assertEqual(await check(inline), await check(reversedPlugins));

function assertEqual(left: unknown, right: unknown): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error("拆分声明或插件顺序改变了核对结果。");
  }
}
