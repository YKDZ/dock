import { file } from "@dock/reference-file";
import {
  binding,
  createReference,
  defineConfig,
  definePlugin,
  type PluginResult,
  type Reference,
  type ReferencePlugin,
} from "@dock/sdk";

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

export const config = defineConfig({
  plugins: [file, fixturePlugin],
  bindings: [
    binding("maintained-documents", [
      file.from("guide.md").reference("guide"),
      changelog,
    ]),
  ],
  declarationSources: [new URL("./dock.config.mjs", import.meta.url)],
});
