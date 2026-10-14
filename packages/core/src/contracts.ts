/** JSON 形事实允许适配器保留明确选择，同时不增加运行时依赖。 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** 当前文档位置用于解释结果，不参与事实比较。 */
export type DocumentRange = { path: string; start: number; end: number };

/** 纳入文档全集的当前文本长度，以 JavaScript UTF-16 代码单元计。 */
export type CoverageDocument = { path: string; length: number };
export type CoverageRangeDeclaration = {
  bindingId: string;
  referenceId: string;
  range: DocumentRange;
};
export type ReferenceExecution = { bindingId: string; referenceId: string };
export type CoverageIssue = {
  code: string;
  message: string;
  path?: string;
  bindingId?: string;
  referenceId?: string;
};

/** 只包含采集器已经留下的资料；归集本身不会读取或执行任何目标。 */
export type CoverageInput = {
  documentInventory: {
    complete: boolean;
    source: string;
    exclusions: string[];
    documents: CoverageDocument[];
  };
  recordsComplete: boolean;
  collectionErrors?: CoverageIssue[];
  /** 来自同一次外部执行的实际测试次数；归集不会增加它。 */
  actualExecutionCount: number;
  declarations: CoverageRangeDeclaration[];
  readHits: DocumentRange[];
  referenceExecutions: ReferenceExecution[];
  sources: {
    declarations: string;
    readHits: string;
    bindingExecutions: string;
  };
};

export type CoverageInterval = { start: number; end: number };
export type CoverageRangeSet = {
  path: string;
  ranges: CoverageInterval[];
};
export type CoverageMeasure = {
  coveredUnits: number;
  totalUnits: number;
  percentage: number;
  coveredRanges: CoverageRangeSet[];
  uncoveredRanges: CoverageRangeSet[];
};
export type CoverageReport = {
  unit: "utf16-code-unit";
  documentInventory: {
    source: string;
    paths: string[];
    exclusions: string[];
    totalUnits: number;
  };
  sources: CoverageInput["sources"];
  validationScope: string[];
  declaration: CoverageMeasure;
  readHits: CoverageMeasure;
  bindingExecutionHits: CoverageMeasure;
  bindingExecution: {
    hitBindingIds: string[];
    unhitBindingIds: string[];
  };
  actualExecutionCount: number;
  readHitCount: number;
  limitations: string[];
};
export type CoverageSummaryInput = {
  bindings: readonly BindingDefinition[];
  declarationCompleteness: DeclarationCompleteness;
  validationScope: readonly string[];
  coverage: CoverageInput;
};
export type CoverageSummaryResult =
  | { coverage: CoverageReport }
  | { errors: CoverageIssue[] };
export type CompleteCheckReport = CheckReport & { coverage: CoverageReport };
export type CheckWithCoverageInput = CheckInput & { coverage: CoverageInput };
export type CheckWithCoverageResult =
  | { report: CompleteCheckReport }
  | { errors: CoverageIssue[] };

/** 定位目标及选择规则与当前取得的值分别比较。 */
export type ReferenceDefinition = {
  id: string;
  target: JsonValue;
  selection?: JsonValue;
  note?: string;
};

/** 关联两端的每条引用都是取得一致性结果的必需条件。 */
export type BindingDefinition = {
  id: string;
  documents: string[];
  references: string[];
  note?: string;
};

/** 声明集合表示全部已登记关联，或仅表示本次提供的局部子集。 */
export type DeclarationCompleteness = "complete" | "partial";

export type ReferenceFact =
  | { referenceId: string; value: JsonValue; range?: DocumentRange }
  | {
      referenceId: string;
      error: { code: string; message: string };
      range?: DocumentRange;
    };

export type AcceptedReferenceFact = {
  definition: ReferenceDefinition;
  value: JsonValue;
};
export type BindingBaseline = {
  definition: BindingDefinition;
  references: Record<string, AcceptedReferenceFact>;
};
export type Baseline = {
  version: 1;
  bindings: Record<string, BindingBaseline>;
};

export type CurrentReferenceFact = AcceptedReferenceFact & {
  range?: DocumentRange;
};
export type CurrentBinding = {
  definition: BindingDefinition;
  references: Record<string, CurrentReferenceFact>;
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
  | { kind: "fact"; referenceId: string; before: JsonValue; after: JsonValue };

export type EvidenceError = {
  referenceId?: string;
  code: string;
  message: string;
};
type BindingAuditBase = { bindingId: string; changes: BindingChange[] };
export type BindingAudit =
  | (BindingAuditBase & {
      consistency: "consistent" | "inconsistent";
      current: CurrentBinding;
      errors?: never;
    })
  | (BindingAuditBase & {
      errors: EvidenceError[];
      consistency?: never;
      current?: never;
      untracked?: never;
    })
  | (BindingAuditBase & {
      untracked: true;
      consistency: "inconsistent";
      changes: [{ kind: "binding-removed"; before: BindingDefinition }];
      current?: never;
      errors?: never;
    });

export type CheckInput = {
  references: ReferenceDefinition[];
  bindings: BindingDefinition[];
  facts: ReferenceFact[];
  baseline?: Baseline;
  declarationCompleteness?: DeclarationCompleteness;
  scope?: readonly string[];
};
export type CheckReport = {
  /** 核对所依据的基线快照，接受时用于发现核对后基线已被替换。 */
  reviewedBaseline: Baseline | null;
  declaration: {
    completeness: DeclarationCompleteness;
    bindingIds: string[];
  };
  scope: string[];
  bindings: BindingAudit[];
};

export type AcceptanceIssue = {
  bindingId?: string;
  referenceId?: string;
  code: string;
  message: string;
};
export type AcceptanceOutcome =
  | { status: "accepted"; baseline: Baseline }
  | { status: "rejected"; errors: AcceptanceIssue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertId(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${context} 必须是非空文本。`);
  }
}

function assertReferenceIds(
  ids: unknown,
  side: string,
  bindingId: string,
): asserts ids is string[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new TypeError(`关联 ${bindingId} 的 ${side} 端不能为空。`);
  }
  const seen = new Set<string>();
  for (const id of ids) {
    assertId(id, `关联 ${bindingId} 的引用 ID`);
    if (seen.has(id))
      throw new TypeError(`关联 ${bindingId} 的 ${side} 端包含重复引用：${id}`);
    seen.add(id);
  }
}

export function assertBindingDefinition(
  value: unknown,
): asserts value is BindingDefinition {
  if (!isRecord(value)) throw new TypeError("关联定义必须是对象。");
  assertId(value.id, "关联 ID");
  assertReferenceIds(value.documents, "documents", value.id);
  assertReferenceIds(value.references, "references", value.id);
  if (value.note !== undefined && typeof value.note !== "string") {
    throw new TypeError(`关联 ${value.id} 的 note 必须是文本。`);
  }
}

export function assertReferenceDefinition(
  value: unknown,
): asserts value is ReferenceDefinition {
  if (!isRecord(value)) throw new TypeError("引用定义必须是对象。");
  assertId(value.id, "引用 ID");
  if (!Object.hasOwn(value, "target"))
    throw new TypeError(`引用 ${value.id} 缺少 target。`);
  if (value.note !== undefined && typeof value.note !== "string") {
    throw new TypeError(`引用 ${value.id} 的 note 必须是文本。`);
  }
}

export function assertBaseline(value: Baseline | undefined): void {
  if (value === undefined) return;
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.bindings)) {
    throw new TypeError("审阅基线格式无效。");
  }
  for (const [id, binding] of Object.entries(value.bindings)) {
    if (!isRecord(binding) || !isRecord(binding.references)) {
      throw new TypeError(`关联 ${id} 的审阅基线格式无效。`);
    }
    assertBindingDefinition(binding.definition);
    if (binding.definition.id !== id)
      throw new TypeError(`关联 ${id} 的审阅基线 ID 不匹配。`);

    const required = new Set([
      ...binding.definition.documents,
      ...binding.definition.references,
    ]);
    const actual = Object.keys(binding.references);
    if (
      actual.length !== required.size ||
      actual.some((referenceId) => !required.has(referenceId))
    ) {
      throw new TypeError(`关联 ${id} 的审阅基线没有保存全部必需引用。`);
    }
    for (const [referenceId, reference] of Object.entries(binding.references)) {
      if (!isRecord(reference))
        throw new TypeError(`引用 ${referenceId} 的审阅基线格式无效。`);
      assertReferenceDefinition(reference.definition);
      if (
        reference.definition.id !== referenceId ||
        !Object.hasOwn(reference, "value")
      ) {
        throw new TypeError(`引用 ${referenceId} 的审阅基线记录无效。`);
      }
    }
  }
}
