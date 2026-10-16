export type {
  BaselineReferenceFact,
  BaselineUpdateIssue,
  BaselineUpdateOutcome,
  Baseline,
  BindingCheckResult,
  BindingBaseline,
  BindingChange,
  BindingDefinition,
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
export { check } from "./check.ts";
export { isJsonValue } from "./contracts.ts";
export { updateBaseline } from "./update-baseline.ts";
