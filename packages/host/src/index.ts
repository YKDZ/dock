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
  Awaitable,
  Binding,
  Config,
  ConfigInput,
  DeclarationSource,
  PluginBatchResult,
  PluginContext,
  PluginDeclarationSource,
  PluginDiscoveredBinding,
  PluginDiscoveryInput,
  PluginDiscoveryIssue,
  PluginDiscoveryResult,
  PluginIdentityMatches,
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
  RegisteredDeclarationSource,
  RegisteredReference,
} from "./contracts.ts";
export {
  binding,
  createReference,
  defineConfig,
  definePlugin,
} from "./authoring.ts";
export type {
  NormalizedConfig,
  NormalizedReference,
  ReferenceOptions,
} from "./authoring.ts";
export {
  check,
  checkForCli,
  inspect,
  MaintenanceError,
  updateBaseline,
  updateBaselineForCli,
} from "./maintenance.ts";
export type { ResolvedMaintenance, ResolvedPlugin } from "./resolution.ts";
export type {
  BaselineUpdateOutcome,
  CheckReport,
  CliCheckResult,
  CliUpdateBaselineResult,
  MaintenanceConfig,
  MaintenanceScope,
  Operation,
} from "./maintenance.ts";
export { readReference } from "./read.ts";
export {
  computeLineRange,
  getRecordedLineRange,
  lineRangeKey,
  recordLineRange,
} from "./line-range.ts";
export type { LineRange, LineRangeRecord } from "./line-range.ts";
export {
  ownJsonValue,
  ownPluginInformation,
  ownReference,
} from "./owned-data.ts";
