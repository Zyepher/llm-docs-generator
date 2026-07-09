/**
 * Fenced-code-block scanning primitives shared by the markdown parser core and
 * the markdown-directive extensions.
 *
 * Kept as pure functions (no parser state) so a self-contained directive
 * extension can be fence-aware without reaching back into the parser class, and
 * so the parser and every extension apply exactly one fence-detection rule.
 */

export interface FenceState {
  marker: '`' | '~';
  length: number;
}

/**
 * The opening fence a line begins, or null. A CommonMark fence is a run of at
 * least three backticks or tildes indented no more than three spaces; the info
 * string (if any) follows and does not affect the fence itself.
 */
export function getOpeningFence(line: string): FenceState | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
  const rawMarker = match?.[1];
  if (rawMarker === undefined) {
    return null;
  }

  const marker = rawMarker[0] as '`' | '~';
  return { marker, length: rawMarker.length };
}

/**
 * True when `line` closes the currently open `fence`: a bare run of the same
 * marker character, at least as long as the opening run, with no trailing
 * content.
 */
export function isClosingFence(line: string, fence: FenceState): boolean {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
  const rawMarker = match?.[1];
  return (
    rawMarker !== undefined && rawMarker[0] === fence.marker && rawMarker.length >= fence.length
  );
}
