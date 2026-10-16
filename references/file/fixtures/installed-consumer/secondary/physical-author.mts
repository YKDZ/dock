import {
  binding,
  createReference,
  definePlugin,
  type PluginResult,
  type Reference,
} from "@dock/sdk";

export const physicalPluginId = "@fixture/physical" as const;
export type PhysicalTarget = { readonly path: string };
export type PhysicalValue = { readonly path: string };
export type PhysicalReference<Id extends string = string> = Reference<
  typeof physicalPluginId,
  Id,
  PhysicalTarget,
  PhysicalValue
>;

let collectionCount = 0;

export const physicalPlugin = definePlugin({
  id: physicalPluginId,
  validate(reference: PhysicalReference): void {
    if (
      typeof reference.target.path !== "string" ||
      reference.target.path.length === 0
    ) {
      throw new TypeError(`无效物理安装引用：${reference.id}`);
    }
  },
  collect(reference: PhysicalReference): PluginResult<PhysicalValue> {
    collectionCount += 1;
    return { kind: "value", value: { path: reference.target.path } };
  },
});

export const sharedReference = createReference<
  typeof physicalPluginId,
  "shared-reference",
  PhysicalTarget,
  PhysicalValue
>(
  physicalPluginId,
  "shared-reference",
  { path: "shared.json" },
  {
    declaredAt: "secondary-author.mts",
  },
);

export function makeBinding<
  const References extends readonly [PhysicalReference, ...PhysicalReference[]],
>(id: string, references: References) {
  return binding(id, references);
}

export function resetCollectionCount(): void {
  collectionCount = 0;
}

export function readCollectionCount(): number {
  return collectionCount;
}
