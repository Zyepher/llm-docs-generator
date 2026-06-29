/**
 * Deterministic, locale-independent string comparator (UTF-16 code-unit order).
 *
 * This underpins every sorted index and ordering that `verify` rebuilds and
 * compares, so it must stay byte-for-byte stable. Do NOT replace with
 * localeCompare (locale-dependent) — that is a different comparator used only
 * for human-facing parser output.
 */
export function compareStringsByCodeUnit(a: string, b: string): number {
  const length = Math.min(a.length, b.length);

  for (let index = 0; index < length; index++) {
    const difference = a.charCodeAt(index) - b.charCodeAt(index);

    if (difference !== 0) {
      return difference;
    }
  }

  return a.length - b.length;
}
