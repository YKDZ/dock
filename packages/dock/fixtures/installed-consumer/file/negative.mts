import {
  binding,
  createReference,
  defineConfig,
  definePlugin,
  file,
  readReference,
  type Config,
  type PluginBatchResult,
  type PluginContext,
  type PluginReadResult,
  type PluginRequest,
  type PluginResult,
  type Reference,
} from "@boringparts/dock";

import { splitConfig } from "./composition.mjs";
import { catalogReference } from "./external-plugin.mts";

// @ts-expect-error Binding requires at least one reference.
binding("empty", []);

const missingPlugin = createReference<
  "unregistered-plugin",
  "unregistered-reference",
  string,
  string
>("unregistered-plugin", "unregistered-reference", "guide.md");
const invalidBinding = binding("invalid-policy", [missingPlugin]);
defineConfig({
  plugins: [file],
  // @ts-expect-error Config must register the plugin used by the reference declaration.
  bindings: [invalidBinding],
});

// @ts-expect-error Config entry must explicitly provide bindings.
defineConfig({ plugins: [] });

// @ts-expect-error Config entry must explicitly provide plugins.
defineConfig({ bindings: [] });

type HookReference = Reference<"hook-plugin", "hook-reference", string, string>;
type WrongHookReference = Reference<
  "hook-plugin",
  "hook-reference",
  { readonly path: string },
  string
>;

// @ts-expect-error fileInfo must accept the same reference type as validate.
definePlugin({
  id: "hook-plugin",
  validate(_reference: HookReference): void {},
  collect(request: PluginRequest<HookReference>): PluginBatchResult<string> {
    return {
      results: request.selectedReferences.map(({ id }) => ({
        referenceId: id,
        kind: "value",
        value: "ok",
      })),
    };
  },
  fileInfo(reference: WrongHookReference): string {
    return reference.target.path.toUpperCase();
  },
});

// @ts-expect-error comparableTarget must accept the same reference type as validate.
definePlugin({
  id: "hook-plugin",
  validate(_reference: HookReference): void {},
  collect(request: PluginRequest<HookReference>): PluginBatchResult<string> {
    return {
      results: request.selectedReferences.map(({ id }) => ({
        referenceId: id,
        kind: "value",
        value: "ok",
      })),
    };
  },
  comparableTarget(reference: WrongHookReference): string {
    return reference.target.path;
  },
});

// @ts-expect-error prepare must receive the same reference type declared by the plugin.
definePlugin({
  id: "hook-plugin",
  validate(_reference: HookReference): void {},
  prepare(references: readonly WrongHookReference[]): undefined {
    for (const reference of references) void reference.target.path;
    return undefined;
  },
  collect(request: PluginRequest<HookReference>): PluginBatchResult<string> {
    return {
      results: request.selectedReferences.map(({ id }) => ({
        referenceId: id,
        kind: "value",
        value: "ok",
      })),
    };
  },
});

type StringFactReference = Reference<
  "typed-plugin",
  "string-fact",
  string,
  string
>;
const invalidPlugin = {
  id: "typed-plugin",
  validate(_reference: StringFactReference): void {},
  collect(
    request: PluginRequest<StringFactReference>,
  ): PluginBatchResult<string> {
    return {
      // @ts-expect-error Success results must match the plugin's declared string type.
      results: request.selectedReferences.map(({ id }) => ({
        referenceId: id,
        kind: "value",
        value: 42,
      })),
    };
  },
};
definePlugin(invalidPlugin);

type PreparedReference = Reference<
  "prepared-plugin",
  "prepared-reference",
  string,
  string
>;
// @ts-expect-error collect must accept the prepared data type returned by prepare.
definePlugin({
  id: "prepared-plugin",
  validate(_reference: PreparedReference): void {},
  prepare(): { count: number } {
    return { count: 1 };
  },
  collect(
    _request: PluginRequest<PreparedReference, { count: string }>,
  ): PluginBatchResult<string> {
    return { results: [] };
  },
});

type StringReaderReference = Reference<
  "typed-reader",
  "string-reader",
  string,
  string
>;

// @ts-expect-error Plugin collected value must match the reference's declared string type.
definePlugin({
  id: "typed-reader",
  validate(_reference: StringReaderReference): void {},
  collect(
    _request: PluginRequest<StringReaderReference>,
  ): PluginBatchResult<number> {
    return { results: [] };
  },
});

// @ts-expect-error Plugin read value must match the reference's declared string type.
definePlugin({
  id: "typed-reader",
  validate(_reference: StringReaderReference): void {},
  collect(
    _request: PluginRequest<StringReaderReference>,
  ): PluginBatchResult<string> {
    return { results: [] };
  },
  read(_reference: StringReaderReference): PluginReadResult<number> {
    return { value: 42 };
  },
});

const directConfigMismatch = {
  id: "typed-reader",
  validate(_reference: StringReaderReference): void {},
  collect(
    _request: PluginRequest<StringReaderReference>,
  ): PluginBatchResult<number> {
    return { results: [] };
  },
  read(_reference: StringReaderReference): PluginReadResult<number> {
    return { value: 42 };
  },
};
// @ts-expect-error defineConfig must also reject mismatched implementations that bypass definePlugin.
defineConfig({ plugins: [directConfigMismatch], bindings: [] });

type WantedReference = Reference<"wanted", "registration", string, string>;
const wantedReference = createReference<
  "wanted",
  "registration",
  string,
  string
>("wanted", "registration", "target");

// @ts-expect-error definePlugin should reject plugin IDs that do not match the static reference identity.
definePlugin({
  id: "other",
  validate(_reference: WantedReference): void {},
  collect(request: PluginRequest<WantedReference>): PluginBatchResult<string> {
    return {
      results: request.selectedReferences.map(({ id }) => ({
        referenceId: id,
        kind: "value",
        value: "ok",
      })),
    };
  },
});

type MismatchedReadablePlugin = {
  readonly id: "other";
  validate(reference: WantedReference): void;
  collect(
    request: PluginRequest<WantedReference>,
    context: PluginContext,
  ): PluginBatchResult<string>;
  read(
    reference: WantedReference,
    context: PluginContext,
  ): PluginReadResult<string>;
};
declare const mismatchedConfig: Config<
  readonly [MismatchedReadablePlugin],
  readonly []
>;
// @ts-expect-error readReference type inference must reject mismatched plugin IDs.
void readReference(mismatchedConfig, wantedReference);

const invalidCollection: PluginResult<string> = {
  kind: "collection",
  collection: {
    completeness: "complete",
    members: [
      {
        id: "invalid-string-member",
        // @ts-expect-error Member success value must match the plugin's declared string type.
        value: 42,
      },
    ],
  },
};
void invalidCollection;

// @ts-expect-error Plain file reference does not accept arbitrary selection objects.
file.from("guide.md").reference("selected", { selection: { start: 0 } });

// @ts-expect-error Plain file target must be a path string or file: URL.
file.from(42);

// @ts-expect-error Catalog target requires concrete path and kind.
catalogReference("bad-target", { path: "x" }, { field: "title" });

catalogReference(
  "bad-selection",
  { kind: "catalog", path: "x" },
  // @ts-expect-error Catalog selection rejects undeclared fields.
  { field: "summary" },
);

defineConfig({
  plugins: [file],
  // @ts-expect-error Config checks plugin registration for every reference.
  bindings: [binding("catalog", [wantedReference])],
});

// @ts-expect-error Composed config bindings still require their plugins to be registered.
defineConfig({ plugins: [file], bindings: splitConfig.bindings });
