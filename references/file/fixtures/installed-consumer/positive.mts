import { file } from "@dock/reference-file";
import {
  binding,
  createReference,
  defineConfig,
  definePlugin,
  type PluginResult,
  type Reference,
  type ReferenceValue,
  type ReferencePlugin,
} from "@dock/sdk";

import {
  catalogPlugin,
  catalogReference,
  type CatalogValue,
} from "./external-plugin.mjs";

type ChangelogReference = Reference<
  "fixture-plugin",
  "changelog",
  { readonly path: string },
  string
>;

const fixturePlugin: ReferencePlugin<
  "fixture-plugin",
  ChangelogReference,
  string
> = definePlugin({
  id: "fixture-plugin",
  validate(): void {},
  collect(reference, context): PluginResult<string> {
    return {
      kind: "value",
      value: `${context.root}/${reference.target.path}`,
    };
  },
});

const changelog = createReference<
  "fixture-plugin",
  "changelog",
  { readonly path: string },
  string
>(
  "fixture-plugin",
  "changelog",
  { path: "CHANGELOG.md" },
  {
    declaredAt: new URL("./dock.config.mjs", import.meta.url),
  },
);

const typedCatalog = catalogReference(
  "catalog-type-contract",
  { kind: "catalog", path: "catalog.json" },
  { field: "title", locale: "zh" },
);
declare const catalogValue: ReferenceValue<typeof typedCatalog>;
const exactCatalogValue: CatalogValue = catalogValue;
const exactReferenceValue: ReferenceValue<typeof typedCatalog> =
  exactCatalogValue;
void exactReferenceValue;

const typedCollection: PluginResult<string> = {
  kind: "collection",
  collection: {
    completeness: "partial",
    members: [
      { id: "chapter-1", value: "第一章" },
      {
        id: "chapter-2",
        error: { code: "unavailable", message: "暂不可用。" },
      },
    ],
  },
};
void typedCollection;

export const config = defineConfig({
  plugins: [file, fixturePlugin, catalogPlugin],
  bindings: [
    binding("maintained-documents", [
      file.from("guide.md").reference("guide"),
      changelog,
    ]),
    binding("typed-catalog", [
      catalogReference(
        "catalog",
        { kind: "catalog", path: "catalog.json" },
        { field: "title", locale: "zh" },
      ),
    ]),
  ],
});

export const emptyConfig = defineConfig({ plugins: [], bindings: [] });
