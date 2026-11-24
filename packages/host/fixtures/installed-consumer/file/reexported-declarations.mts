import { binding } from "@ykdz/dock";

import { catalogReference } from "./external-plugin.mts";

const sharedCatalog = catalogReference(
  "catalog-shared",
  { kind: "catalog", path: "shared.json" },
  { field: "entries" },
  { declaredAt: "shared-catalog.mts" },
);

export const policy = binding("split-policy", [sharedCatalog]);
export { sharedCatalog };
