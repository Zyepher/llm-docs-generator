/**
 * Markdown-directive extension registry.
 *
 * Holds the registered directive dialects in application order and applies only
 * those whose exact marker syntax is present in a given document. This is the
 * seam where future vendor dialects or parser plugins hook in; the generic
 * markdown parser calls {@link applyMarkdownDirectives} and never references any
 * individual dialect.
 */

import type { MarkdownDirectiveExtension } from './types.js';
import { commentDirectiveTabsExtension } from './comment-directive-tabs.js';

export type { MarkdownDirectiveExtension } from './types.js';
export { commentDirectiveTabsExtension } from './comment-directive-tabs.js';

/**
 * Registered directive dialects, in application order. The comment-directive
 * tabs dialect ships as the first (currently only) registered extension.
 */
export const MARKDOWN_DIRECTIVE_EXTENSIONS: readonly MarkdownDirectiveExtension[] = [
  commentDirectiveTabsExtension,
];

/**
 * Apply every registered directive extension whose exact marker syntax is
 * present in `content`, in registration order. An extension whose markers are
 * absent is skipped entirely, so a document containing no directive markers is
 * returned byte-for-byte unchanged. This makes the historical "no markers → no
 * change" guarantee structural rather than incidental.
 */
export function applyMarkdownDirectives(content: string): string {
  let result = content;
  for (const extension of MARKDOWN_DIRECTIVE_EXTENSIONS) {
    if (extension.appliesTo(result)) {
      result = extension.transform(result);
    }
  }
  return result;
}
