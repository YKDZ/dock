import {
  assertBaseline,
  assertBindingDefinition,
  assertReferenceDefinition,
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
} from "./contracts.ts";
import { canonicalJson, copyJsonValue, isJsonValue } from "./json-value.ts";

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

/** 完整声明的默认范围包含历史关联，以保留取消跟踪的语义。 */
export function resolveCheckScope(input: CheckContext): string[] {
  const completeness = input.declarationCompleteness ?? "partial";
  if (completeness !== "complete" && completeness !== "partial")
    throw new TypeError("关联声明完整性必须是 complete 或 partial。");
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
    if (typeof bindingId !== "string" || bindingId.length === 0)
      throw new TypeError("检查范围中的关联 ID 必须是非空文本。");
    if (seen.has(bindingId))
      throw new TypeError(`检查范围重复选择关联：${bindingId}`);
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
    .map((member) => ({ id: member.id, value: copyJsonValue(member.value) }));
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
            ? "关联引用了未声明的引用定义。"
            : "同一引用有多份定义，无法确定目标。",
      });
      continue;
    }
    const candidate = candidates[0]!;
    if (!candidate.definition) {
      errors.push({
        referenceId,
        code: "invalid-reference-definition",
        message: candidate.error ?? "引用定义无效。",
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
            ? "未取得该引用的当前事实。"
            : "同一引用取得了多份当前事实。",
      });
      continue;
    }

    const fact = matches[0]!;
    if ("error" in fact) {
      errors.push({
        referenceId,
        code: fact.error.code,
        message: fact.error.message,
        ...(fact.range === undefined
          ? {}
          : { range: structuredClone(fact.range) }),
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
        throw new TypeError("引用成员集合必须包含有效完整度和成员数组。");
      }

      const memberIds = new Set<string>();
      let invalidIdentity = false;
      for (const member of fact.collection.members) {
        if (
          !member ||
          typeof member.id !== "string" ||
          member.id.length === 0
        ) {
          errors.push({
            referenceId,
            code: "invalid-member-id",
            message: "成员身份必须是非空文本。",
          });
          invalidIdentity = true;
          continue;
        }
        if (memberIds.has(member.id)) {
          errors.push({
            referenceId,
            memberId: member.id,
            code: "ambiguous-member",
            message: "成员集合包含重复身份，无法比较其成员变化。",
          });
          invalidIdentity = true;
          continue;
        }
        memberIds.add(member.id);
      }
      if (invalidIdentity) continue;

      const members: ReferenceMemberResult[] = fact.collection.members.map(
        (member) =>
          !("error" in member) && !isJsonValue(member.value)
            ? {
                id: member.id,
                error: {
                  code: "invalid-fact",
                  message: "成员事实必须是有效 JSON 值，数值必须有限。",
                },
              }
            : member,
      );
      if (fact.collection.completeness === "partial") {
        errors.push({
          referenceId,
          code: "incomplete-member-discovery",
          message: "成员发现不完整，不能据此推断成员增删。",
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
          definition: structuredClone(definition),
          members: structuredClone(members),
          valueKind: "member-collection",
          ...(members.every(isValueMember)
            ? { value: memberValue(members) }
            : {}),
          ...(fact.range === undefined
            ? {}
            : { range: structuredClone(fact.range) }),
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

    if (!isJsonValue(fact.value)) {
      errors.push({
        referenceId,
        code: "invalid-fact",
        message: "引用事实必须是有效 JSON 值，数值必须有限。",
      });
      continue;
    }
    references[referenceId] = {
      definition: structuredClone(definition),
      value: structuredClone(fact.value),
      ...(fact.range === undefined
        ? {}
        : { range: structuredClone(fact.range) }),
    };
  }

  if (errors.length) return { errors, collections };
  return {
    current: { definition: structuredClone(binding), references },
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
        : { before: structuredClone(beforeValue) }),
      ...(afterValue === undefined
        ? {}
        : { after: structuredClone(afterValue) }),
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
      before: previous.definition,
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
        before: before.definition,
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
        before: before.value,
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

/** 将当前完整证据与基线比较，不修改已有基线。 */
export function check(input: CheckInput): CheckReport {
  assertBaseline(input.baseline);

  const definitions = new Map<
    string,
    Array<{ definition?: ReferenceDefinition; error?: string }>
  >();
  for (const definition of input.references) {
    if (
      !definition ||
      typeof definition.id !== "string" ||
      definition.id.length === 0
    ) {
      throw new TypeError("引用 ID 必须是非空文本。");
    }
    const candidates = definitions.get(definition.id) ?? [];
    try {
      assertReferenceDefinition(definition);
      candidates.push({ definition });
    } catch (error) {
      candidates.push({
        error: error instanceof Error ? error.message : String(error),
      });
    }
    definitions.set(definition.id, candidates);
  }

  const declaredBindings = new Map<string, BindingDefinition>();
  for (const binding of input.bindings) {
    if (!binding || typeof binding.id !== "string" || binding.id.length === 0) {
      throw new TypeError("关联 ID 必须是非空文本。");
    }
    if (declaredBindings.has(binding.id))
      throw new TypeError(`关联 ID 重复：${binding.id}`);
    declaredBindings.set(binding.id, binding);
  }

  const completeness = input.declarationCompleteness ?? "partial";
  const declaredBindingIds = [...declaredBindings.keys()].sort();
  const scope = resolveCheckScope(input);

  const facts = new Map<string, ReferenceResult[]>();
  for (const fact of input.facts) {
    if (typeof fact.referenceId !== "string" || fact.referenceId.length === 0) {
      throw new TypeError("事实引用 ID 必须是非空文本。");
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
          changes: [{ kind: "binding-removed", before: previous.definition }],
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
              ? "局部声明不能证明该关联已取消跟踪。"
              : "检查范围中的关联没有出现在本次声明中。",
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
