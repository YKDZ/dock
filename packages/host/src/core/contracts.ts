import { isJsonValue, type JsonValue } from "./json-value.ts";

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
  version: 2;
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

export type BaselineUpdateIssue = CheckError & { bindingId?: string };
export type BaselineUpdateOutcome =
  | { status: "updated"; baseline: Baseline; report: CheckReport }
  | { status: "rejected"; errors: BaselineUpdateIssue[]; report: CheckReport };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertMemberCollectionValue(
  value: unknown,
  referenceId: string,
): void {
  if (!Array.isArray(value)) {
    throw new TypeError(
      `Member-collection baseline for reference ${referenceId} must be an array.`,
    );
  }
  const memberIds = new Set<string>();
  for (const member of value) {
    if (
      !isRecord(member) ||
      Object.keys(member).length !== 2 ||
      !Object.hasOwn(member, "id") ||
      !Object.hasOwn(member, "value")
    ) {
      throw new TypeError(
        `Invalid member-collection baseline record for reference ${referenceId}.`,
      );
    }
    assertId(member.id, `Member ID of reference ${referenceId}`);
    if (memberIds.has(member.id)) {
      throw new TypeError(
        `Duplicate member-collection baseline ID for reference ${referenceId}.`,
      );
    }
    if (!isJsonValue(member.value)) {
      throw new TypeError(
        `Invalid member-collection baseline value for reference ${referenceId}.`,
      );
    }
    memberIds.add(member.id);
  }
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
  for (const id of ids) {
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
  assertId(value.id, "Binding ID");
  assertReferenceIds(value.references, value.id);
  if (value.note !== undefined && typeof value.note !== "string") {
    throw new TypeError(`Binding ${value.id} note must be a string.`);
  }
}

export function assertReferenceDefinition(
  value: unknown,
): asserts value is ReferenceDefinition {
  if (!isRecord(value)) {
    throw new TypeError("Reference definition must be an object.");
  }
  assertId(value.id, "Reference ID");
  if (!Object.hasOwn(value, "target")) {
    throw new TypeError(`Reference ${value.id} is missing target.`);
  }
  if (!isJsonValue(value.target)) {
    throw new TypeError(
      `Reference ${value.id} target must be a valid JSON value.`,
    );
  }
  if (value.selection !== undefined && !isJsonValue(value.selection)) {
    throw new TypeError(
      `Reference ${value.id} selection must be a valid JSON value.`,
    );
  }
  if (value.note !== undefined && typeof value.note !== "string") {
    throw new TypeError(`Reference ${value.id} note must be a string.`);
  }
}

export function assertBaseline(value: Baseline | undefined): void {
  if (value === undefined) return;
  if (!isRecord(value) || !isRecord(value.bindings)) {
    throw new TypeError("Invalid baseline format.");
  }
  if (value.version !== 2) {
    throw new TypeError(
      `Unsupported baseline version ${String(value.version)}; expected version 2.`,
    );
  }
  for (const [id, binding] of Object.entries(value.bindings)) {
    if (!isRecord(binding) || !isRecord(binding.references)) {
      throw new TypeError(`Invalid baseline format for binding ${id}.`);
    }
    assertBindingDefinition(binding.definition);
    if (binding.definition.id !== id) {
      throw new TypeError(`Baseline ID mismatch for binding ${id}.`);
    }

    const required = new Set(binding.definition.references);
    const actual = Object.keys(binding.references);
    if (
      actual.length !== required.size ||
      actual.some((referenceId) => !required.has(referenceId))
    ) {
      throw new TypeError(
        `Baseline for binding ${id} is missing required references.`,
      );
    }
    for (const [referenceId, reference] of Object.entries(binding.references)) {
      if (!isRecord(reference)) {
        throw new TypeError(
          `Invalid baseline format for reference ${referenceId}.`,
        );
      }
      assertReferenceDefinition(reference.definition);
      if (
        reference.definition.id !== referenceId ||
        !Object.hasOwn(reference, "value") ||
        !isJsonValue(reference.value) ||
        (reference.valueKind !== undefined &&
          reference.valueKind !== "member-collection")
      ) {
        throw new TypeError(
          `Invalid baseline record for reference ${referenceId}.`,
        );
      }
      if (reference.valueKind === "member-collection") {
        assertMemberCollectionValue(reference.value, referenceId);
      }
    }
  }
}
