/** JSON-shaped facts allow plugins to preserve explicit selections without adding runtime dependencies. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** All comparable values share pure-data rules; validation never evaluates accessors or conversion methods. */
export function isJsonValue(value: unknown): value is JsonValue {
  try {
    copyJsonValue(value);
    return true;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

/** Accepts pure data and produces an independent copy; special properties and cycles fail explicitly. */
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
    if (!Number.isFinite(value)) {
      throw new TypeError("Value contains a non-finite number.");
    }
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
        ? "JSON array must be dense and have no extra properties."
        : "Value must be a plain JSON object without extra properties.",
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
        ? "JSON array must be dense and have no extra properties."
        : "Value must be a plain JSON object without extra properties.",
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
          throw new TypeError(
            "JSON array cannot contain holes or accessor properties.",
          );
        }
        result.push(copy(descriptor.value, active));
      }
      return result;
    }
    const entries: [string, JsonValue][] = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError("JSON object cannot contain accessor properties.");
      }
      entries.push([key, copy(descriptor.value, active)]);
    }
    return Object.fromEntries(entries);
  } finally {
    active.delete(value);
  }
}

/** Object key order is ignored, plain arrays are ordered, and 0/-0 share JSON encoding. */
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
  return new TypeError(
    "Value must be plain JSON data without cycles or special properties.",
  );
}
