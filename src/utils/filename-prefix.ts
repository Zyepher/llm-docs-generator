/**
 * Shared filename-prefix sanitization used by source-docs prefix derivation, the
 * CLI `generate --filename-prefix` validation, and the source-docs verifier.
 *
 * Keeping the rule in one place guarantees an operator-supplied prefix is held to
 * exactly the same character rules as the prefix derived from the source
 * basename, so the two paths can never drift apart.
 */

/**
 * Collapse any run of characters outside `[A-Za-z0-9._-]` to a single dash and
 * trim leading/trailing dashes. An input that sanitizes to nothing falls back to
 * the literal `source` so a usable, collision-free filename segment always
 * results. This is intentionally case-preserving; the derived prefix lowercases
 * separately before calling this.
 */
export function sanitizeFilenameSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'source';
}

/**
 * True when `value` is already a clean filename segment, i.e. non-empty and
 * unchanged by {@link sanitizeFilenameSegment}. Used to validate an explicit
 * operator prefix instead of silently rewriting it.
 */
export function isSanitizedFilenameSegment(value: string): boolean {
  return value.length > 0 && sanitizeFilenameSegment(value) === value;
}
