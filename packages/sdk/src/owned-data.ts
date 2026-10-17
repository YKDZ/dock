import { copyJsonValue, type JsonValue } from "@dock/core";

import type { Reference } from "./contracts.ts";

export function ownReference(reference: Reference): Reference {
  return Object.freeze({
    ...reference,
    target: ownJsonValue(reference.target),
    ...(reference.selection === undefined
      ? {}
      : { selection: ownJsonValue(reference.selection) }),
    ...(reference.declaredAt instanceof URL
      ? { declaredAt: reference.declaredAt.href }
      : {}),
  });
}

/** 已接纳的值归本次操作所有，插件与调用方不能再改写它。 */
export function ownJsonValue<Value extends JsonValue>(value: Value): Value {
  const owned = copyJsonValue(value);
  freeze(owned);
  return owned as Value;
}

function freeze(value: JsonValue): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
