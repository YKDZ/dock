import {
  createReference,
  definePlugin,
  type PluginBatchResult,
  type PluginRequest,
  type Reference,
  type ReferenceOptions,
} from "@ykdz/dock";

export const catalogPluginId = "@fixture/catalog" as const;

export type CatalogTarget = {
  readonly kind: "catalog";
  readonly path: string;
};

export type CatalogSelection = {
  readonly field: "title" | "entries";
  readonly locale?: "en" | "zh";
};

export type CatalogValue = {
  readonly title: string;
  readonly entries: string[];
};

export type CatalogReference<Id extends string = string> = Reference<
  typeof catalogPluginId,
  Id,
  CatalogTarget,
  CatalogValue,
  CatalogSelection
>;

export function catalogReference<Id extends string>(
  id: Id,
  target: CatalogTarget,
  selection: CatalogSelection,
  options: Pick<ReferenceOptions<CatalogSelection>, "note" | "declaredAt"> = {},
): CatalogReference<Id> {
  return createReference<
    typeof catalogPluginId,
    Id,
    CatalogTarget,
    CatalogValue,
    CatalogSelection
  >(catalogPluginId, id, target, { ...options, selection });
}

export const catalogPlugin = definePlugin({
  id: catalogPluginId,
  validate(reference: CatalogReference): void {
    if (
      reference.target.kind !== "catalog" ||
      typeof reference.target.path !== "string" ||
      (reference.selection !== undefined &&
        reference.selection.field !== "title" &&
        reference.selection.field !== "entries")
    ) {
      throw new TypeError(`无效目录引用：${reference.id}`);
    }
  },
  collect(
    request: PluginRequest<CatalogReference>,
  ): PluginBatchResult<CatalogValue> {
    return {
      results: request.selectedReferences.map((reference) =>
        reference.target.path === "broken"
          ? {
              referenceId: reference.id,
              kind: "error",
              error: { code: "catalog-missing", message: "目录不存在。" },
            }
          : {
              referenceId: reference.id,
              kind: "value",
              value: {
                title: reference.selection?.field ?? reference.target.path,
                entries: [reference.target.path],
              },
            },
      ),
    };
  },
});
