/**
 * Comment-directive tabs/framework switcher dialect.
 *
 * Parses the generic HTML-comment directive syntax; nothing in the transform is
 * vendor-specific:
 *   <!-- ::start:tabs variant="bundler" --> ... <!-- ::end:tabs -->
 *   <!-- ::start:framework --> ... <!-- ::end:framework -->
 * Each tab item is authored as an ATX heading (typically `# Vite`). This dialect
 * rewrites those items into ordinary, self-describing, correctly-nested headings
 * so the section tree and document order survive stripping the switcher chrome.
 *
 * Known user of this dialect: the TanStack docs site (https://tanstack.com/).
 *
 * The first extension registered in the directive seam; other dialects register
 * alongside it without touching the parser core.
 */

import { getOpeningFence, isClosingFence, type FenceState } from '../fences.js';
import type { MarkdownDirectiveExtension } from './types.js';

/**
 * Exact opening-marker syntax this dialect recognizes. Non-global so `.test` and
 * per-line `.match` stay stateless. Presence of this literal marker is the sole,
 * deterministic activation signal — no heuristics.
 */
const START_DIRECTIVE = /<!--\s*::start:([A-Za-z-]+)([^>]*?)-->/;
const END_DIRECTIVE = /<!--\s*::end:[A-Za-z-]+\s*-->/;
const VARIANT_ATTRIBUTE = /variant\s*=\s*"([^"]*)"/;
const ATX_HEADING = /^(#{1,6})\s+(.*?)\s*$/;

export const commentDirectiveTabsExtension: MarkdownDirectiveExtension = {
  name: 'comment-directive-tabs',

  appliesTo(content: string): boolean {
    // A switcher block is only meaningful once an `::start:` marker opens it; a
    // stray `::end:` alone leaves the transform a pure no-op, so the start marker
    // is the exact activation signal.
    return START_DIRECTIVE.test(content);
  },

  transform(content: string): string {
    return transformDirectiveTabs(content);
  },
};

/**
 * Rewrite tab/framework switcher directives so their items become ordinary,
 * self-describing, correctly-nested headings.
 *
 * Fence-aware and run before any other cleaning. Per directive block it:
 *  - appends the switch axis to each item label so it is self-describing:
 *    `# Vite` under `variant="bundler"` becomes `Vite (bundler)`; a
 *    `::start:framework` item `# React` becomes `React (framework)`. The axis is
 *    the `variant` attribute when present, else the directive kind.
 *  - demotes item headings (and their in-item sub-headings) to nest directly
 *    under the section that encloses the block, so document order is preserved
 *    and later content returns to the enclosing section rather than the last tab.
 *    Nested directives (framework > tabs) nest one level deeper again.
 * Blocks whose items carry no heading label (for example `variant="files"`,
 * delimited by code-block titles) are left untouched apart from marker removal.
 */
function transformDirectiveTabs(content: string): string {
  const lines = content.split('\n');
  const output: string[] = [];
  let fence: FenceState | null = null;
  let lastHeadingLevel = 0;
  const stack: Array<{ axis: string; itemSourceLevel: number | null; delta: number }> = [];

  for (const line of lines) {
    if (fence !== null) {
      output.push(line);
      if (isClosingFence(line, fence)) {
        fence = null;
      }
      continue;
    }

    const openingFence = getOpeningFence(line);
    if (openingFence !== null) {
      output.push(line);
      fence = openingFence;
      continue;
    }

    const startMatch = line.match(START_DIRECTIVE);
    if (startMatch?.[1] !== undefined) {
      const kind = startMatch[1];
      const variantMatch = (startMatch[2] ?? '').match(VARIANT_ATTRIBUTE);
      const axis = variantMatch?.[1]?.trim() || kind;
      stack.push({ axis, itemSourceLevel: null, delta: 0 });
      continue;
    }

    if (END_DIRECTIVE.test(line)) {
      if (stack.length > 0) {
        stack.pop();
      }
      continue;
    }

    const headingMatch = line.match(ATX_HEADING);
    if (headingMatch?.[1] !== undefined && headingMatch[2] !== undefined) {
      const sourceLevel = headingMatch[1].length;
      const text = headingMatch[2];
      const frame = stack.at(-1);

      if (frame === undefined) {
        lastHeadingLevel = sourceLevel;
        output.push(line);
        continue;
      }

      if (frame.itemSourceLevel === null) {
        frame.itemSourceLevel = sourceLevel;
        frame.delta = lastHeadingLevel + 1 - sourceLevel;
      }

      const renderedLevel = Math.min(6, Math.max(1, sourceLevel + frame.delta));
      const isItemLabel = sourceLevel === frame.itemSourceLevel;
      const newText = isItemLabel ? `${text} (${frame.axis})` : text;
      output.push(`${'#'.repeat(renderedLevel)} ${newText}`);
      lastHeadingLevel = renderedLevel;
      continue;
    }

    output.push(line);
  }

  return output.join('\n');
}
