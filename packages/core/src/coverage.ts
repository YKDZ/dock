import { assertBindingDefinition } from "./contracts.ts";
import type {
  BindingDefinition,
  CoverageInput,
  CoverageInterval,
  CoverageIssue,
  CoverageMeasure,
  CoverageRangeSet,
  CoverageSummaryInput,
  CoverageSummaryResult,
  DocumentRange,
} from "./contracts.ts";

function issue(
  code: string,
  message: string,
  details: Partial<CoverageIssue> = {},
): CoverageIssue {
  return { code, message, ...details };
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function mergeIntervals(
  ranges: readonly CoverageInterval[],
): CoverageInterval[] {
  const sorted = ranges
    .filter((range) => range.start < range.end)
    .toSorted(
      (left, right) => left.start - right.start || left.end - right.end,
    );
  const merged: CoverageInterval[] = [];

  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
    } else if (range.end > previous.end) {
      previous.end = range.end;
    }
  }

  return merged;
}

function complement(
  length: number,
  covered: readonly CoverageInterval[],
): CoverageInterval[] {
  const ranges: CoverageInterval[] = [];
  let start = 0;
  for (const range of covered) {
    if (start < range.start) ranges.push({ start, end: range.start });
    start = range.end;
  }
  if (start < length) ranges.push({ start, end: length });
  return ranges;
}

function measure(
  documents: readonly { path: string; length: number }[],
  ranges: ReadonlyMap<string, readonly CoverageInterval[]>,
  totalUnits: number,
): CoverageMeasure {
  const coveredRanges: CoverageRangeSet[] = [];
  const uncoveredRanges: CoverageRangeSet[] = [];
  let coveredUnits = 0;

  for (const document of documents) {
    const merged = mergeIntervals(ranges.get(document.path) ?? []);
    const covered = merged.reduce(
      (sum, range) => sum + range.end - range.start,
      0,
    );
    coveredUnits += covered;
    if (merged.length)
      coveredRanges.push({ path: document.path, ranges: merged });
    const missing = complement(document.length, merged);
    if (missing.length)
      uncoveredRanges.push({ path: document.path, ranges: missing });
  }

  return {
    coveredUnits,
    totalUnits,
    percentage: (coveredUnits / totalUnits) * 100,
    coveredRanges,
    uncoveredRanges,
  };
}

function addRange(
  ranges: Map<string, CoverageInterval[]>,
  range: DocumentRange,
): void {
  const intervals = ranges.get(range.path) ?? [];
  intervals.push({ start: range.start, end: range.end });
  ranges.set(range.path, intervals);
}

function validateRange(
  range: DocumentRange,
  lengths: ReadonlyMap<string, number>,
  code: string,
  details: Partial<CoverageIssue>,
  errors: CoverageIssue[],
): boolean {
  if (!range || !validText(range.path)) {
    errors.push(issue(code, "覆盖范围缺少文档路径。", details));
    return false;
  }

  const length = lengths.get(range.path);
  if (length === undefined) {
    errors.push(
      issue(
        "range-outside-inventory",
        `文档 ${range.path} 不在统计文档集合内。`,
        {
          ...details,
          path: range.path,
        },
      ),
    );
    return false;
  }

  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start ||
    range.end > length
  ) {
    errors.push(
      issue(code, `文档 ${range.path} 的覆盖范围超出 UTF-16 长度 ${length}。`, {
        ...details,
        path: range.path,
      }),
    );
    return false;
  }

  return true;
}

function invalidCollection(
  input: CoverageInput,
  bindings: readonly BindingDefinition[],
  declarationCompleteness: "complete" | "partial",
): CoverageIssue[] {
  const errors: CoverageIssue[] = [...(input.collectionErrors ?? [])];
  if (declarationCompleteness !== "complete") {
    errors.push(
      issue("partial-declarations", "局部关联声明不能形成完整文档覆盖统计。"),
    );
  }
  if (!input.documentInventory.complete) {
    errors.push(
      issue(
        "incomplete-document-inventory",
        "文档集合采集未完成，不能确定覆盖分母。",
      ),
    );
  }
  if (!input.recordsComplete) {
    errors.push(
      issue(
        "incomplete-records",
        "读取或关联执行记录采集未完成，不能发布覆盖统计。",
      ),
    );
  }
  if (!validText(input.documentInventory.source)) {
    errors.push(
      issue("missing-inventory-source", "没有说明统计文档集合的来源。"),
    );
  }
  if (!Array.isArray(input.documentInventory.exclusions)) {
    errors.push(issue("invalid-document-exclusions", "文档集合排除口径无效。"));
  }
  if (!validText(input.sources?.declarations)) {
    errors.push(
      issue("missing-declaration-source", "没有说明声明范围记录的来源。"),
    );
  }
  if (!validText(input.sources?.readHits)) {
    errors.push(issue("missing-read-source", "没有说明实际读取记录的来源。"));
  }
  if (!validText(input.sources?.bindingExecutions)) {
    errors.push(
      issue("missing-execution-source", "没有说明关联执行记录的来源。"),
    );
  }
  if (
    !Number.isSafeInteger(input.actualExecutionCount) ||
    input.actualExecutionCount < 0
  ) {
    errors.push(
      issue("invalid-execution-count", "实际执行次数必须是非负整数。"),
    );
  }
  if (input.documentInventory.documents.length === 0) {
    errors.push(
      issue("empty-document-inventory", "统计文档集合为空，不能计算覆盖比例。"),
    );
  }

  const bindingIds = new Set<string>();
  for (const binding of bindings) {
    try {
      assertBindingDefinition(binding);
    } catch (error) {
      errors.push(
        issue(
          "invalid-binding-definition",
          error instanceof Error ? error.message : String(error),
          { bindingId: binding?.id },
        ),
      );
      continue;
    }
    if (bindingIds.has(binding.id)) {
      errors.push(
        issue("duplicate-binding", `关联 ID 重复：${binding.id}`, {
          bindingId: binding.id,
        }),
      );
    }
    bindingIds.add(binding.id);
  }

  return errors;
}

/** 只汇总完整采集器记录，不读取文件、启动测试或判断引用事实。 */
export function summarizeCoverage(
  input: CoverageSummaryInput,
): CoverageSummaryResult {
  const { coverage, bindings } = input;
  const errors = invalidCollection(
    coverage,
    bindings,
    input.declarationCompleteness,
  );
  const lengths = new Map<string, number>();
  let totalUnits = 0;

  for (const document of coverage.documentInventory.documents) {
    if (!validText(document.path)) {
      errors.push(issue("invalid-document-path", "统计文档缺少路径。"));
      continue;
    }
    if (!Number.isSafeInteger(document.length) || document.length < 0) {
      errors.push(
        issue(
          "invalid-document-length",
          `文档 ${document.path} 的 UTF-16 长度无效。`,
          {
            path: document.path,
          },
        ),
      );
      continue;
    }
    if (lengths.has(document.path)) {
      errors.push(
        issue("duplicate-document", `统计文档重复：${document.path}`, {
          path: document.path,
        }),
      );
      continue;
    }
    lengths.set(document.path, document.length);
    totalUnits += document.length;
  }

  if (totalUnits === 0) {
    errors.push(
      issue("empty-document-units", "统计文档没有可计量的 UTF-16 文本。"),
    );
  }
  if (!Number.isSafeInteger(totalUnits)) {
    errors.push(
      issue(
        "document-units-overflow",
        "文档集合的 UTF-16 总长度超出安全整数范围。",
      ),
    );
  }

  const bindingsById = new Map(
    bindings.map((binding) => [binding.id, binding]),
  );
  const declaredByBindingAndReference = new Map<string, DocumentRange[]>();
  const declaredRanges = new Map<string, CoverageInterval[]>();
  for (const declaration of coverage.declarations) {
    const binding = bindingsById.get(declaration.bindingId);
    if (!binding) {
      errors.push(
        issue(
          "unknown-declaration-binding",
          `声明范围关联不存在：${declaration.bindingId}`,
          {
            bindingId: declaration.bindingId,
            referenceId: declaration.referenceId,
          },
        ),
      );
      continue;
    }
    if (!binding.documents.includes(declaration.referenceId)) {
      errors.push(
        issue(
          "not-a-document-reference",
          `引用 ${declaration.referenceId} 不是关联 ${declaration.bindingId} 的文档端引用。`,
          {
            bindingId: declaration.bindingId,
            referenceId: declaration.referenceId,
          },
        ),
      );
      continue;
    }
    if (
      !validateRange(
        declaration.range,
        lengths,
        "invalid-declaration-range",
        {
          bindingId: declaration.bindingId,
          referenceId: declaration.referenceId,
        },
        errors,
      )
    )
      continue;

    addRange(declaredRanges, declaration.range);
    const key = `${declaration.bindingId}\0${declaration.referenceId}`;
    const ranges = declaredByBindingAndReference.get(key) ?? [];
    ranges.push(declaration.range);
    declaredByBindingAndReference.set(key, ranges);
  }

  for (const binding of bindings) {
    for (const referenceId of binding.documents) {
      if (!declaredByBindingAndReference.has(`${binding.id}\0${referenceId}`)) {
        errors.push(
          issue(
            "missing-declaration-range",
            `关联 ${binding.id} 的文档引用 ${referenceId} 没有当前可定位范围。`,
            { bindingId: binding.id, referenceId },
          ),
        );
      }
    }
  }

  const readRanges = new Map<string, CoverageInterval[]>();
  for (const range of coverage.readHits) {
    if (validateRange(range, lengths, "invalid-read-hit", {}, errors)) {
      addRange(readRanges, range);
    }
  }

  const occurredByBinding = new Map<string, Set<string>>();
  for (const execution of coverage.referenceExecutions) {
    const binding = bindingsById.get(execution.bindingId);
    if (!binding) {
      errors.push(
        issue(
          "unknown-execution-binding",
          `执行记录关联不存在：${execution.bindingId}`,
          {
            bindingId: execution.bindingId,
            referenceId: execution.referenceId,
          },
        ),
      );
      continue;
    }
    if (!binding.references.includes(execution.referenceId)) {
      errors.push(
        issue(
          "not-a-required-reference",
          `引用 ${execution.referenceId} 不是关联 ${execution.bindingId} 的必需右端。`,
          {
            bindingId: execution.bindingId,
            referenceId: execution.referenceId,
          },
        ),
      );
      continue;
    }
    const referenceIds =
      occurredByBinding.get(execution.bindingId) ?? new Set<string>();
    referenceIds.add(execution.referenceId);
    occurredByBinding.set(execution.bindingId, referenceIds);
  }

  const hitBindingIds: string[] = [];
  const unhitBindingIds: string[] = [];
  const executionRanges = new Map<string, CoverageInterval[]>();
  for (const binding of bindings) {
    const occurred = occurredByBinding.get(binding.id) ?? new Set<string>();
    if (!binding.references.every((referenceId) => occurred.has(referenceId))) {
      unhitBindingIds.push(binding.id);
      continue;
    }
    hitBindingIds.push(binding.id);
    for (const referenceId of binding.documents) {
      for (const range of declaredByBindingAndReference.get(
        `${binding.id}\0${referenceId}`,
      ) ?? []) {
        addRange(executionRanges, range);
      }
    }
  }

  if (errors.length) return { errors };

  const documents = [...coverage.documentInventory.documents].toSorted(
    (left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return {
    coverage: {
      unit: "utf16-code-unit",
      documentInventory: {
        source: coverage.documentInventory.source,
        paths: documents.map((document) => document.path),
        exclusions: [...coverage.documentInventory.exclusions],
        totalUnits,
      },
      sources: { ...coverage.sources },
      validationScope: [...input.validationScope],
      declaration: measure(documents, declaredRanges, totalUnits),
      readHits: measure(documents, readRanges, totalUnits),
      bindingExecutionHits: measure(documents, executionRanges, totalUnits),
      bindingExecution: {
        hitBindingIds: hitBindingIds.toSorted(),
        unhitBindingIds: unhitBindingIds.toSorted(),
      },
      actualExecutionCount: coverage.actualExecutionCount,
      readHitCount: coverage.readHits.length,
      limitations: [
        "统计单位为 UTF-16 代码单元，位置采用左闭右开区间；只计入单独列出的文档集合。",
        "读取命中只代表采集器实际记录的读取，不包括索引或比较扫描。",
        "关联执行命中要求该关联的每条必需右端引用都有实际发生记录；命中不表示断言充分或文档语义正确。",
      ],
    },
  };
}
