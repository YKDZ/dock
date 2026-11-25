import {
  cstToJsonValue,
  isWellFormedJsonString,
  parseJsonDocument,
  type JsonCstNode,
  type JsonPropertyNode,
} from "./json-cst.ts";
import {
  assertJsonValue,
  copyJsonValue,
  type JsonValue,
} from "./json-value.ts";

export type { JsonValue } from "./json-value.ts";

/** Current source range used to explain check results; excluded from fact comparison. */
export type TextRange = { path: string; start: number; end: number };

/** Target location and selection rules compared separately from the collected value. */
export type ReferenceDefinition = {
  id: string;
  target: JsonValue;
  selection?: JsonValue;
  note?: string;
};

/** Undirected non-empty set of references; every reference is required for consistency. */
export type BindingDefinition = {
  id: string;
  references: string[];
  note?: string;
};

/** Whether declared bindings represent all registered bindings or a partial subset. */
export type DeclarationCompleteness = "complete" | "partial";

/** Whether member discovery covers all members in the target collection. */
export type MemberDiscoveryCompleteness = "complete" | "partial";

export type ReferenceResult =
  | { referenceId: string; value: JsonValue; range?: TextRange }
  | {
      referenceId: string;
      collection: {
        completeness: MemberDiscoveryCompleteness;
        members: ReferenceMemberResult[];
      };
      range?: TextRange;
    }
  | {
      referenceId: string;
      error: { code: string; message: string };
      range?: TextRange;
    };

/** Members have stable plugin-assigned IDs; member values preserve inner array order. */
export type ReferenceMemberResult =
  | { id: string; value: JsonValue }
  | { id: string; error: { code: string; message: string } };

export type BaselineReferenceFact = {
  definition: ReferenceDefinition;
  value: JsonValue;
  /** Default represents a scalar JSON fact; member collections use this marker to distinguish from same-shaped scalar arrays. */
  valueKind?: "member-collection";
};
export type BindingBaseline = {
  definition: BindingDefinition;
  references: Record<string, BaselineReferenceFact>;
};
export type Baseline = {
  version: 3;
  bindings: Record<string, BindingBaseline>;
};

export type CurrentReferenceFact = BaselineReferenceFact & {
  range?: TextRange;
};
export type CurrentBinding = {
  definition: BindingDefinition;
  references: Record<string, CurrentReferenceFact>;
};

export type CollectionMemberChange = {
  memberId: string;
  beforePresent: boolean;
  afterPresent: boolean;
  before?: JsonValue;
  after?: JsonValue;
};

export type BindingChange =
  | { kind: "binding-added" }
  | { kind: "binding-removed"; before: BindingDefinition }
  | {
      kind: "binding-definition";
      before: BindingDefinition;
      after: BindingDefinition;
    }
  | { kind: "reference-added"; referenceId: string }
  | { kind: "reference-removed"; referenceId: string }
  | {
      kind: "reference-definition";
      referenceId: string;
      before: ReferenceDefinition;
      after: ReferenceDefinition;
    }
  | {
      kind: "fact";
      referenceId: string;
      before: JsonValue;
      after: JsonValue;
      beforeKind?: "member-collection";
      afterKind?: "member-collection";
    }
  | {
      kind: "fact";
      referenceId: string;
      memberChanges: CollectionMemberChange[];
      beforeKind?: "member-collection";
      afterKind?: "member-collection";
    };

export type CheckError = {
  referenceId?: string;
  memberId?: string;
  code: string;
  message: string;
  range?: TextRange;
};
type BindingCheckResultBase = { bindingId: string; changes: BindingChange[] };
export type BindingCheckResult =
  | (BindingCheckResultBase & {
      consistency: "consistent" | "inconsistent";
      current: CurrentBinding;
      errors?: never;
    })
  | (BindingCheckResultBase & {
      errors: CheckError[];
      consistency?: never;
      current?: never;
      untracked?: never;
    })
  | (BindingCheckResultBase & {
      untracked: true;
      consistency: "inconsistent";
      changes: [{ kind: "binding-removed"; before: BindingDefinition }];
      current?: never;
      errors?: never;
    });

/** Pre-check context containing resolved declarations, historical baseline, and check scope. */
export type CheckContext = {
  references: ReferenceDefinition[];
  bindings: BindingDefinition[];
  baseline?: Baseline;
  declarationCompleteness?: DeclarationCompleteness;
  scope?: readonly string[];
};
export type CheckInput = CheckContext & { facts: ReferenceResult[] };
export type CheckReport = {
  declaration: {
    completeness: DeclarationCompleteness;
    bindingIds: string[];
  };
  scope: string[];
  bindings: BindingCheckResult[];
};

/** Operation-level rejection reason (such as empty-selection); binding errors live on report.bindings. */
export type BaselineUpdateIssue = {
  code: string;
  message: string;
};
export type BaselineUpdateOutcome =
  | { status: "updated"; baseline: Baseline; report: CheckReport }
  | { status: "rejected"; errors: BaselineUpdateIssue[]; report: CheckReport };

export type BaselineValidationIssueCode =
  | "duplicate-key"
  | "unknown-field"
  | "missing-field"
  | "invalid-type"
  | "invalid-version"
  | "invalid-id"
  | "id-mismatch"
  | "duplicate-id"
  | "missing-reference-fact"
  | "unexpected-reference-fact"
  | "invalid-json-value";

export type BaselineValidationIssue = {
  readonly path: string;
  readonly code: BaselineValidationIssueCode;
  readonly message: string;
  readonly line?: number;
};

export type ParseBaselineJsonOptions = {
  /** Optional callback for caller-defined validation of `definition.target` records. */
  readonly validateTargetDefinition?: (
    node: JsonCstNode,
    path: string,
    reportIssue: (issue: BaselineValidationIssue) => void,
  ) => JsonValue | undefined;
};

/** Thrown when a V3 baseline fails structural validation; carries all collected issues. */
export class BaselineValidationError extends TypeError {
  readonly issues: readonly BaselineValidationIssue[];

  constructor(
    issues: readonly BaselineValidationIssue[],
    message?: string,
    options?: ErrorOptions,
  ) {
    super(message ?? formatBaselineValidationIssues(issues), options);
    this.name = "BaselineValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

function formatBaselineValidationIssues(
  issues: readonly BaselineValidationIssue[],
): string {
  if (issues.length === 1) {
    return issues[0]!.message;
  }
  return `Invalid baseline format:\n${issues.map((issue) => `  - ${issue.message}`).join("\n")}`;
}

const ROOT_ALLOWED_KEYS = new Set(["version", "bindings"]);
const ROOT_REQUIRED_KEYS = ["version", "bindings"] as const;
const BINDING_ALLOWED_KEYS = new Set(["definition", "references"]);
const BINDING_REQUIRED_KEYS = ["definition", "references"] as const;
const BINDING_DEFINITION_ALLOWED_KEYS = new Set(["id", "references", "note"]);
const BINDING_DEFINITION_REQUIRED_KEYS = ["id", "references"] as const;
const REFERENCE_FACT_ALLOWED_KEYS = new Set([
  "definition",
  "value",
  "valueKind",
]);
const REFERENCE_FACT_REQUIRED_KEYS = ["definition", "value"] as const;
const REFERENCE_DEFINITION_ALLOWED_KEYS = new Set([
  "id",
  "target",
  "selection",
  "note",
]);
const REFERENCE_DEFINITION_REQUIRED_KEYS = ["id", "target"] as const;
const MEMBER_ITEM_ALLOWED_KEYS = new Set(["id", "value"]);
const MEMBER_ITEM_REQUIRED_KEYS = ["id", "value"] as const;

const IDENTIFIER_KEY_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

function fieldPath(basePath: string, key: string): string {
  return IDENTIFIER_KEY_PATTERN.test(key)
    ? `${basePath}.${key}`
    : `${basePath}[${JSON.stringify(key)}]`;
}

function mapEntryPath(basePath: string, key: string): string {
  return `${basePath}[${JSON.stringify(key)}]`;
}

function unsupportedVersionMessage(version: unknown): string {
  return `Unsupported baseline version ${String(version)}; expected version 3. Review current bindings and references, remove or replace the old baseline, rebuild with \`dock baseline update --config <config>\`, and verify with \`dock check --config <config>\`.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}

type OwnProperty = { present: false } | { present: true; value: unknown };

function readOwnDataProperty(value: object, key: string): OwnProperty {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return { present: false };
  if (!descriptor.enumerable || !("value" in descriptor)) {
    throw new TypeError(`Property ${key} cannot be an accessor property.`);
  }
  return { present: true, value: descriptor.value };
}

function assertId(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${context} must be a non-empty string.`);
  }
}

function assertReferenceIds(
  ids: unknown,
  bindingId: string,
): asserts ids is string[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new TypeError(
      `Reference list for binding ${bindingId} cannot be empty.`,
    );
  }
  const seen = new Set<string>();
  for (let index = 0; index < ids.length; index++) {
    const element = Object.getOwnPropertyDescriptor(ids, String(index));
    if (element === undefined || !element.enumerable || !("value" in element)) {
      throw new TypeError(
        `Reference ID in binding ${bindingId} must be a non-empty string.`,
      );
    }
    const id = element.value;
    assertId(id, `Reference ID in binding ${bindingId}`);
    if (seen.has(id)) {
      throw new TypeError(
        `Reference list for binding ${bindingId} contains duplicate ID: ${id}`,
      );
    }
    seen.add(id);
  }
}

export function assertBindingDefinition(
  value: unknown,
): asserts value is BindingDefinition {
  if (!isRecord(value)) {
    throw new TypeError("Binding definition must be an object.");
  }
  const idProperty = readOwnDataProperty(value, "id");
  const id = idProperty.present ? idProperty.value : undefined;
  assertId(id, "Binding ID");
  const references = readOwnDataProperty(value, "references");
  assertReferenceIds(references.present ? references.value : undefined, id);
  const noteProperty = readOwnDataProperty(value, "note");
  const note = noteProperty.present ? noteProperty.value : undefined;
  if (note !== undefined && typeof note !== "string") {
    throw new TypeError(`Binding ${id} note must be a string.`);
  }
}

export function copyBindingDefinition(
  value: BindingDefinition,
): BindingDefinition {
  return {
    id: value.id,
    references: [...value.references],
    ...(value.note === undefined ? {} : { note: value.note }),
  };
}

function parseReferenceDefinition(
  value: unknown,
  copyValues: boolean,
): ReferenceDefinition {
  if (!isRecord(value)) {
    throw new TypeError("Reference definition must be an object.");
  }
  const idProperty = readOwnDataProperty(value, "id");
  const id = idProperty.present ? idProperty.value : undefined;
  assertId(id, "Reference ID");

  const targetProperty = readOwnDataProperty(value, "target");
  if (!targetProperty.present) {
    throw new TypeError(`Reference ${id} is missing target.`);
  }
  let target: JsonValue;
  try {
    if (copyValues) {
      target = copyJsonValue(targetProperty.value);
    } else {
      assertJsonValue(targetProperty.value);
      target = targetProperty.value;
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw new TypeError(
        `Reference ${id} target must be a valid JSON value.`,
        { cause: error },
      );
    }
    throw error;
  }

  const selectionProperty = readOwnDataProperty(value, "selection");
  let selection: JsonValue | undefined;
  if (selectionProperty.present && selectionProperty.value !== undefined) {
    try {
      if (copyValues) {
        selection = copyJsonValue(selectionProperty.value);
      } else {
        assertJsonValue(selectionProperty.value);
        selection = selectionProperty.value;
      }
    } catch (error) {
      if (error instanceof TypeError) {
        throw new TypeError(
          `Reference ${id} selection must be a valid JSON value.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  const noteProperty = readOwnDataProperty(value, "note");
  const note = noteProperty.present ? noteProperty.value : undefined;
  if (note !== undefined && typeof note !== "string") {
    throw new TypeError(`Reference ${id} note must be a string.`);
  }

  return {
    id,
    target,
    ...(selection === undefined ? {} : { selection }),
    ...(note === undefined ? {} : { note }),
  };
}

export function assertReferenceDefinition(
  value: unknown,
): asserts value is ReferenceDefinition {
  parseReferenceDefinition(value, false);
}

export function copyReferenceDefinition(value: unknown): ReferenceDefinition {
  return parseReferenceDefinition(value, true);
}

export function copyBaselineReferenceFact(
  fact: BaselineReferenceFact,
): BaselineReferenceFact {
  return {
    definition: copyReferenceDefinition(fact.definition),
    value: copyJsonValue(fact.value),
    ...(fact.valueKind === undefined ? {} : { valueKind: fact.valueKind }),
  };
}

export function copyBindingBaseline(binding: BindingBaseline): BindingBaseline {
  const references: Record<string, BaselineReferenceFact> = Object.create(
    null,
  ) as Record<string, BaselineReferenceFact>;
  for (const [referenceId, fact] of Object.entries(binding.references)) {
    references[referenceId] = copyBaselineReferenceFact(fact);
  }
  return {
    definition: copyBindingDefinition(binding.definition),
    references,
  };
}

function collectCstObjectFields(
  node: Extract<JsonCstNode, { kind: "object" }>,
  basePath: string,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: readonly string[],
  issues: BaselineValidationIssue[],
): {
  props: Map<string, JsonPropertyNode>;
  duplicatedKeys: Set<string>;
} {
  const props = new Map<string, JsonPropertyNode>();
  const duplicatedKeys = new Set<string>();
  const invalidKeys = new Set<string>();

  for (const prop of node.properties) {
    const path = fieldPath(basePath, prop.key);
    if (!isWellFormedJsonString(prop.key)) {
      if (!invalidKeys.has(prop.key)) {
        invalidKeys.add(prop.key);
        issues.push({
          path,
          code: "invalid-json-value",
          message: `Property key at ${path} contains an unpaired surrogate.`,
          line: prop.keySpan.start.line,
        });
      }
      continue;
    }
    const first = props.get(prop.key);
    if (first !== undefined) {
      if (!duplicatedKeys.has(prop.key)) {
        duplicatedKeys.add(prop.key);
        issues.push({
          path,
          code: "duplicate-key",
          message: `Duplicate key ${JSON.stringify(prop.key)} at ${path} (lines ${first.keySpan.start.line} and ${prop.keySpan.start.line}).`,
          line: prop.keySpan.start.line,
        });
      }
      continue;
    }
    props.set(prop.key, prop);
    if (!allowedKeys.has(prop.key)) {
      issues.push({
        path,
        code: "unknown-field",
        message: `Unknown field ${JSON.stringify(prop.key)} at ${path}.`,
        line: prop.keySpan.start.line,
      });
    }
  }

  for (const reqKey of requiredKeys) {
    if (!props.has(reqKey) && !invalidKeys.has(reqKey)) {
      const path = fieldPath(basePath, reqKey);
      issues.push({
        path,
        code: "missing-field",
        message: `Missing required field ${JSON.stringify(reqKey)} at ${basePath}.`,
        line: node.span.start.line,
      });
    }
  }

  return { props, duplicatedKeys };
}

function collectCstMapEntries(
  node: Extract<JsonCstNode, { kind: "object" }>,
  basePath: string,
  entryKind: string,
  issues: BaselineValidationIssue[],
): {
  entries: Map<string, JsonPropertyNode>;
  duplicatedKeys: Set<string>;
} {
  const entries = new Map<string, JsonPropertyNode>();
  const duplicatedKeys = new Set<string>();
  const invalidKeys = new Set<string>();

  for (const prop of node.properties) {
    const path = mapEntryPath(basePath, prop.key);
    if (!isWellFormedJsonString(prop.key)) {
      if (!invalidKeys.has(prop.key)) {
        invalidKeys.add(prop.key);
        issues.push({
          path,
          code: "invalid-json-value",
          message: `${entryKind} key at ${path} contains an unpaired surrogate.`,
          line: prop.keySpan.start.line,
        });
      }
      continue;
    }
    const first = entries.get(prop.key);
    if (first !== undefined) {
      if (!duplicatedKeys.has(prop.key)) {
        duplicatedKeys.add(prop.key);
        issues.push({
          path,
          code: "duplicate-key",
          message: `Duplicate ${entryKind} key ${JSON.stringify(prop.key)} at ${path} (lines ${first.keySpan.start.line} and ${prop.keySpan.start.line}).`,
          line: prop.keySpan.start.line,
        });
      }
      continue;
    }
    entries.set(prop.key, prop);
    if (prop.key.length === 0) {
      issues.push({
        path,
        code: "invalid-id",
        message: `${entryKind} ID at ${basePath} must be a non-empty string.`,
        line: prop.keySpan.start.line,
      });
    }
  }

  return { entries, duplicatedKeys };
}

function readCstJsonValue(
  node: JsonCstNode,
  path: string,
  issues: BaselineValidationIssue[],
): JsonValue | undefined {
  try {
    return cstToJsonValue(node);
  } catch (error) {
    issues.push({
      path,
      code: "invalid-json-value",
      message: `${error instanceof Error ? error.message : String(error)} at ${path}.`,
      line: node.span.start.line,
    });
    return undefined;
  }
}

function readCstNonEmptyString(
  node: JsonCstNode,
  path: string,
  label: string,
  issues: BaselineValidationIssue[],
): string | undefined {
  if (node.kind !== "string" || node.value.length === 0) {
    issues.push({
      path,
      code: node.kind === "string" ? "invalid-id" : "invalid-type",
      message: `${label} at ${path} must be a non-empty string.`,
      line: node.span.start.line,
    });
    return undefined;
  }
  if (!isWellFormedJsonString(node.value)) {
    issues.push({
      path,
      code: "invalid-json-value",
      message: `${label} at ${path} contains an unpaired surrogate.`,
      line: node.span.start.line,
    });
    return undefined;
  }
  return node.value;
}

function parseCstBindingDefinition(
  node: JsonCstNode,
  bindingId: string,
  basePath: string,
  issues: BaselineValidationIssue[],
): BindingDefinition | undefined {
  if (node.kind !== "object") {
    issues.push({
      path: basePath,
      code: "invalid-type",
      message: `Binding definition at ${basePath} must be an object.`,
      line: node.span.start.line,
    });
    return undefined;
  }

  const { props, duplicatedKeys } = collectCstObjectFields(
    node,
    basePath,
    BINDING_DEFINITION_ALLOWED_KEYS,
    BINDING_DEFINITION_REQUIRED_KEYS,
    issues,
  );

  let valid = duplicatedKeys.size === 0;
  const idProp = props.get("id");
  let defId: string | undefined;
  if (idProp !== undefined && !duplicatedKeys.has("id")) {
    defId = readCstNonEmptyString(
      idProp.value,
      `${basePath}.id`,
      "Binding ID",
      issues,
    );
    if (defId === undefined) {
      valid = false;
    } else if (defId !== bindingId) {
      valid = false;
      issues.push({
        path: `${basePath}.id`,
        code: "id-mismatch",
        message: `Baseline binding ${JSON.stringify(bindingId)} has mismatched definition.id ${JSON.stringify(defId)}.`,
        line: idProp.value.span.start.line,
      });
    }
  } else {
    valid = false;
  }

  const refsProp = props.get("references");
  let declaredRefs: string[] | undefined;
  if (refsProp !== undefined && !duplicatedKeys.has("references")) {
    const refsPath = `${basePath}.references`;
    if (refsProp.value.kind !== "array" || refsProp.value.items.length === 0) {
      valid = false;
      issues.push({
        path: refsPath,
        code: "invalid-type",
        message: `Reference list for binding ${JSON.stringify(bindingId)} at ${refsPath} must be a non-empty array.`,
        line: refsProp.value.span.start.line,
      });
    } else {
      const seen = new Set<string>();
      const collected: string[] = [];
      let refsValid = true;
      for (let index = 0; index < refsProp.value.items.length; index += 1) {
        const item = refsProp.value.items[index]!;
        const itemPath = `${refsPath}[${index}]`;
        const refId = readCstNonEmptyString(
          item,
          itemPath,
          `Reference ID in binding ${JSON.stringify(bindingId)}`,
          issues,
        );
        if (refId === undefined) {
          refsValid = false;
          continue;
        }
        if (seen.has(refId)) {
          refsValid = false;
          issues.push({
            path: itemPath,
            code: "duplicate-id",
            message: `Reference list for binding ${JSON.stringify(bindingId)} contains duplicate ID ${JSON.stringify(refId)} at ${itemPath}.`,
            line: item.span.start.line,
          });
          continue;
        }
        seen.add(refId);
        collected.push(refId);
      }
      if (refsValid) {
        declaredRefs = collected;
      } else {
        valid = false;
      }
    }
  } else {
    valid = false;
  }

  const noteProp = props.get("note");
  let note: string | undefined;
  if (noteProp !== undefined && !duplicatedKeys.has("note")) {
    const notePath = `${basePath}.note`;
    if (noteProp.value.kind !== "string") {
      valid = false;
      issues.push({
        path: notePath,
        code: "invalid-type",
        message: `Binding ${JSON.stringify(bindingId)} note at ${notePath} must be a string.`,
        line: noteProp.value.span.start.line,
      });
    } else if (!isWellFormedJsonString(noteProp.value.value)) {
      valid = false;
      issues.push({
        path: notePath,
        code: "invalid-json-value",
        message: `Binding ${JSON.stringify(bindingId)} note at ${notePath} contains an unpaired surrogate.`,
        line: noteProp.value.span.start.line,
      });
    } else {
      note = noteProp.value.value;
    }
  }

  if (!valid || defId === undefined || declaredRefs === undefined) {
    return undefined;
  }
  return {
    id: defId,
    references: declaredRefs,
    ...(note === undefined ? {} : { note }),
  };
}

function parseCstReferenceDefinition(
  node: JsonCstNode,
  referenceId: string,
  bindingId: string,
  basePath: string,
  issues: BaselineValidationIssue[],
  options?: ParseBaselineJsonOptions,
): ReferenceDefinition | undefined {
  if (node.kind !== "object") {
    issues.push({
      path: basePath,
      code: "invalid-type",
      message: `Reference definition at ${basePath} must be an object.`,
      line: node.span.start.line,
    });
    return undefined;
  }

  const { props, duplicatedKeys } = collectCstObjectFields(
    node,
    basePath,
    REFERENCE_DEFINITION_ALLOWED_KEYS,
    REFERENCE_DEFINITION_REQUIRED_KEYS,
    issues,
  );

  let defId: string | undefined;
  const idProp = props.get("id");
  if (idProp !== undefined && !duplicatedKeys.has("id")) {
    defId = readCstNonEmptyString(
      idProp.value,
      `${basePath}.id`,
      "Reference ID",
      issues,
    );
    if (defId !== undefined && defId !== referenceId) {
      issues.push({
        path: `${basePath}.id`,
        code: "id-mismatch",
        message: `Baseline reference ${JSON.stringify(referenceId)} in binding ${JSON.stringify(bindingId)} has mismatched definition.id ${JSON.stringify(defId)}.`,
        line: idProp.value.span.start.line,
      });
    }
  }

  let target: JsonValue | undefined;
  const targetProp = props.get("target");
  if (targetProp !== undefined && !duplicatedKeys.has("target")) {
    const targetPath = `${basePath}.target`;
    if (options?.validateTargetDefinition !== undefined) {
      target = options.validateTargetDefinition(
        targetProp.value,
        targetPath,
        (issue) => issues.push(issue),
      );
    } else {
      target = readCstJsonValue(targetProp.value, targetPath, issues);
    }
  }

  let selection: JsonValue | undefined;
  const selectionProp = props.get("selection");
  if (selectionProp !== undefined && !duplicatedKeys.has("selection")) {
    selection = readCstJsonValue(
      selectionProp.value,
      `${basePath}.selection`,
      issues,
    );
  }

  let note: string | undefined;
  const noteProp = props.get("note");
  if (noteProp !== undefined && !duplicatedKeys.has("note")) {
    const notePath = `${basePath}.note`;
    if (noteProp.value.kind !== "string") {
      issues.push({
        path: notePath,
        code: "invalid-type",
        message: `Reference ${JSON.stringify(referenceId)} note at ${notePath} must be a string.`,
        line: noteProp.value.span.start.line,
      });
    } else if (!isWellFormedJsonString(noteProp.value.value)) {
      issues.push({
        path: notePath,
        code: "invalid-json-value",
        message: `Reference ${JSON.stringify(referenceId)} note at ${notePath} contains an unpaired surrogate.`,
        line: noteProp.value.span.start.line,
      });
    } else {
      note = noteProp.value.value;
    }
  }

  if (defId === undefined || target === undefined) {
    return undefined;
  }
  return {
    id: defId,
    target,
    ...(selection === undefined ? {} : { selection }),
    ...(note === undefined ? {} : { note }),
  };
}

function parseCstMemberCollection(
  node: JsonCstNode,
  referenceId: string,
  basePath: string,
  issues: BaselineValidationIssue[],
): JsonValue | undefined {
  if (node.kind !== "array") {
    issues.push({
      path: basePath,
      code: "invalid-type",
      message: `Member-collection baseline for reference ${JSON.stringify(referenceId)} at ${basePath} must be an array.`,
      line: node.span.start.line,
    });
    return undefined;
  }

  const memberIds = new Set<string>();
  const members: JsonValue[] = [];
  for (let index = 0; index < node.items.length; index += 1) {
    const item = node.items[index]!;
    const itemPath = `${basePath}[${index}]`;
    if (item.kind !== "object") {
      issues.push({
        path: itemPath,
        code: "invalid-type",
        message: `Member-collection baseline item at ${itemPath} for reference ${JSON.stringify(referenceId)} must be an object.`,
        line: item.span.start.line,
      });
      continue;
    }
    const { props, duplicatedKeys } = collectCstObjectFields(
      item,
      itemPath,
      MEMBER_ITEM_ALLOWED_KEYS,
      MEMBER_ITEM_REQUIRED_KEYS,
      issues,
    );
    let memberId: string | undefined;
    const idProp = props.get("id");
    if (idProp !== undefined && !duplicatedKeys.has("id")) {
      memberId = readCstNonEmptyString(
        idProp.value,
        `${itemPath}.id`,
        `Member ID of reference ${JSON.stringify(referenceId)}`,
        issues,
      );
      if (memberId !== undefined) {
        if (memberIds.has(memberId)) {
          issues.push({
            path: `${itemPath}.id`,
            code: "duplicate-id",
            message: `Duplicate member-collection baseline ID ${JSON.stringify(memberId)} for reference ${JSON.stringify(referenceId)} at ${itemPath}.id.`,
            line: idProp.value.span.start.line,
          });
        } else {
          memberIds.add(memberId);
        }
      }
    }
    let memberValue: JsonValue | undefined;
    const valueProp = props.get("value");
    if (valueProp !== undefined && !duplicatedKeys.has("value")) {
      memberValue = readCstJsonValue(
        valueProp.value,
        `${itemPath}.value`,
        issues,
      );
    }
    if (memberId !== undefined && memberValue !== undefined) {
      members.push({ id: memberId, value: memberValue });
    }
  }
  return members;
}

function parseCstReferenceFact(
  node: JsonCstNode,
  referenceId: string,
  bindingId: string,
  basePath: string,
  issues: BaselineValidationIssue[],
  options?: ParseBaselineJsonOptions,
): BaselineReferenceFact | undefined {
  if (node.kind !== "object") {
    issues.push({
      path: basePath,
      code: "invalid-type",
      message: `Baseline record for reference ${JSON.stringify(referenceId)} at ${basePath} must be an object.`,
      line: node.span.start.line,
    });
    return undefined;
  }

  const { props, duplicatedKeys } = collectCstObjectFields(
    node,
    basePath,
    REFERENCE_FACT_ALLOWED_KEYS,
    REFERENCE_FACT_REQUIRED_KEYS,
    issues,
  );

  let definition: ReferenceDefinition | undefined;
  const defProp = props.get("definition");
  if (defProp !== undefined && !duplicatedKeys.has("definition")) {
    definition = parseCstReferenceDefinition(
      defProp.value,
      referenceId,
      bindingId,
      `${basePath}.definition`,
      issues,
      options,
    );
  }

  let valueKind: "member-collection" | undefined;
  let valueKindValid = true;
  const valueKindProp = props.get("valueKind");
  if (valueKindProp !== undefined) {
    if (duplicatedKeys.has("valueKind")) {
      valueKindValid = false;
    } else if (
      valueKindProp.value.kind !== "string" ||
      valueKindProp.value.value !== "member-collection"
    ) {
      valueKindValid = false;
      issues.push({
        path: `${basePath}.valueKind`,
        code: "invalid-type",
        message: `Field "valueKind" at ${basePath}.valueKind must be "member-collection".`,
        line: valueKindProp.value.span.start.line,
      });
    } else {
      valueKind = "member-collection";
    }
  }

  let value: JsonValue | undefined;
  const valueProp = props.get("value");
  if (
    valueProp !== undefined &&
    !duplicatedKeys.has("value") &&
    valueKindValid
  ) {
    if (valueKind === "member-collection") {
      value = parseCstMemberCollection(
        valueProp.value,
        referenceId,
        `${basePath}.value`,
        issues,
      );
    } else {
      value = readCstJsonValue(valueProp.value, `${basePath}.value`, issues);
    }
  }

  if (definition === undefined || value === undefined || !valueKindValid) {
    return undefined;
  }
  return {
    definition,
    value,
    ...(valueKind === undefined ? {} : { valueKind }),
  };
}

/** Parses raw V3 baseline JSON via the lossless CST parser, collecting all Dock-owned structural issues in one pass. */
export function parseBaselineJson(
  source: string,
  options?: ParseBaselineJsonOptions,
): Baseline {
  const root = parseJsonDocument(source);
  const issues: BaselineValidationIssue[] = [];

  if (root.kind !== "object") {
    issues.push({
      path: "$",
      code: "invalid-type",
      message: "Baseline root must be a JSON object.",
      line: root.span.start.line,
    });
    throw new BaselineValidationError(issues);
  }

  const { props: rootProps, duplicatedKeys: rootDuplicated } =
    collectCstObjectFields(
      root,
      "$",
      ROOT_ALLOWED_KEYS,
      ROOT_REQUIRED_KEYS,
      issues,
    );

  let supportedVersion = false;
  const versionProp = rootProps.get("version");
  if (versionProp !== undefined && !rootDuplicated.has("version")) {
    const versionValue = readCstJsonValue(
      versionProp.value,
      "$.version",
      issues,
    );
    if (versionValue !== undefined) {
      if (versionValue === 3) {
        supportedVersion = true;
      } else {
        issues.push({
          path: "$.version",
          code: "invalid-version",
          message: unsupportedVersionMessage(versionValue),
          line: versionProp.value.span.start.line,
        });
      }
    }
  } else {
    // Missing or duplicated version: still inspect bindings to report independent issues.
    supportedVersion = true;
  }

  const bindings: Record<string, BindingBaseline> = Object.create(
    null,
  ) as Record<string, BindingBaseline>;
  const bindingsProp = rootProps.get("bindings");
  if (
    supportedVersion &&
    bindingsProp !== undefined &&
    !rootDuplicated.has("bindings")
  ) {
    if (bindingsProp.value.kind !== "object") {
      issues.push({
        path: "$.bindings",
        code: "invalid-type",
        message: 'Baseline field "bindings" at $.bindings must be an object.',
        line: bindingsProp.value.span.start.line,
      });
    } else {
      const { entries: bindingEntries, duplicatedKeys: bindingDupes } =
        collectCstMapEntries(
          bindingsProp.value,
          "$.bindings",
          "binding",
          issues,
        );

      for (const [bindingId, bindingProp] of bindingEntries) {
        if (bindingDupes.has(bindingId) || bindingId.length === 0) continue;
        const bindingPath = mapEntryPath("$.bindings", bindingId);
        if (bindingProp.value.kind !== "object") {
          issues.push({
            path: bindingPath,
            code: "invalid-type",
            message: `Baseline entry for binding ${JSON.stringify(bindingId)} at ${bindingPath} must be an object.`,
            line: bindingProp.value.span.start.line,
          });
          continue;
        }
        const { props: bindingProps, duplicatedKeys: bindingFieldDupes } =
          collectCstObjectFields(
            bindingProp.value,
            bindingPath,
            BINDING_ALLOWED_KEYS,
            BINDING_REQUIRED_KEYS,
            issues,
          );

        let definition: BindingDefinition | undefined;
        const defProp = bindingProps.get("definition");
        if (defProp !== undefined && !bindingFieldDupes.has("definition")) {
          definition = parseCstBindingDefinition(
            defProp.value,
            bindingId,
            `${bindingPath}.definition`,
            issues,
          );
        }

        const parsedRefs: Record<string, BaselineReferenceFact> = Object.create(
          null,
        ) as Record<string, BaselineReferenceFact>;
        const refsProp = bindingProps.get("references");
        if (refsProp !== undefined && !bindingFieldDupes.has("references")) {
          const refsPath = `${bindingPath}.references`;
          if (refsProp.value.kind !== "object") {
            issues.push({
              path: refsPath,
              code: "invalid-type",
              message: `Baseline references map for binding ${JSON.stringify(bindingId)} at ${refsPath} must be an object.`,
              line: refsProp.value.span.start.line,
            });
          } else {
            const { entries: refEntries, duplicatedKeys: refDupes } =
              collectCstMapEntries(
                refsProp.value,
                refsPath,
                "reference",
                issues,
              );

            const requiredSet =
              definition !== undefined
                ? new Set(definition.references)
                : undefined;
            if (definition !== undefined) {
              for (const reqRefId of definition.references) {
                if (!refEntries.has(reqRefId) && !refDupes.has(reqRefId)) {
                  issues.push({
                    path: mapEntryPath(refsPath, reqRefId),
                    code: "missing-reference-fact",
                    message: `Baseline binding ${JSON.stringify(bindingId)} is missing required reference fact ${JSON.stringify(reqRefId)} (declared in definition.references).`,
                    line: refsProp.value.span.start.line,
                  });
                }
              }
            }

            for (const [refId, refProp] of refEntries) {
              if (refDupes.has(refId) || refId.length === 0) continue;
              const refPath = mapEntryPath(refsPath, refId);
              if (requiredSet !== undefined && !requiredSet.has(refId)) {
                issues.push({
                  path: refPath,
                  code: "unexpected-reference-fact",
                  message: `Baseline binding ${JSON.stringify(bindingId)} contains unexpected reference fact ${JSON.stringify(refId)} (not declared in definition.references).`,
                  line: refProp.keySpan.start.line,
                });
                continue;
              }
              const parsedFact = parseCstReferenceFact(
                refProp.value,
                refId,
                bindingId,
                refPath,
                issues,
                options,
              );
              if (parsedFact !== undefined) {
                parsedRefs[refId] = parsedFact;
              }
            }
          }
        }

        if (definition !== undefined) {
          bindings[bindingId] = { definition, references: parsedRefs };
        }
      }
    }
  }

  if (issues.length > 0) {
    issues.sort(
      (left, right) =>
        (left.line ?? Number.MAX_SAFE_INTEGER) -
        (right.line ?? Number.MAX_SAFE_INTEGER),
    );
    throw new BaselineValidationError(issues);
  }

  return { version: 3, bindings };
}

function collectObjectDataProperties(
  value: unknown,
  basePath: string,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: readonly string[],
  issues: BaselineValidationIssue[],
  label: string,
): Map<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    issues.push({
      path: basePath,
      code: "invalid-type",
      message: `${label} at ${basePath} must be a plain object.`,
    });
    return undefined;
  }
  const ownKeys = Object.keys(value);
  if (Object.getOwnPropertyNames(value).length !== ownKeys.length) {
    issues.push({
      path: basePath,
      code: "invalid-type",
      message: `${label} at ${basePath} cannot contain non-enumerable properties.`,
    });
    return undefined;
  }

  const entries = new Map<string, unknown>();
  const invalidKeys = new Set<string>();
  for (const key of ownKeys) {
    const path = fieldPath(basePath, key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      invalidKeys.add(key);
      issues.push({
        path,
        code: "invalid-type",
        message: `Property ${JSON.stringify(key)} at ${path} cannot be an accessor property.`,
      });
      continue;
    }
    if (!allowedKeys.has(key)) {
      issues.push({
        path,
        code: "unknown-field",
        message: `Unknown field ${JSON.stringify(key)} at ${path}.`,
      });
      continue;
    }
    entries.set(key, descriptor.value);
  }

  for (const reqKey of requiredKeys) {
    if (!entries.has(reqKey) && !invalidKeys.has(reqKey)) {
      issues.push({
        path: fieldPath(basePath, reqKey),
        code: "missing-field",
        message: `Missing required field ${JSON.stringify(reqKey)} at ${basePath}.`,
      });
    }
  }
  return entries;
}

function collectMapDataProperties(
  value: unknown,
  basePath: string,
  entryKind: string,
  issues: BaselineValidationIssue[],
): Map<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    issues.push({
      path: basePath,
      code: "invalid-type",
      message: `Baseline ${entryKind} map at ${basePath} must be a plain object.`,
    });
    return undefined;
  }
  const ownKeys = Object.keys(value);
  if (Object.getOwnPropertyNames(value).length !== ownKeys.length) {
    issues.push({
      path: basePath,
      code: "invalid-type",
      message: `Baseline ${entryKind} map at ${basePath} cannot contain non-enumerable properties.`,
    });
    return undefined;
  }
  const entries = new Map<string, unknown>();
  for (const key of ownKeys) {
    const entryPath = mapEntryPath(basePath, key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      issues.push({
        path: entryPath,
        code: "invalid-type",
        message: `Property ${JSON.stringify(key)} at ${entryPath} cannot be an accessor property.`,
      });
      continue;
    }
    if (key.length === 0) {
      issues.push({
        path: entryPath,
        code: "invalid-id",
        message: `${entryKind} ID at ${basePath} must be a non-empty string.`,
      });
      continue;
    }
    entries.set(key, descriptor.value);
  }
  return entries;
}

function validateInMemoryJsonValue(
  value: unknown,
  path: string,
  context: string,
  issues: BaselineValidationIssue[],
): void {
  try {
    assertJsonValue(value);
  } catch (error) {
    if (error instanceof TypeError) {
      issues.push({
        path,
        code: "invalid-json-value",
        message: `${context} at ${path} must be a valid JSON value: ${error.message}`,
      });
      return;
    }
    throw error;
  }
}

function validateInMemoryMemberCollection(
  value: unknown,
  referenceId: string,
  basePath: string,
  issues: BaselineValidationIssue[],
): void {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(value).length !== value.length ||
    Object.getOwnPropertyNames(value).length !== value.length + 1
  ) {
    issues.push({
      path: basePath,
      code: "invalid-type",
      message: `Member-collection baseline for reference ${JSON.stringify(referenceId)} at ${basePath} must be an array.`,
    });
    return;
  }

  const memberIds = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = `${basePath}[${index}]`;
    const element = Object.getOwnPropertyDescriptor(value, String(index));
    if (element === undefined || !element.enumerable || !("value" in element)) {
      issues.push({
        path: itemPath,
        code: "invalid-type",
        message: `Member-collection baseline for reference ${JSON.stringify(referenceId)} at ${itemPath} must be an array.`,
      });
      continue;
    }
    const fields = collectObjectDataProperties(
      element.value,
      itemPath,
      MEMBER_ITEM_ALLOWED_KEYS,
      MEMBER_ITEM_REQUIRED_KEYS,
      issues,
      `Member-collection baseline record for reference ${JSON.stringify(referenceId)}`,
    );
    if (fields === undefined) continue;
    if (fields.has("id")) {
      const idVal = fields.get("id");
      if (typeof idVal !== "string" || idVal.length === 0) {
        issues.push({
          path: `${itemPath}.id`,
          code: "invalid-id",
          message: `Member ID of reference ${JSON.stringify(referenceId)} at ${itemPath}.id must be a non-empty string.`,
        });
      } else if (memberIds.has(idVal)) {
        issues.push({
          path: `${itemPath}.id`,
          code: "duplicate-id",
          message: `Duplicate member-collection baseline ID ${JSON.stringify(idVal)} for reference ${JSON.stringify(referenceId)} at ${itemPath}.id.`,
        });
      } else {
        memberIds.add(idVal);
      }
    }
    if (fields.has("value")) {
      validateInMemoryJsonValue(
        fields.get("value"),
        `${itemPath}.value`,
        `Member-collection baseline value for reference ${JSON.stringify(referenceId)}`,
        issues,
      );
    }
  }
}

function validateInMemoryBindingDefinition(
  value: unknown,
  bindingId: string,
  basePath: string,
  issues: BaselineValidationIssue[],
): string[] | undefined {
  const fields = collectObjectDataProperties(
    value,
    basePath,
    BINDING_DEFINITION_ALLOWED_KEYS,
    BINDING_DEFINITION_REQUIRED_KEYS,
    issues,
    "Binding definition",
  );
  if (fields === undefined) return undefined;

  if (fields.has("id")) {
    const defId = fields.get("id");
    if (typeof defId !== "string" || defId.length === 0) {
      issues.push({
        path: `${basePath}.id`,
        code: "invalid-id",
        message: `Binding ID at ${basePath}.id must be a non-empty string.`,
      });
    } else if (defId !== bindingId) {
      issues.push({
        path: `${basePath}.id`,
        code: "id-mismatch",
        message: `Baseline binding ${JSON.stringify(bindingId)} has mismatched definition.id ${JSON.stringify(defId)}.`,
      });
    }
  }

  if (fields.has("note")) {
    const note = fields.get("note");
    if (note !== undefined && typeof note !== "string") {
      issues.push({
        path: `${basePath}.note`,
        code: "invalid-type",
        message: `Binding ${JSON.stringify(bindingId)} note at ${basePath}.note must be a string.`,
      });
    }
  }

  if (!fields.has("references")) return undefined;
  const refs = fields.get("references");
  const refsPath = `${basePath}.references`;
  if (
    !Array.isArray(refs) ||
    Object.getPrototypeOf(refs) !== Array.prototype ||
    Object.getOwnPropertySymbols(refs).length !== 0 ||
    Object.keys(refs).length !== refs.length ||
    Object.getOwnPropertyNames(refs).length !== refs.length + 1 ||
    refs.length === 0
  ) {
    issues.push({
      path: refsPath,
      code: "invalid-type",
      message: `Reference list for binding ${JSON.stringify(bindingId)} at ${refsPath} cannot be empty.`,
    });
    return undefined;
  }

  const seen = new Set<string>();
  const collected: string[] = [];
  let refsValid = true;
  for (let index = 0; index < refs.length; index += 1) {
    const itemPath = `${refsPath}[${index}]`;
    const element = Object.getOwnPropertyDescriptor(refs, String(index));
    if (element === undefined || !element.enumerable || !("value" in element)) {
      refsValid = false;
      issues.push({
        path: itemPath,
        code: "invalid-type",
        message: `Reference ID in binding ${JSON.stringify(bindingId)} at ${itemPath} must be a non-empty string.`,
      });
      continue;
    }
    const refId = element.value;
    if (typeof refId !== "string" || refId.length === 0) {
      refsValid = false;
      issues.push({
        path: itemPath,
        code: "invalid-id",
        message: `Reference ID in binding ${JSON.stringify(bindingId)} at ${itemPath} must be a non-empty string.`,
      });
      continue;
    }
    if (seen.has(refId)) {
      refsValid = false;
      issues.push({
        path: itemPath,
        code: "duplicate-id",
        message: `Reference list for binding ${JSON.stringify(bindingId)} contains duplicate ID ${JSON.stringify(refId)} at ${itemPath}.`,
      });
      continue;
    }
    seen.add(refId);
    collected.push(refId);
  }
  return refsValid ? collected : undefined;
}

function validateInMemoryReferenceFact(
  value: unknown,
  referenceId: string,
  bindingId: string,
  basePath: string,
  issues: BaselineValidationIssue[],
): void {
  const fields = collectObjectDataProperties(
    value,
    basePath,
    REFERENCE_FACT_ALLOWED_KEYS,
    REFERENCE_FACT_REQUIRED_KEYS,
    issues,
    `Baseline record for reference ${JSON.stringify(referenceId)}`,
  );
  if (fields === undefined) return;

  if (fields.has("definition")) {
    const defPath = `${basePath}.definition`;
    const defFields = collectObjectDataProperties(
      fields.get("definition"),
      defPath,
      REFERENCE_DEFINITION_ALLOWED_KEYS,
      REFERENCE_DEFINITION_REQUIRED_KEYS,
      issues,
      "Reference definition",
    );
    if (defFields !== undefined) {
      if (defFields.has("id")) {
        const defId = defFields.get("id");
        if (typeof defId !== "string" || defId.length === 0) {
          issues.push({
            path: `${defPath}.id`,
            code: "invalid-id",
            message: `Reference ID at ${defPath}.id must be a non-empty string.`,
          });
        } else if (defId !== referenceId) {
          issues.push({
            path: `${defPath}.id`,
            code: "id-mismatch",
            message: `Baseline reference ${JSON.stringify(referenceId)} in binding ${JSON.stringify(bindingId)} has mismatched definition.id ${JSON.stringify(defId)}.`,
          });
        }
      }
      if (defFields.has("target")) {
        validateInMemoryJsonValue(
          defFields.get("target"),
          `${defPath}.target`,
          `Reference ${JSON.stringify(referenceId)} target`,
          issues,
        );
      }
      if (
        defFields.has("selection") &&
        defFields.get("selection") !== undefined
      ) {
        validateInMemoryJsonValue(
          defFields.get("selection"),
          `${defPath}.selection`,
          `Reference ${JSON.stringify(referenceId)} selection`,
          issues,
        );
      }
      if (defFields.has("note")) {
        const note = defFields.get("note");
        if (note !== undefined && typeof note !== "string") {
          issues.push({
            path: `${defPath}.note`,
            code: "invalid-type",
            message: `Reference ${JSON.stringify(referenceId)} note at ${defPath}.note must be a string.`,
          });
        }
      }
    }
  }

  let valueKind: "member-collection" | undefined;
  let valueKindValid = true;
  if (fields.has("valueKind")) {
    const rawValueKind = fields.get("valueKind");
    if (rawValueKind === "member-collection") {
      valueKind = "member-collection";
    } else if (rawValueKind !== undefined) {
      valueKindValid = false;
      issues.push({
        path: `${basePath}.valueKind`,
        code: "invalid-type",
        message: `Field "valueKind" at ${basePath}.valueKind must be "member-collection".`,
      });
    }
  }

  if (fields.has("value") && valueKindValid) {
    if (valueKind === "member-collection") {
      validateInMemoryMemberCollection(
        fields.get("value"),
        referenceId,
        `${basePath}.value`,
        issues,
      );
    } else {
      validateInMemoryJsonValue(
        fields.get("value"),
        `${basePath}.value`,
        `Baseline record value for reference ${JSON.stringify(referenceId)}`,
        issues,
      );
    }
  }
}

export function assertBaseline(value: Baseline | undefined): void {
  if (value === undefined) return;
  const issues: BaselineValidationIssue[] = [];
  const rootFields = collectObjectDataProperties(
    value,
    "$",
    ROOT_ALLOWED_KEYS,
    ROOT_REQUIRED_KEYS,
    issues,
    "Baseline root",
  );
  if (rootFields === undefined) {
    throw new BaselineValidationError(issues);
  }

  let supportedVersion = false;
  if (rootFields.has("version")) {
    const version = rootFields.get("version");
    if (version === 3) {
      supportedVersion = true;
    } else {
      issues.push({
        path: "$.version",
        code: "invalid-version",
        message: unsupportedVersionMessage(version),
      });
    }
  } else {
    supportedVersion = true;
  }

  if (supportedVersion && rootFields.has("bindings")) {
    const bindingMap = collectMapDataProperties(
      rootFields.get("bindings"),
      "$.bindings",
      "binding",
      issues,
    );
    if (bindingMap !== undefined) {
      for (const [bindingId, bindingValue] of bindingMap) {
        const bindingPath = mapEntryPath("$.bindings", bindingId);
        const bindingFields = collectObjectDataProperties(
          bindingValue,
          bindingPath,
          BINDING_ALLOWED_KEYS,
          BINDING_REQUIRED_KEYS,
          issues,
          `Baseline entry for binding ${JSON.stringify(bindingId)}`,
        );
        if (bindingFields === undefined) continue;

        let declaredRefs: string[] | undefined;
        if (bindingFields.has("definition")) {
          declaredRefs = validateInMemoryBindingDefinition(
            bindingFields.get("definition"),
            bindingId,
            `${bindingPath}.definition`,
            issues,
          );
        }

        if (bindingFields.has("references")) {
          const refsPath = `${bindingPath}.references`;
          const refsMap = collectMapDataProperties(
            bindingFields.get("references"),
            refsPath,
            "reference",
            issues,
          );
          if (refsMap !== undefined) {
            const requiredSet =
              declaredRefs !== undefined ? new Set(declaredRefs) : undefined;
            if (declaredRefs !== undefined) {
              for (const reqRefId of declaredRefs) {
                if (!refsMap.has(reqRefId)) {
                  issues.push({
                    path: mapEntryPath(refsPath, reqRefId),
                    code: "missing-reference-fact",
                    message: `Baseline binding ${JSON.stringify(bindingId)} is missing required reference fact ${JSON.stringify(reqRefId)} (declared in definition.references).`,
                  });
                }
              }
            }
            for (const [refId, factValue] of refsMap) {
              const refPath = mapEntryPath(refsPath, refId);
              if (requiredSet !== undefined && !requiredSet.has(refId)) {
                issues.push({
                  path: refPath,
                  code: "unexpected-reference-fact",
                  message: `Baseline binding ${JSON.stringify(bindingId)} contains unexpected reference fact ${JSON.stringify(refId)} (not declared in definition.references).`,
                });
                continue;
              }
              validateInMemoryReferenceFact(
                factValue,
                refId,
                bindingId,
                refPath,
                issues,
              );
            }
          }
        }
      }
    }
  }

  if (issues.length > 0) {
    throw new BaselineValidationError(issues);
  }
}
