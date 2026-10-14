import {
  assertBaseline,
  assertBindingDefinition,
  assertReferenceDefinition,
} from "./contracts.ts";
import type {
  BindingAudit,
  BindingChange,
  BindingDefinition,
  BindingBaseline,
  CheckInput,
  CheckReport,
  CheckWithCoverageInput,
  CheckWithCoverageResult,
  CurrentBinding,
  CurrentReferenceFact,
  EvidenceError,
  JsonValue,
  ReferenceDefinition,
  ReferenceFact,
} from "./contracts.ts";
import { summarizeCoverage } from "./coverage.ts";

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
  definitions: Map<
    string,
    Array<{ definition?: ReferenceDefinition; error?: string }>
  >,
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
  if (completeness !== "complete" && completeness !== "partial")
    throw new TypeError("关联声明完整性必须是 complete 或 partial。");
  const declaredBindingIds = [...declaredBindings.keys()].sort();
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
  const seenScopeIds = new Set<string>();
  for (const bindingId of scope) {
    if (typeof bindingId !== "string" || bindingId.length === 0)
      throw new TypeError("检查范围中的关联 ID 必须是非空文本。");
    if (seenScopeIds.has(bindingId))
      throw new TypeError(`检查范围重复选择关联：${bindingId}`);
    seenScopeIds.add(bindingId);
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

  const results: BindingAudit[] = scope.map((bindingId) => {
    const binding = declaredBindings.get(bindingId);
    const previous = input.baseline?.bindings[bindingId];
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
      return { bindingId: binding.id, changes: [], errors: collected.errors };
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
    reviewedBaseline:
      input.baseline === undefined ? null : structuredClone(input.baseline),
    declaration: { completeness, bindingIds: declaredBindingIds },
    scope,
    bindings: results,
  };
}

/** 只在声明、目录与运行记录完整时，合并核对报告和覆盖统计。 */
export function checkWithCoverage(
  input: CheckWithCoverageInput,
): CheckWithCoverageResult {
  const { coverage, ...checkInput } = input;
  const report = check(checkInput);
  const summary = summarizeCoverage({
    bindings: checkInput.bindings,
    declarationCompleteness: checkInput.declarationCompleteness ?? "partial",
    validationScope: report.scope,
    coverage,
  });

  if ("errors" in summary) return summary;
  return {
    report: { ...report, coverage: summary.coverage },
  };
}
