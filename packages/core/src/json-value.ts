/** JSON 形事实允许适配器保留明确选择，同时不增加运行时依赖。 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** 所有可比较值共用纯数据规则；校验不会求值访问器或调用转换方法。 */
export function isJsonValue(value: unknown): value is JsonValue {
  try {
    copyJsonValue(value);
    return true;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

/** 接纳纯数据并取得独立副本，特殊属性和循环均明确失败。 */
export function copyJsonValue(value: unknown): JsonValue {
  return copy(value, new Set());
}

function copy(value: unknown, active: Set<object>): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("值包含非有限数。");
    return value;
  }
  if (typeof value !== "object" || value === null || active.has(value)) {
    throw invalidValue();
  }

  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    (array
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError(
      array
        ? "JSON 数组必须连续且没有额外属性。"
        : "值必须是没有额外属性的普通 JSON 对象。",
    );
  }
  const keys = Object.keys(value);
  if (
    Object.getOwnPropertyNames(value).length !==
      keys.length + (array ? 1 : 0) ||
    (array && keys.length !== value.length)
  ) {
    throw new TypeError(
      array
        ? "JSON 数组必须连续且没有额外属性。"
        : "值必须是没有额外属性的普通 JSON 对象。",
    );
  }

  active.add(value);
  try {
    if (array) {
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          throw new TypeError("JSON 数组不能包含空位或访问器属性。");
        }
        result.push(copy(descriptor.value, active));
      }
      return result;
    }
    const entries: [string, JsonValue][] = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor))
        throw new TypeError("JSON 对象不能包含访问器属性。");
      entries.push([key, copy(descriptor.value, active)]);
    }
    return Object.fromEntries(entries);
  } finally {
    active.delete(value);
  }
}

/** 对象键序无关，普通数组有序，零与负零沿用 JSON 的相同编码。 */
export function canonicalJson(value: JsonValue): string {
  return encode(copyJsonValue(value));
}

function encode(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${encode(value[key]!)}`)
    .join(",")}}`;
}

function invalidValue(): TypeError {
  return new TypeError("值必须是无循环、无特殊属性的普通 JSON 数据。");
}
