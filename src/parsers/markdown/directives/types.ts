/**
 * Markdown-directive extension seam.
 *
 * A directive extension teaches the generic markdown parser one vendor's private
 * directive dialect (e.g. TanStack's `<!-- ::start:KIND -->` switcher comments)
 * without baking that dialect into the parser core. New vendors or parser
 * plugins register an extension in the directive registry; the parser never
 * names any single dialect.
 */

export interface MarkdownDirectiveExtension {
  /** Stable dialect identifier, used for ordering and diagnostics. */
  readonly name: string;

  /**
   * Deterministic activation predicate. Returns true ONLY when this extension's
   * exact marker syntax is literally present in `content`. This is explicit
   * marker detection, never a heuristic guess: an extension whose markers are
   * absent must return false so its transform is skipped entirely.
   */
  appliesTo(content: string): boolean;

  /**
   * Pure, fence-aware rewrite of `content`. Invoked only after `appliesTo`
   * returned true, so a marker-free document is returned untouched by the seam.
   */
  transform(content: string): string;
}
