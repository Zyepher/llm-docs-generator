export function slugifyText(value: string, fallback = 'section'): string {
  // Unicode-aware: any letter or number survives (so all-CJK headings keep a
  // real id instead of collapsing to the fallback); everything else joins as a
  // single hyphen. Pure-ASCII input slugs exactly as the old ASCII-only rule.
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');

  return slug || fallback;
}
