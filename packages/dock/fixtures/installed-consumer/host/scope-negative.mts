import {
  check,
  definePlugin,
  type PluginBatchResult,
  type PluginContext,
  type PluginRequest,
  type Reference,
} from "@boringparts/dock";

type ScopeReference = Reference<
  "fixture:scope-negative",
  "scope-negative-reference",
  { readonly path: string },
  string
>;

const valid = definePlugin({
  id: "fixture:scope-negative",
  validate(_reference: ScopeReference): void {},
  collect(request: PluginRequest<ScopeReference>): PluginBatchResult<string> {
    return {
      results: request.selectedReferences.map(({ id }) => ({
        referenceId: id,
        kind: "value",
        value: "scope fact",
      })),
    };
  },
  fileInfo(_reference: ScopeReference, _context: PluginContext): string {
    return "guide.md";
  },
});
void valid;

// @ts-expect-error Scope filters must use string IDs.
void check({ plugins: [], bindings: [] }, { binding: [42] });

definePlugin({
  id: "fixture:scope-negative",
  validate(_reference: ScopeReference): void {},
  collect(request: PluginRequest<ScopeReference>): PluginBatchResult<string> {
    return {
      results: request.selectedReferences.map(({ id }) => ({
        referenceId: id,
        kind: "value",
        value: "scope fact",
      })),
    };
  },
  // @ts-expect-error Plugin fileInfo can only return a path string or file: URL.
  fileInfo(): number {
    return 1;
  },
});

definePlugin({
  id: "fixture:scope-negative",
  validate(_reference: ScopeReference): void {},
  collect(request: PluginRequest<ScopeReference>): PluginBatchResult<string> {
    return {
      results: request.selectedReferences.map(({ id }) => ({
        referenceId: id,
        kind: "value",
        value: "scope fact",
      })),
    };
  },
  // @ts-expect-error Plugin comparableTarget must return a JSON value.
  comparableTarget(): () => void {
    return () => {};
  },
});

type WrongTargetReference = Reference<
  "fixture:scope-negative",
  string,
  string,
  string
>;
const wrongReferenceRequest = {
  id: "fixture:scope-negative" as const,
  validate(_reference: ScopeReference): void {},
  collect(
    _request: PluginRequest<WrongTargetReference>,
  ): PluginBatchResult<string> {
    return { results: [] };
  },
};
// @ts-expect-error collect must accept the same reference type as validate.
definePlugin(wrongReferenceRequest);

const wrongPreparedRequest = {
  id: "fixture:scope-negative" as const,
  validate(_reference: ScopeReference): void {},
  prepare(): { count: number } {
    return { count: 1 };
  },
  collect(
    _request: PluginRequest<ScopeReference, { count: string }>,
  ): PluginBatchResult<string> {
    return { results: [] };
  },
};
// @ts-expect-error collect must accept the prepared data type returned by prepare.
definePlugin(wrongPreparedRequest);

const wrongPluginIdentity = {
  id: "another-plugin" as const,
  validate(_reference: ScopeReference): void {},
  collect(_request: PluginRequest<ScopeReference>): PluginBatchResult<string> {
    return { results: [] };
  },
};
// @ts-expect-error Plugin ID must match the reference pluginId.
definePlugin(wrongPluginIdentity);

const wrongFactValue = {
  id: "fixture:scope-negative" as const,
  validate(_reference: ScopeReference): void {},
  collect(_request: PluginRequest<ScopeReference>): PluginBatchResult<number> {
    return { results: [] };
  },
};
// @ts-expect-error Batch value must match the reference value type.
definePlugin(wrongFactValue);
