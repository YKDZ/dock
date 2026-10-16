export type {
  Baseline,
  BindingChange,
  BindingCheckResult,
  CheckError,
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
  PluginExecutionIdentity,
  PluginExecutionContext,
  PluginMemberResult,
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
export type {
  BaselineUpdateOutcome,
  CheckReport,
  MaintenanceScope,
  MaintenanceConfig,
} from "./maintenance.ts";
export { createExecutionSession } from "./execution.ts";
export type {
  ExecutionCallback,
  ExecutionRegistry,
  ExecutionRunRecord,
  ExecutionSession,
  ExecutionSummary,
  ExecutionTestRecord,
  ExecutionTestStatus,
} from "./execution.ts";
export { readReference } from "./read.ts";
