import { binding, defineConfig } from "@dock/sdk";

import { catalogPlugin, catalogReference } from "./external-plugin.mts";
import { policy } from "./reexported-declarations.mts";

export const catalog = catalogReference(
  "catalog-home",
  { kind: "catalog", path: "guide.json" },
  { field: "title", locale: "en" },
);

export const catalogBinding = binding("catalog-policy", [catalog]);

export const splitConfig = defineConfig({
  plugins: [catalogPlugin],
  bindings: [policy, catalogBinding],
});
