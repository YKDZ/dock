export { canonicalJson, copyJsonValue, isJsonValue } from "@ykdz/dock-core";
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
} from "@ykdz/dock-core";
export type {
  Binding,
  Config,
  ConfigInput,
  DeclarationSource,
  PluginContext,
  RunDeclaration,
  ExecutedRun,
  ExecutionView,
  PluginExecution,
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
export {
  check,
  inspect,
  MaintenanceError,
  updateBaseline,
} from "./maintenance.ts";
export type { ResolvedMaintenance, ResolvedRun } from "./resolution.ts";
export type {
  BaselineUpdateOutcome,
  CheckReport,
  MaintenanceScope,
  MaintenanceConfig,
} from "./maintenance.ts";
export type {
  ExecutionObservationRecord,
  ExecutionReadDiagnostic,
  ExecutionReadRecord,
  ExecutionRunRecord,
  ExecutionSummary,
  ExecutionTestCatalog,
  ExecutionTestRecord,
  ExecutionTestStatus,
} from "./execution.ts";
export { readReference } from "./read.ts";
