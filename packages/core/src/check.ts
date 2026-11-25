import {
  assertBaseline,
  assertBindingDefinition,
  copyBindingDefinition,
  copyReferenceDefinition,
} from "./contracts.ts";
import type {
  BindingCheckResult,
  BindingChange,
  BindingDefinition,
  BindingBaseline,
  CheckContext,
  CheckInput,
  CheckReport,
  CollectionMemberChange,
  CurrentBinding,
  CurrentReferenceFact,
  CheckError,
  JsonValue,
  ReferenceDefinition,
  ReferenceResult,
  ReferenceMemberResult,
  TextRange,
} from "./contracts.ts";
import { canonicalJson, copyJsonValue } from "./json-value.ts";

type CollectionSnapshot = {
  definition: ReferenceDefinition;
  members: ReferenceMemberResult[];
  value?: JsonValue;
  valueKind: "member-collection";
  range?: NonNullable<CurrentReferenceFact["range"]>;
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Default scope for complete declarations includes historical bindings to preserve untracking semantics. */
export function resolveCheckScope(input: CheckContext): string[] {
  const completeness = input.declarationCompleteness ?? "partial";
  if (completeness !== "complete" && completeness !== "partial") {
    throw new TypeError(
      "Binding declarationCompleteness must be 'complete' or 'partial'.",
    );
  }
  const declaredBindingIds = input.bindings.map((binding) => binding.id).sort();
  const defaultScope =
    completeness === "complete"
      ? [
          ...new Set([
            ...declaredBindingIds,
            ...Object.keys(input.baseline?.bindings ?? {}),
          ]),
        ].sort()
      : declaredBindingIds;
  const scope = [...(input.scope ?? defaultScope)];
  const seen = new Set<string>();
  for (const bindingId of scope) {
    if (typeof bindingId !== "string" || bindingId.length === 0) {
      throw new TypeError(
        "Binding ID in check scope must be a non-empty string.",
      );
    }
    if (seen.has(bindingId)) {
      throw new TypeError(`Duplicate binding in check scope: ${bindingId}`);
    }
    seen.add(bindingId);
  }
  return scope;
}

function ownEntry<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function isValueMember(
  member: ReferenceMemberResult,
): member is Extract<ReferenceMemberResult, { value: JsonValue }> {
  return "value" in member;
}

function memberValue(members: readonly ReferenceMemberResult[]): JsonValue {
  return [...members]
    .filter(isValueMember)
    .sort((left, right) => compareText(left.id, right.id))
    .map((member) => ({ id: member.id, value: member.value }));
}

function copyRange(range: TextRange | undefined): TextRange | undefined {
  if (range === undefined) return undefined;
  return copyJsonValue(range) as TextRange;
}

function readDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !("value" in descriptor)) {
    throw new TypeError(`Property ${key} cannot be an accessor property.`);
  }
  return descriptor.value;
}

function copyMemberResult(
  member: ReferenceMemberResult,
): ReferenceMemberResult {
  const errorProp = Object.getOwnPropertyDescriptor(member, "error");
  if (errorProp !== undefined) {
    if (!errorProp.enumerable || !("value" in errorProp)) {
      return {
        id: member.id,
        error: {
          code: "invalid-fact",
          message:
            "Member fact must be a valid JSON value with finite numbers.",
        },
      };
    }
    const err = errorProp.value as { code: string; message: string };
    return {
      id: member.id,
      error: { code: err.code, message: err.message },
    };
  }
  const valueProp = Object.getOwnPropertyDescriptor(member, "value");
  if (
    valueProp === undefined ||
    !valueProp.enumerable ||
    !("value" in valueProp)
  ) {
    return {
      id: member.id,
      error: {
        code: "invalid-fact",
        message: "Member fact must be a valid JSON value with finite numbers.",
      },
    };
  }
  try {
    return { id: member.id, value: copyJsonValue(valueProp.value) };
  } catch (error) {
    if (error instanceof TypeError) {
      return {
        id: member.id,
        error: {
          code: "invalid-fact",
          message:
            "Member fact must be a valid JSON value with finite numbers.",
        },
      };
    }
    throw error;
  }
}

function comparableReference(definition: ReferenceDefinition): JsonValue {
  return {
    id: definition.id,
    target: definition.target,
    ...(definition.selection === undefined
      ? {}
      : { selection: definition.selection }),
  };
}

function comparableBinding(definition: BindingDefinition): JsonValue {
  return {
    id: definition.id,
    references: [...definition.references].sort(),
  };
}

function same(left: JsonValue, right: JsonValue): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function collectCurrent(
  binding: BindingDefinition,
  definitions: Map<
    string,
    Array<{ definition?: ReferenceDefinition; error?: string }>
  >,
  facts: Map<string, ReferenceResult[]>,
): {
  current?: CurrentBinding;
  errors: CheckError[];
  collections: Map<string, CollectionSnapshot>;
} {
  const references: Record<string, CurrentReferenceFact> = Object.create(
    null,
  ) as Record<string, CurrentReferenceFact>;
  const errors: CheckError[] = [];
  const collections = new Map<string, CollectionSnapshot>();
  const ids = [...binding.references].sort();

  for (const referenceId of ids) {
    const candidates = definitions.get(referenceId) ?? [];
    if (candidates.length !== 1) {
      errors.push({
        referenceId,
        code:
          candidates.length === 0
            ? "undeclared-reference"
            : "ambiguous-reference-definition",
        message:
          candidates.length === 0
            ? "Binding references an undeclared reference definition."
            : "Reference has multiple definitions; target cannot be determined.",
      });
      continue;
    }
    const candidate = candidates[0]!;
    if (!candidate.definition) {
      errors.push({
        referenceId,
        code: "invalid-reference-definition",
        message: candidate.error ?? "Invalid reference definition.",
      });
      continue;
    }
    const definition = candidate.definition;
    const matches = facts.get(referenceId) ?? [];
    if (matches.length !== 1) {
      errors.push({
        referenceId,
        code: matches.length === 0 ? "missing-evidence" : "ambiguous-evidence",
        message:
          matches.length === 0
            ? "Current fact for this reference was not collected."
            : "Multiple current facts were collected for this reference.",
      });
      continue;
    }

    const fact = matches[0]!;
    let copiedRange: TextRange | undefined;
    try {
      copiedRange = copyRange(
        readDataProperty(fact, "range") as TextRange | undefined,
      );
    } catch (error) {
      if (error instanceof TypeError) {
        errors.push({
          referenceId,
          code: "invalid-fact",
          message:
            "Reference fact must be a valid JSON value with finite numbers.",
        });
        continue;
      }
      throw error;
    }
    const errorDescriptor = Object.getOwnPropertyDescriptor(fact, "error");
    if (errorDescriptor !== undefined) {
      const errorValue =
        errorDescriptor.enumerable && "value" in errorDescriptor
          ? (errorDescriptor.value as { code: string; message: string })
          : undefined;
      if (errorValue === undefined) {
        errors.push({
          referenceId,
          code: "invalid-fact",
          message:
            "Reference fact must be a valid JSON value with finite numbers.",
        });
        continue;
      }
      errors.push({
        referenceId,
        code: errorValue.code,
        message: errorValue.message,
        ...(copiedRange === undefined ? {} : { range: copiedRange }),
      });
      continue;
    }

    if ("collection" in fact) {
      if (
        !fact.collection ||
        !Array.isArray(fact.collection.members) ||
        (fact.collection.completeness !== "complete" &&
          fact.collection.completeness !== "partial")
      ) {
        throw new TypeError(
          "Reference member collection must provide valid completeness and members array.",
        );
      }

      const memberIds = new Set<string>();
      let invalidIdentity = false;
      for (const member of fact.collection.members) {
        const idDescriptor =
          member && typeof member === "object"
            ? Object.getOwnPropertyDescriptor(member, "id")
            : undefined;
        const memberId =
          idDescriptor && idDescriptor.enumerable && "value" in idDescriptor
            ? idDescriptor.value
            : undefined;
        if (typeof memberId !== "string" || memberId.length === 0) {
          errors.push({
            referenceId,
            code: "invalid-member-id",
            message: "Member ID must be a non-empty string.",
          });
          invalidIdentity = true;
          continue;
        }
        if (memberIds.has(memberId)) {
          errors.push({
            referenceId,
            memberId,
            code: "ambiguous-member",
            message:
              "Member collection contains duplicate member IDs; member changes cannot be compared.",
          });
          invalidIdentity = true;
          continue;
        }
        memberIds.add(memberId);
      }
      if (invalidIdentity) continue;

      const members: ReferenceMemberResult[] =
        fact.collection.members.map(copyMemberResult);
      if (fact.collection.completeness === "partial") {
        errors.push({
          referenceId,
          code: "incomplete-member-discovery",
          message:
            "Member discovery is partial; member additions or removals cannot be inferred.",
        });
      }
      for (const member of members) {
        if ("error" in member) {
          errors.push({
            referenceId,
            memberId: member.id,
            code: member.error.code,
            message: member.error.message,
          });
        }
      }

      if (fact.collection.completeness === "complete") {
        const snapshot: CollectionSnapshot = {
          definition,
          members,
          valueKind: "member-collection",
          ...(members.every(isValueMember)
            ? { value: memberValue(members) }
            : {}),
          ...(copiedRange === undefined ? {} : { range: copiedRange }),
        };
        collections.set(referenceId, snapshot);
      }

      if (
        fact.collection.completeness !== "complete" ||
        members.some((member) => "error" in member)
      ) {
        continue;
      }
      const snapshot = collections.get(referenceId)!;
      references[referenceId] = {
        definition: snapshot.definition,
        value: snapshot.value!,
        valueKind: snapshot.valueKind,
        ...(snapshot.range === undefined ? {} : { range: snapshot.range }),
      };
      continue;
    }

    let copiedValue: JsonValue;
    try {
      copiedValue = copyJsonValue(readDataProperty(fact, "value"));
    } catch (error) {
      if (error instanceof TypeError) {
        errors.push({
          referenceId,
          code: "invalid-fact",
          message:
            "Reference fact must be a valid JSON value with finite numbers.",
        });
        continue;
      }
      throw error;
    }
    references[referenceId] = {
      definition,
      value: copiedValue,
      ...(copiedRange === undefined ? {} : { range: copiedRange }),
    };
  }

  if (errors.length) return { errors, collections };
  return {
    current: { definition: copyBindingDefinition(binding), references },
    errors,
    collections,
  };
}

function collectionChangesFor(
  collections: Map<string, CollectionSnapshot>,
  previous: BindingBaseline | undefined,
): BindingChange[] {
  if (!previous) return [];
  const changes: BindingChange[] = [];
  for (const referenceId of [...collections.keys()].sort()) {
    const before = ownEntry(previous.references, referenceId);
    const after = collections.get(referenceId)!;
    if (!before) continue;
    const beforeMembers =
      before.valueKind === "member-collection"
        ? (before.value as { id: string; value: JsonValue }[])
        : [];
    const memberChanges = collectionMemberChangesFor(
      beforeMembers,
      after.members,
    );
    if (
      memberChanges.length === 0 &&
      before.valueKind === "member-collection"
    ) {
      continue;
    }
    changes.push({
      kind: "fact",
      referenceId,
      memberChanges,
      ...(before.valueKind === undefined
        ? {}
        : { beforeKind: before.valueKind }),
      afterKind: after.valueKind,
    });
  }
  return changes;
}

function collectionMemberChangesFor(
  beforeMembers: readonly { id: string; value: JsonValue }[],
  afterMembers: readonly ReferenceMemberResult[],
): CollectionMemberChange[] {
  const before = new Map(
    beforeMembers.map((member) => [member.id, member.value]),
  );
  const afterIds = new Set(afterMembers.map((member) => member.id));
  const after = new Map(
    afterMembers
      .filter(isValueMember)
      .map((member) => [member.id, member.value]),
  );
  const memberIds = [...new Set([...before.keys(), ...afterIds])].sort(
    compareText,
  );
  const changes: CollectionMemberChange[] = [];
  for (const memberId of memberIds) {
    const beforePresent = before.has(memberId);
    const afterPresent = afterIds.has(memberId);
    const beforeValue = before.get(memberId);
    const afterValue = after.get(memberId);
    if (beforePresent === afterPresent) {
      if (
        !beforePresent ||
        afterValue === undefined ||
        same(beforeValue!, afterValue)
      ) {
        continue;
      }
    }
    changes.push({
      memberId,
      beforePresent,
      afterPresent,
      ...(beforeValue === undefined
        ? {}
        : { before: copyJsonValue(beforeValue) }),
      ...(afterValue === undefined ? {} : { after: afterValue }),
    });
  }
  return changes;
}

function changesFor(
  current: CurrentBinding,
  previous: BindingBaseline | undefined,
): BindingChange[] {
  if (!previous) return [{ kind: "binding-added" }];

  const changes: BindingChange[] = [];
  if (
    !same(
      comparableBinding(previous.definition),
      comparableBinding(current.definition),
    )
  ) {
    changes.push({
      kind: "binding-definition",
      before: copyBindingDefinition(previous.definition),
      after: current.definition,
    });
  }

  const ids = [
    ...new Set([
      ...Object.keys(previous.references),
      ...Object.keys(current.references),
    ]),
  ].sort();
  for (const referenceId of ids) {
    const before = ownEntry(previous.references, referenceId);
    const after = current.references[referenceId];
    if (!before) {
      changes.push({ kind: "reference-added", referenceId });
      continue;
    }
    if (!after) {
      changes.push({ kind: "reference-removed", referenceId });
      continue;
    }
    if (
      !same(
        comparableReference(before.definition),
        comparableReference(after.definition),
      )
    ) {
      changes.push({
        kind: "reference-definition",
        referenceId,
        before: copyReferenceDefinition(before.definition),
        after: after.definition,
      });
    }
    if (
      before.valueKind === "member-collection" &&
      after.valueKind === "member-collection"
    ) {
      const memberChanges = collectionMemberChangesFor(
        before.value as { id: string; value: JsonValue }[],
        after.value as { id: string; value: JsonValue }[],
      );
      if (memberChanges.length > 0) {
        changes.push({
          kind: "fact",
          referenceId,
          memberChanges,
          beforeKind: "member-collection",
          afterKind: "member-collection",
        });
      }
      continue;
    }
    if (
      before.valueKind !== after.valueKind ||
      !same(before.value, after.value)
    ) {
      changes.push({
        kind: "fact",
        referenceId,
        before: copyJsonValue(before.value),
        after: after.value,
        ...(before.valueKind === undefined
          ? {}
          : { beforeKind: before.valueKind }),
        ...(after.valueKind === undefined
          ? {}
          : { afterKind: after.valueKind }),
      });
    }
  }

  return changes;
}

/** Compares complete current evidence against the baseline without mutating the baseline. */
export function check(input: CheckInput): CheckReport {
  assertBaseline(input.baseline);

  const definitions = new Map<
    string,
    Array<{ definition?: ReferenceDefinition; error?: string }>
  >();
  for (const definition of input.references) {
    const idDescriptor =
      definition && typeof definition === "object"
        ? Object.getOwnPropertyDescriptor(definition, "id")
        : undefined;
    const definitionId =
      idDescriptor && idDescriptor.enumerable && "value" in idDescriptor
        ? idDescriptor.value
        : undefined;
    if (typeof definitionId !== "string" || definitionId.length === 0) {
      throw new TypeError("Reference ID must be a non-empty string.");
    }
    const candidates = definitions.get(definitionId) ?? [];
    try {
      candidates.push({ definition: copyReferenceDefinition(definition) });
    } catch (error) {
      candidates.push({
        error: error instanceof Error ? error.message : String(error),
      });
    }
    definitions.set(definitionId, candidates);
  }

  const declaredBindings = new Map<string, BindingDefinition>();
  for (const binding of input.bindings) {
    const idDescriptor =
      binding && typeof binding === "object"
        ? Object.getOwnPropertyDescriptor(binding, "id")
        : undefined;
    const bindingId =
      idDescriptor && idDescriptor.enumerable && "value" in idDescriptor
        ? idDescriptor.value
        : undefined;
    if (typeof bindingId !== "string" || bindingId.length === 0) {
      throw new TypeError("Binding ID must be a non-empty string.");
    }
    if (declaredBindings.has(bindingId)) {
      throw new TypeError(`Duplicate binding ID: ${bindingId}`);
    }
    declaredBindings.set(bindingId, binding);
  }

  const completeness = input.declarationCompleteness ?? "partial";
  const declaredBindingIds = [...declaredBindings.keys()].sort();
  const scope = resolveCheckScope(input);

  const facts = new Map<string, ReferenceResult[]>();
  for (const fact of input.facts) {
    if (typeof fact.referenceId !== "string" || fact.referenceId.length === 0) {
      throw new TypeError("Fact referenceId must be a non-empty string.");
    }
    const matches = facts.get(fact.referenceId) ?? [];
    matches.push(fact);
    facts.set(fact.referenceId, matches);
  }

  const results: BindingCheckResult[] = scope.map((bindingId) => {
    const binding = declaredBindings.get(bindingId);
    const previous = input.baseline
      ? ownEntry(input.baseline.bindings, bindingId)
      : undefined;
    if (!binding) {
      if (completeness === "complete" && previous) {
        return {
          bindingId,
          consistency: "inconsistent",
          changes: [
            {
              kind: "binding-removed",
              before: copyBindingDefinition(previous.definition),
            },
          ],
          untracked: true,
        };
      }
      return {
        bindingId,
        changes: [],
        errors: [
          {
            code: previous ? "incomplete-declaration" : "not-declared",
            message: previous
              ? "Partial declaration cannot prove that the binding was untracked."
              : "Binding in check scope is not present in the current declaration.",
          },
        ],
      };
    }

    try {
      assertBindingDefinition(binding);
    } catch (error) {
      return {
        bindingId,
        changes: [],
        errors: [
          {
            code: "invalid-binding-definition",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }

    const collected = collectCurrent(binding, definitions, facts);
    if (!collected.current) {
      return {
        bindingId: binding.id,
        changes: collectionChangesFor(collected.collections, previous),
        errors: collected.errors,
      };
    }

    const changes = changesFor(collected.current, previous);
    return {
      bindingId: binding.id,
      consistency: changes.length === 0 ? "consistent" : "inconsistent",
      changes,
      current: collected.current,
    };
  });

  return {
    declaration: { completeness, bindingIds: declaredBindingIds },
    scope,
    bindings: results,
  };
}
