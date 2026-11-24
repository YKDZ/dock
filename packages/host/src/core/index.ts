export type {
  BaselineReferenceFact,
  BaselineUpdateIssue,
  BaselineUpdateOutcome,
  Baseline,
  BindingCheckResult,
  BindingBaseline,
  BindingChange,
  BindingDefinition,
  CheckContext,
  CheckInput,
  CheckReport,
  CollectionMemberChange,
  CurrentBinding,
  CurrentReferenceFact,
  DeclarationCompleteness,
  MemberDiscoveryCompleteness,
  TextRange,
  CheckError,
  JsonValue,
  ReferenceDefinition,
  ReferenceResult,
  ReferenceMemberResult,
} from "./contracts.ts";
export { check, resolveCheckScope } from "./check.ts";
export { canonicalJson, copyJsonValue, isJsonValue } from "./json-value.ts";
export { updateBaseline } from "./update-baseline.ts";
