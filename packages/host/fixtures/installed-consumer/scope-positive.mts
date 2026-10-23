import {
  binding,
  check,
  createReference,
  defineConfig,
  definePlugin,
  updateBaseline,
  type MaintenanceScope,
  type PluginBatchResult,
  type PluginContext,
  type PluginRequest,
  type Reference,
} from "@ykdz/dock";

type ScopeReference = Reference<
  "fixture:scope",
  "scope-reference",
  { readonly path: string },
  string
>;

type Prepared = { readonly paths: string[] };

const scopePlugin = definePlugin({
  id: "fixture:scope",
  validate(_reference: ScopeReference): void {},
  fileInfo(reference: ScopeReference, context: PluginContext): string {
    return `${context.root}/${reference.target.path}`;
  },
  prepare(references: readonly ScopeReference[]): Prepared {
    return { paths: references.map(({ target }) => target.path) };
  },
  describe(request: PluginRequest<ScopeReference, Prepared>) {
    return {
      data: { selected: request.selectedReferences.map(({ id }) => id) },
      text: [request.prepared?.paths.join("、") ?? ""],
    };
  },
  collect(
    request: PluginRequest<ScopeReference, Prepared>,
  ): PluginBatchResult<string> {
    return {
      results: request.selectedReferences.map((reference) => ({
        referenceId: reference.id,
        kind: "value",
        value: request.prepared?.paths.join("、") ?? reference.target.path,
      })),
    };
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
