export type {
  Baseline,
  BaselineUpdateOutcome,
  BindingChange,
  BindingCheckResult,
  CheckError,
  CheckReport,
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
  PluginContext,
  PluginReadResult,
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
export { check, MaintenanceError, updateBaseline } from "./maintenance.ts";
export type { MaintenanceConfig } from "./maintenance.ts";
export { readReference } from "./read.ts";
