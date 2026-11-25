import {
  binding,
  createReference,
  defineConfig,
  definePlugin,
  file,
  filePluginId,
  readReference,
  type PluginBatchResult,
  type PluginContext,
  type PluginReadResult,
  type PluginRequest,
  type Reference,
} from "@boringparts/dock";

// @ts-expect-error Text selection must be constructed via public builders rather than arbitrary JSON.
file.from("guide.md").reference("invalid", { selection: { start: 0 } });

const existsBuilder = file.from("guide.md").exists();
// @ts-expect-error Existence references do not provide text narrowing steps.
existsBuilder.quote("text");

type UnsupportedSelection = { readonly start: number };
const unsupportedSelection = createReference<
  typeof filePluginId,
  "unsupported-selection",
  string,
  string,
  UnsupportedSelection
>(filePluginId, "unsupported-selection", "guide.md", {
  selection: { start: 0 },
});
defineConfig({
  plugins: [file],
  // @ts-expect-error FilePlugin rejects reference declarations outside public selections.
  bindings: [binding("unsupported-policy", [unsupportedSelection])],
});

type UnreadableReference = Reference<
  "fixture:unreadable",
  "unreadable",
  string,
  string
>;
const unreadable = definePlugin({
  id: "fixture:unreadable",
  validate(reference: UnreadableReference): void {
    void reference;
  },
  collect(
    request: PluginRequest<UnreadableReference>,
    context: PluginContext,
  ): PluginBatchResult<string> {
    void context;
    return {
      results: request.selectedReferences.map((reference) => ({
        referenceId: reference.id,
        kind: "value",
        value: reference.target,
      })),
    };
  },
});
const unreadableConfig = defineConfig({ plugins: [unreadable], bindings: [] });
const unreadableReference = createReference<
  "fixture:unreadable",
  "unreadable",
  string,
  string
>("fixture:unreadable", "unreadable", "current-value");
// @ts-expect-error Plugins without a read handler cannot be used with readReference.
void readReference(unreadableConfig, unreadableReference);

const fileConfig = defineConfig({ plugins: [file], bindings: [] });
const missingPluginReference = createReference(
  "fixture:not-registered",
  "missing-plugin",
  "current-value",
);
// @ts-expect-error Config does not register the plugin for this reference.
void readReference(fileConfig, missingPluginReference);

type InvalidReaderReference = Reference<
  "fixture:invalid-reader",
  "invalid-reader",
  string,
  number
>;
definePlugin({
  id: "fixture:invalid-reader",
  validate(reference: InvalidReaderReference): void {
    void reference;
  },
  collect(
    request: PluginRequest<InvalidReaderReference>,
    context: PluginContext,
  ): PluginBatchResult<number> {
    void context;
    return {
      results: request.selectedReferences.map(({ id }) => ({
        referenceId: id,
        kind: "value",
        value: 1,
      })),
    };
  },
  read(
    reference: InvalidReaderReference,
    context: PluginContext,
  ): PluginReadResult<number> {
    void reference;
    void context;
    // @ts-expect-error A plugin declaring number cannot return a string from read.
    return { value: "not-a-number" };
  },
});
