export function keepResult<T>(input: T, returned: T | undefined) {
  return { returned: returned ?? null, sameReference: returned === input };
}
