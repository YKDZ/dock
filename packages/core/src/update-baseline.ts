import { check } from "./check.ts";
import type {
  BaselineReferenceFact,
  BaselineUpdateIssue,
  BaselineUpdateOutcome,
  BindingBaseline,
  CheckInput,
} from "./contracts.ts";

/** 以当前有效事实原子更新所选关联，不要求此前检查或无差异。 */
export function updateBaseline(input: CheckInput): BaselineUpdateOutcome {
  const report = check(input);
  const errors: BaselineUpdateIssue[] = report.bindings.flatMap((binding) =>
    "errors" in binding
      ? binding.errors.map((error) => ({
          bindingId: binding.bindingId,
          ...error,
        }))
      : [],
  );
  if (report.scope.length === 0) {
    errors.push({
      code: "empty-selection",
      message: "更新基线必须选择至少一条关联。",
    });
  }
  if (errors.length > 0) return { status: "rejected", errors, report };

  const nextBindings: Record<string, BindingBaseline> = Object.assign(
    Object.create(null) as Record<string, BindingBaseline>,
    structuredClone(input.baseline?.bindings ?? {}),
  );
  for (const binding of report.bindings) {
    if ("untracked" in binding) {
      delete nextBindings[binding.bindingId];
      continue;
    }
    if (!("current" in binding)) continue;
    const references: Record<string, BaselineReferenceFact> = Object.create(
      null,
    ) as Record<string, BaselineReferenceFact>;
    for (const [referenceId, fact] of Object.entries(
      binding.current.references,
    )) {
      references[referenceId] = {
        definition: structuredClone(fact.definition),
        value: structuredClone(fact.value),
        ...(fact.valueKind === undefined ? {} : { valueKind: fact.valueKind }),
      };
    }
    nextBindings[binding.bindingId] = {
      definition: structuredClone(binding.current.definition),
      references,
    };
  }

  return {
    status: "updated",
    baseline: { version: 2, bindings: nextBindings },
    report,
  };
}
