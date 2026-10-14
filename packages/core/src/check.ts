import {
  assertBaseline,
  assertBindingDefinition,
  assertReferenceDefinition,
} from "./contracts.ts";
import type {
  Baseline,
  BindingAudit,
  BindingChange,
  BindingDefinition,
  BindingBaseline,
  CheckInput,
  CheckReport,
  CurrentBinding,
  CurrentReferenceFact,
  EvidenceError,
  JsonValue,
  ReferenceDefinition,
  ReferenceFact,
} from "./contracts.ts";

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
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
    documents: [...definition.documents].sort(),
    references: [...definition.references].sort(),
  };
}

function same(left: JsonValue, right: JsonValue): boolean {
  return canonical(left) === canonical(right);
}

function collectCurrent(
  binding: BindingDefinition,
  definitions: Map<string, ReferenceDefinition>,
  facts: Map<string, ReferenceFact[]>,
): { current?: CurrentBinding; errors: EvidenceError[] } {
  const references: Record<string, CurrentReferenceFact> = Object.create(
    null,
  ) as Record<string, CurrentReferenceFact>;
  const errors: EvidenceError[] = [];
  const ids = [
    ...new Set([...binding.documents, ...binding.references]),
  ].sort();

  for (const referenceId of ids) {
    const definition = definitions.get(referenceId)!;
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

  if (errors.length) return { errors };
  return {
    current: { definition: structuredClone(binding), references },
    errors,
  };
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
    const before = previous.references[referenceId];
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
    if (!same(before.value, after.value)) {
      changes.push({
        kind: "fact",
        referenceId,
        before: before.value,
        after: after.value,
      });
    }
  }

  return changes;
}

/** 将当前完整证据与审阅基线比较，不修改已有基线。 */
export function check(input: CheckInput): CheckReport {
  assertBaseline(input.baseline);

  const definitions = new Map<string, ReferenceDefinition>();
  for (const definition of input.references) {
    assertReferenceDefinition(definition);
    if (definitions.has(definition.id))
      throw new TypeError(`引用 ID 重复：${definition.id}`);
    definitions.set(definition.id, definition);
  }

  const bindingIds = new Set<string>();
  for (const binding of input.bindings) {
    assertBindingDefinition(binding);
    if (bindingIds.has(binding.id))
      throw new TypeError(`关联 ID 重复：${binding.id}`);
    bindingIds.add(binding.id);
    for (const referenceId of [...binding.documents, ...binding.references]) {
      if (!definitions.has(referenceId))
        throw new TypeError(
          `关联 ${binding.id} 引用了未声明的引用：${referenceId}`,
        );
    }
  }

  const facts = new Map<string, ReferenceFact[]>();
  for (const fact of input.facts) {
    if (typeof fact.referenceId !== "string" || fact.referenceId.length === 0) {
      throw new TypeError("事实引用 ID 必须是非空文本。");
    }
    const matches = facts.get(fact.referenceId) ?? [];
    matches.push(fact);
    facts.set(fact.referenceId, matches);
  }

  const results: BindingAudit[] = input.bindings.map((binding) => {
    const collected = collectCurrent(binding, definitions, facts);
    if (!collected.current) {
      return { bindingId: binding.id, changes: [], errors: collected.errors };
    }

    const previous: Baseline["bindings"][string] | undefined =
      input.baseline?.bindings[binding.id];
    const changes = changesFor(collected.current, previous);
    return {
      bindingId: binding.id,
      consistency: changes.length === 0 ? "consistent" : "inconsistent",
      changes,
      current: collected.current,
    };
  });

  return { bindings: results };
}
