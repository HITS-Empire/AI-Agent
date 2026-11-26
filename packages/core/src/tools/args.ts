export function asString(
  value: unknown,
  name: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string") {
    throw new Error(`${name} должен быть строкой`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new Error(`${name} пустой`);
  }
  return value;
}

export function asInt(
  value: unknown,
  name: string,
  fallback?: number,
): number | undefined {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${name} должен быть целым числом`);
  }
  return value;
}
