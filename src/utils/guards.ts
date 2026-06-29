/**
 * Small, dependency-free type guards and value predicates shared across the
 * codebase. Previously these were copy-pasted into many modules; consolidating
 * them removes drift risk. All bodies are the canonical (majority) form and are
 * behavior-identical to the copies they replace.
 */

/**
 * True for a non-null, non-array object (a plain record). `isObjectRecord` is an
 * alias kept so existing call-sites need no renaming.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const isObjectRecord = isRecord;

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
