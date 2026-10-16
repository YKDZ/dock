import {
  binding,
  check,
  createReference,
  defineConfig,
  definePlugin,
  updateBaseline,
  type MaintenanceScope,
  type PluginContext,
  type PluginExecutionIdentity,
  type PluginResult,
  type Reference,
} from "@dock/sdk";

type ScopeReference = Reference<
  "fixture:scope",
  "scope-reference",
  { readonly path: string },
  string
>;

const scopePlugin = definePlugin({
  id: "fixture:scope",
  validate(_reference: ScopeReference): void {},
  fileInfo(reference: ScopeReference, context: PluginContext): string {
    return `${context.root}/${reference.target.path}`;
  },
  validateReferences(
    references: readonly ScopeReference[],
  ): readonly PluginExecutionIdentity[] {
    return references.map((reference) => ({
      identity: `scope:${reference.target.path}`,
      configuration: { path: reference.target.path },
    }));
  },
  collect(_reference: ScopeReference): PluginResult<string> {
    return { kind: "value", value: "scope fact" };
  },
});

const reference = createReference<
  "fixture:scope",
  "scope-reference",
  { readonly path: string },
  string
>("fixture:scope", "scope-reference", { path: "guide.md" });
const config = defineConfig({
  plugins: [scopePlugin],
  bindings: [binding("scope-binding", [reference])],
});
const scope: MaintenanceScope = {
  binding: ["scope-binding"],
  reference: ["scope-reference"],
  file: ["guide.md"],
};

void check(config, scope);
void updateBaseline(config, { reference: ["scope-reference"] });
