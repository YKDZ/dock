export { canonicalJson, copyJsonValue, isJsonValue } from "@dock/core";
export type {
  Baseline,
  BindingChange,
  BindingCheckResult,
  CheckError,
  CheckContext,
  ReferenceDefinition,
  ReferenceResult,
  TextRange,
  JsonValue,
} from "@dock/core";
export type {
  Binding,
  Config,
  ConfigInput,
  DeclarationSource,
  Awaitable,
  PluginContext,
  PluginBatchResult,
  PluginInformation,
  PluginMemberResult,
  PluginReadResult,
  PluginReferenceResult,
  PluginRequest,
  PluginResult,
  ReadableReferenceOf,
  ReadableReferencePlugin,
  Reference,
  ReferencePlugin,
  ReferenceValue,
} from "./contracts.ts";
export {
  binding,
  createReference,
  defineConfig,
  definePlugin,
} from "./authoring.ts";
export type { ReferenceOptions } from "./authoring.ts";
export {
  check,
  inspect,
  MaintenanceError,
  updateBaseline,
} from "./maintenance.ts";
export type { ResolvedMaintenance, ResolvedPlugin } from "./resolution.ts";
export type {
  BaselineUpdateOutcome,
  CheckReport,
  MaintenanceScope,
  MaintenanceConfig,
} from "./maintenance.ts";
export { readReference } from "./read.ts";
export {
  file,
  filePluginId,
  selectTextRange,
  TextSelectionError,
} from "./file/index.ts";
export type {
  FileTextSelection,
  FileExistsSelection,
  FileSelection,
  FileReference,
  FileReferenceBuilder,
  FileReferenceLocation,
  FileTextReferenceBuilder,
  FileExistsReferenceBuilder,
  FileReferenceOptions,
  FilePlugin,
  TextSelectionStep,
} from "./file/index.ts";
