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

function assertMemberCollectionValue(
  value: unknown,
  referenceId: string,
): void {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(value).length !== value.length ||
    Object.getOwnPropertyNames(value).length !== value.length + 1
  ) {
    throw new TypeError(
      `Member-collection baseline for reference ${referenceId} must be an array.`,
    );
  }
  const memberIds = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const element = Object.getOwnPropertyDescriptor(value, String(index));
    if (element === undefined || !element.enumerable || !("value" in element)) {
      throw new TypeError(
        `Member-collection baseline for reference ${referenceId} must be an array.`,
      );
    }
    const member = element.value;
    if (
      !isPlainObject(member) ||
      Object.keys(member).length !== 2 ||
      Object.getOwnPropertyNames(member).length !== 2
    ) {
      throw new TypeError(
        `Invalid member-collection baseline record for reference ${referenceId}.`,
      );
    }
    const idProperty = readOwnDataProperty(member, "id");
    const valueProperty = readOwnDataProperty(member, "value");
    if (!idProperty.present || !valueProperty.present) {
      throw new TypeError(
        `Invalid member-collection baseline record for reference ${referenceId}.`,
      );
    }
    assertId(idProperty.value, `Member ID of reference ${referenceId}`);
    if (memberIds.has(idProperty.value)) {
      throw new TypeError(
        `Duplicate member-collection baseline ID for reference ${referenceId}.`,
      );
    }
    try {
      assertJsonValue(valueProperty.value);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new TypeError(
          `Invalid member-collection baseline value for reference ${referenceId}.`,
          { cause: error },
        );
      }
      throw error;
    }
    memberIds.add(idProperty.value);
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

export function assertBaseline(value: Baseline | undefined): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new TypeError("Invalid baseline format.");
  }
  const bindingsProperty = readOwnDataProperty(value, "bindings");
  if (!bindingsProperty.present || !isRecord(bindingsProperty.value)) {
    throw new TypeError("Invalid baseline format.");
  }
  const versionProperty = readOwnDataProperty(value, "version");
  const version = versionProperty.present ? versionProperty.value : undefined;
  if (version !== 3) {
    throw new TypeError(
      `Unsupported baseline version ${String(version)}; expected version 3. Review current bindings and references, remove or replace the old baseline, rebuild with \`dock baseline update --config <config>\`, and verify with \`dock check --config <config>\`.`,
    );
  }
  for (const [id, binding] of Object.entries(bindingsProperty.value)) {
    if (!isRecord(binding)) {
      throw new TypeError(`Invalid baseline format for binding ${id}.`);
    }
    const definitionProperty = readOwnDataProperty(binding, "definition");
    const referencesProperty = readOwnDataProperty(binding, "references");
    if (!referencesProperty.present || !isRecord(referencesProperty.value)) {
      throw new TypeError(`Invalid baseline format for binding ${id}.`);
    }
    const definition = definitionProperty.present
      ? definitionProperty.value
      : undefined;
    assertBindingDefinition(definition);
    if (definition.id !== id) {
      throw new TypeError(`Baseline ID mismatch for binding ${id}.`);
    }

    const required = new Set(definition.references);
    const actual = Object.keys(referencesProperty.value);
    if (
      actual.length !== required.size ||
      actual.some((referenceId) => !required.has(referenceId))
    ) {
      throw new TypeError(
        `Baseline for binding ${id} is missing required references.`,
      );
    }
    for (const [referenceId, reference] of Object.entries(
      referencesProperty.value,
    )) {
      if (!isRecord(reference)) {
        throw new TypeError(
          `Invalid baseline format for reference ${referenceId}.`,
        );
      }
      const refDefinitionProperty = readOwnDataProperty(
        reference,
        "definition",
      );
      const refDefinition = refDefinitionProperty.present
        ? refDefinitionProperty.value
        : undefined;
      assertReferenceDefinition(refDefinition);
      const refValueProperty = readOwnDataProperty(reference, "value");
      const valueKindProperty = readOwnDataProperty(reference, "valueKind");
      const valueKind = valueKindProperty.present
        ? valueKindProperty.value
        : undefined;
      if (
        refDefinition.id !== referenceId ||
        !refValueProperty.present ||
        (valueKind !== undefined && valueKind !== "member-collection")
      ) {
        throw new TypeError(
          `Invalid baseline record for reference ${referenceId}.`,
        );
      }
      if (valueKind === "member-collection") {
        assertMemberCollectionValue(refValueProperty.value, referenceId);
      } else {
        try {
          assertJsonValue(refValueProperty.value);
        } catch (error) {
          if (error instanceof TypeError) {
            throw new TypeError(
              `Invalid baseline record for reference ${referenceId}.`,
              { cause: error },
            );
          }
          throw error;
        }
      }
    }
  }
}
