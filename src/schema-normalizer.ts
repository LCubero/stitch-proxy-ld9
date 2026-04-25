export type JsonPrimitive = boolean | number | null | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRecord(record: Record<string, unknown>): JsonObject {
  const normalizedEntries = Object.entries(record).map(([key, value]) => [
    key,
    normalizeJsonSchema(value),
  ] as const);

  const normalizedObject = Object.fromEntries(normalizedEntries) as JsonObject;
  const keys = Object.keys(normalizedObject);

  if (!keys.includes('$ref') || keys.length === 1) {
    return normalizedObject;
  }

  const { $ref, ...siblings } = normalizedObject;

  return {
    allOf: [{ $ref }],
    ...siblings,
  };
}

export function normalizeJsonSchema<T>(schema: T): T {
  if (Array.isArray(schema)) {
    return schema.map((item) => normalizeJsonSchema(item)) as T;
  }

  if (isPlainObject(schema)) {
    return normalizeRecord(schema) as T;
  }

  return schema;
}
