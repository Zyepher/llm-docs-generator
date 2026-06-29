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

/**
 * True when a filesystem error means the target path does not exist: ENOENT (no
 * such entry) or ENOTDIR (a path component is not a directory, e.g. `a/b/c`
 * where `b` is a file). Several call-sites previously checked only ENOENT, so a
 * non-directory path component was misclassified as an unexpected error instead
 * of "not found"; this canonical guard handles both.
 */
export function isFileNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) {
    return false;
  }

  const { code } = error as NodeJS.ErrnoException;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
