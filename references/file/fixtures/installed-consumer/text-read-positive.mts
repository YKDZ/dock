import {
  binding,
  createReference,
  defineConfig,
  definePlugin,
  readReference,
  type PluginBatchResult,
  type PluginContext,
  type PluginReadResult,
  type PluginRequest,
  type Reference,
  type ReferenceValue,
} from "@ykdz/dock";
import { file, type FileReference } from "@ykdz/dock-reference-file";

const selected = file
  .from("guide.md")
  .region("runtime")
  .match("port=(\\d+)", 1)
  .reference("runtime-port");
const exists = file.from("guide.md").exists().reference("guide-exists");
const fileConfig = defineConfig({
  plugins: [file],
  bindings: [binding("runtime-policy", [selected, exists])],
});
const textRead: Promise<PluginReadResult<string>> = readReference(
  fileConfig,
  selected,
);
const existenceRead: Promise<PluginReadResult<true>> = readReference(
  fileConfig,
  exists,
);
const unbound: FileReference<"unbound", string> = file
  .from("guide.md")
  .quote("standalone")
  .reference("unbound");
const unboundRead: Promise<PluginReadResult<string>> = readReference(
  fileConfig,
  unbound,
);

type CurrentSelection = { readonly kind: "current" };
type PluginReference = Reference<
  "fixture:readable",
  "plugin-value",
  string,
  number,
  CurrentSelection
>;

const readable = definePlugin({
  id: "fixture:readable",
  validate(reference: PluginReference): void {
    void reference;
  },
  collect(
    request: PluginRequest<PluginReference>,
    context: PluginContext,
  ): PluginBatchResult<number> {
    void context;
    return {
      results: request.selectedReferences.map((reference) => ({
        referenceId: reference.id,
        kind: "value",
        value: reference.target.length,
      })),
    };
  },
  read(
    reference: PluginReference,
    context: PluginContext,
  ): PluginReadResult<number> {
    void context;
    return { value: reference.target.length };
  },
  from(target: string): PluginReference {
    return createReference<
      "fixture:readable",
      "plugin-value",
      string,
      number,
      CurrentSelection
    >("fixture:readable", "plugin-value", target, {
      selection: { kind: "current" },
    });
  },
});
const pluginConfig = defineConfig({ plugins: [readable], bindings: [] });
const pluginReference = readable.from("current-value");
const pluginRead: Promise<PluginReadResult<number>> = readReference(
  pluginConfig,
  pluginReference,
);
const preservedRead: PluginReadResult<number> = readable.read(pluginReference, {
  root: ".",
});
const pluginValue: ReferenceValue<PluginReference> = 42;

void textRead;
void existenceRead;
void unboundRead;
void pluginRead;
void preservedRead;
void pluginValue;
