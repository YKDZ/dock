import { check } from "./check.ts";
import {
  copyBaselineReferenceFact,
  copyBindingBaseline,
  copyBindingDefinition,
  type BaselineReferenceFact,
  type BaselineUpdateIssue,
  type BaselineUpdateOutcome,
  type BindingBaseline,
  type CheckInput,
} from "./contracts.ts";

/** Atomically updates selected bindings with current valid facts without requiring a prior check or zero diffs. */
export function updateBaseline(input: CheckInput): BaselineUpdateOutcome {
  const report = check(input);
  const errors: BaselineUpdateIssue[] = [];
  if (report.scope.length === 0) {
    errors.push({
      code: "empty-selection",
      message: "At least one binding must be selected to update the baseline.",
    });
  }
  const hasBindingErrors = report.bindings.some(
    (binding) => "errors" in binding,
  );
  if (errors.length > 0 || hasBindingErrors) {
    return { status: "rejected", errors, report };
  }

  const touchedBindings = new Set(
    report.bindings.map((binding) => binding.bindingId),
  );
  const nextBindings: Record<string, BindingBaseline> = Object.create(
    null,
  ) as Record<string, BindingBaseline>;
  if (input.baseline !== undefined) {
    for (const [bindingId, baselineBinding] of Object.entries(
      input.baseline.bindings,
    )) {
      if (!touchedBindings.has(bindingId)) {
        nextBindings[bindingId] = copyBindingBaseline(baselineBinding);
      }
    }
  }
  for (const binding of report.bindings) {
    if ("untracked" in binding) {
      continue;
    }
    if (!("current" in binding)) continue;
    const references: Record<string, BaselineReferenceFact> = Object.create(
      null,
    ) as Record<string, BaselineReferenceFact>;
    for (const [referenceId, fact] of Object.entries(
      binding.current.references,
    )) {
      references[referenceId] = copyBaselineReferenceFact(fact);
    }
    nextBindings[binding.bindingId] = {
      definition: copyBindingDefinition(binding.current.definition),
      references,
    };
  }

  return {
    status: "updated",
    baseline: { version: 3, bindings: nextBindings },
    report,
  };
}
