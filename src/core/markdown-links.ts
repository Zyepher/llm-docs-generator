/**
 * Deterministic markdown link rewriting for local source packs.
 *
 * A generated pack is a single flat `.txt` file, so a document's original
 * links no longer resolve. At format time this module rewrites the link
 * constructs found in prose so they stay useful:
 *
 *  - Reference-link uses (`[text][label]`, `[text][]`, and shortcut `[label]`)
 *    are inlined to `[text](url)` using the source file's captured reference
 *    definitions. A full/collapsed use with no matching definition is left
 *    unchanged and reported as an unresolved-reference warning.
 *  - Relative links to `.md`/`.mdx`/`.markdown` files are rewritten. When the
 *    target file is part of this pack, the link becomes `pack:<target-relpath>`
 *    (preserving any `#fragment`), which resolves to the section whose
 *    `[source: ...]` marker matches. When the target is outside the pack and a
 *    git context is available, it becomes the pinned permanent blob URL. With
 *    no git context, the link is left unchanged and counted.
 *  - In-page `#anchor` links are intentionally left unchanged. Titles are now
 *    preserved verbatim, so the heading text is directly greppable; a `pack:`
 *    target plus a grep on the heading is the resolution path. This is a known
 *    limitation: fragments are not rewritten to any explicit anchor scheme.
 *
 * Links inside inline code spans are never rewritten. Fenced code blocks never
 * reach this function (they are separate content blocks), which keeps the
 * code-fidelity guarantee intact.
 */

export interface MarkdownLinkGitContext {
  remoteUrl: string | null;
  commit: string;
  sourceRootFromRepo: string;
}

export interface LinkRewriteContext {
  /** POSIX relpath (from the source root) of the file whose prose is rewritten. */
  currentRelpath: string;
  /** All source relpaths (POSIX, from the source root) present in this pack. */
  packRelpaths: ReadonlySet<string>;
  /** Reference definitions for the current file, keyed by authored label. */
  linkDefinitions: ReadonlyMap<string, string>;
  gitContext?: MarkdownLinkGitContext;
  onUnresolvedReference: (label: string) => void;
  onUnrewrittenRelativeLink: () => void;
  onNonGithubRemote: () => void;
}

const MARKDOWN_TARGET = /\.(?:md|mdx|markdown)$/i;

/** Rewrite the link constructs in a single prose string. */
export function rewriteProseLinks(text: string, context: LinkRewriteContext): string {
  if (text.length === 0 || !text.includes('[')) {
    return text;
  }

  const definitions = lowercaseKeys(context.linkDefinitions);

  return mapOutsideInlineCode(text, (segment) => {
    let result = resolveFullAndCollapsedReferences(segment, definitions, context);
    result = resolveShortcutReferences(result, definitions);
    result = rewriteInlineLinks(result, context);
    return result;
  });
}

function lowercaseKeys(definitions: ReadonlyMap<string, string>): Map<string, string> {
  const normalized = new Map<string, string>();
  for (const [label, href] of definitions) {
    const key = normalizeLabel(label);
    if (!normalized.has(key)) {
      normalized.set(key, href);
    }
  }
  return normalized;
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Split a string into inline-code spans and non-code text, applying `transform`
 * only to the non-code parts. Code spans are matched as a run of N backticks up
 * to the next run of exactly the same length, per CommonMark.
 */
function mapOutsideInlineCode(text: string, transform: (segment: string) => string): string {
  const parts: string[] = [];
  let index = 0;

  while (index < text.length) {
    const tickStart = text.indexOf('`', index);
    if (tickStart === -1) {
      parts.push(transform(text.slice(index)));
      break;
    }

    let runEnd = tickStart;
    while (runEnd < text.length && text[runEnd] === '`') {
      runEnd += 1;
    }
    const runLength = runEnd - tickStart;
    const closing = findClosingBacktickRun(text, runEnd, runLength);

    if (closing === -1) {
      // No matching closing run: the backticks are literal text, not a span.
      parts.push(transform(text.slice(index, runEnd)));
      index = runEnd;
      continue;
    }

    parts.push(transform(text.slice(index, tickStart)));
    parts.push(text.slice(tickStart, closing + runLength));
    index = closing + runLength;
  }

  return parts.join('');
}

function findClosingBacktickRun(text: string, from: number, runLength: number): number {
  let cursor = from;
  while (cursor < text.length) {
    const next = text.indexOf('`', cursor);
    if (next === -1) {
      return -1;
    }
    let end = next;
    while (end < text.length && text[end] === '`') {
      end += 1;
    }
    if (end - next === runLength) {
      return next;
    }
    cursor = end;
  }
  return -1;
}

function resolveFullAndCollapsedReferences(
  text: string,
  definitions: Map<string, string>,
  context: LinkRewriteContext
): string {
  // `[text][label]` (full) and `[text][]` (collapsed). Inline `[text](url)` is
  // never matched because it lacks the `][` bridge.
  return text.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (match, rawText: string, rawLabel: string) => {
    const label = rawLabel.trim().length > 0 ? rawLabel : rawText;
    const href = definitions.get(normalizeLabel(label));
    if (href === undefined) {
      context.onUnresolvedReference(label.trim());
      return match;
    }
    return `[${rawText}](${href})`;
  });
}

function resolveShortcutReferences(text: string, definitions: Map<string, string>): string {
  // Shortcut reference `[label]` not followed by `(` or `[` and not immediately
  // preceded by `]`. Only rewritten when a definition exists; a bare `[label]`
  // with no definition is ordinary bracketed text and is left silent.
  return text.replace(/(^|[^\]])\[([^\]]+)\](?![[(])/g, (match, lead: string, rawLabel: string) => {
    const href = definitions.get(normalizeLabel(rawLabel));
    if (href === undefined) {
      return match;
    }
    return `${lead}[${rawLabel}](${href})`;
  });
}

function rewriteInlineLinks(text: string, context: LinkRewriteContext): string {
  // Inline links `[text](url "title")`. Images (`![alt](url)`) are skipped: the
  // pack rewrites .md document links, not image assets.
  return text.replace(
    /(!?)\[([^\]]*)\]\(\s*([^)\s]+)((?:\s+"[^"]*")?)\s*\)/g,
    (match, bang: string, linkText: string, url: string, title: string) => {
      if (bang === '!') {
        return match;
      }
      const rewritten = rewriteRelativeMarkdownUrl(url, context);
      if (rewritten === undefined) {
        return match;
      }
      return `[${linkText}](${rewritten}${title})`;
    }
  );
}

/**
 * Rewrite one URL if it targets a relative markdown file. Returns undefined when
 * the URL must be left unchanged (absolute URL, in-page anchor, non-markdown
 * target, or an unrewritable external target with no git context).
 */
export function rewriteRelativeMarkdownUrl(
  url: string,
  context: LinkRewriteContext
): string | undefined {
  const hashIndex = url.indexOf('#');
  const pathPart = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : url.slice(hashIndex);

  if (pathPart.length === 0) {
    // Pure in-page anchor: left unchanged by design.
    return undefined;
  }

  if (hasUriScheme(pathPart) || pathPart.startsWith('//')) {
    return undefined;
  }

  if (!MARKDOWN_TARGET.test(pathPart)) {
    return undefined;
  }

  const targetRelpath = joinPosix(dirnamePosix(context.currentRelpath), pathPart);

  if (context.packRelpaths.has(targetRelpath)) {
    return `pack:${targetRelpath}${fragment}`;
  }

  if (context.gitContext === undefined) {
    context.onUnrewrittenRelativeLink();
    return undefined;
  }

  const blobUrl = buildGithubBlobUrl(context.gitContext, targetRelpath, fragment);
  if (blobUrl === undefined) {
    context.onNonGithubRemote();
    return undefined;
  }

  return blobUrl;
}

function buildGithubBlobUrl(
  gitContext: MarkdownLinkGitContext,
  targetRelpath: string,
  fragment: string
): string | undefined {
  const repo = parseGithubRemote(gitContext.remoteUrl);
  if (repo === undefined) {
    return undefined;
  }

  const repoRelativePath = joinPosix(gitContext.sourceRootFromRepo, targetRelpath);
  return `https://github.com/${repo.org}/${repo.name}/blob/${gitContext.commit}/${repoRelativePath}${fragment}`;
}

function parseGithubRemote(remoteUrl: string | null): { org: string; name: string } | undefined {
  if (remoteUrl === null || remoteUrl.length === 0) {
    return undefined;
  }

  // git@github.com:org/repo(.git)
  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch?.[1] !== undefined && sshMatch[2] !== undefined) {
    return { org: sshMatch[1], name: sshMatch[2] };
  }

  // https://github.com/org/repo(.git) or ssh://git@github.com/org/repo(.git)
  const httpsMatch = remoteUrl.match(
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/
  );
  if (httpsMatch?.[1] !== undefined && httpsMatch[2] !== undefined) {
    return { org: httpsMatch[1], name: httpsMatch[2] };
  }

  return undefined;
}

function hasUriScheme(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function dirnamePosix(relpath: string): string {
  const slash = relpath.lastIndexOf('/');
  return slash === -1 ? '' : relpath.slice(0, slash);
}

/** Join and normalize POSIX path segments, resolving `.` and `..`. */
export function joinPosix(base: string, target: string): string {
  const segments = base.length === 0 ? [] : base.split('/');
  for (const raw of target.split('/')) {
    if (raw === '' || raw === '.') {
      continue;
    }
    if (raw === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') {
        segments.pop();
      } else {
        segments.push('..');
      }
      continue;
    }
    segments.push(raw);
  }
  return segments.join('/');
}
