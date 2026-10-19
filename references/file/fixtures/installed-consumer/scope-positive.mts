import {
  binding,
  check,
  createReference,
  defineConfig,
  definePlugin,
  updateBaseline,
  type MaintenanceScope,
  type PluginContext,
  type PluginExecution,
  type RunDeclaration,
  type PluginExecutionContext,
  type PluginResult,
  type Reference,
} from "@ykdz/dock";

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
  execution: {
    declare(
      references: readonly ScopeReference[],
    ): readonly RunDeclaration<{ path: string }>[] {
      return references.map((reference) => ({
        identity: `scope:${reference.target.path}`,
        configuration: { path: reference.target.path },
        references: [reference.id],
      }));
    },
    execute() {
      return {
        lifecycle: "complete",
        commandAttempts: 1,
        testExecutions: 0,
        tests: [],
        errors: [],
      };
    },
  } satisfies PluginExecution<ScopeReference, { path: string }>,
  collect(
    reference: ScopeReference,
    context: PluginExecutionContext<{ path: string }>,
  ): PluginResult<string> {
    const run = context.execution.get(`scope:${reference.target.path}`);
    const path: string = run?.declaration.configuration.path ?? "";
    return { kind: "value", value: path };
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
