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
 *  - Relative links to `.md`/`.mdx`/`.markdown` files are rewritten. Only `./`,
 *    `../`, and bare relative targets are eligible; a target starting with `/`
 *    is a documentation-SITE absolute path (not a repo/pack path) and is left
 *    unchanged. When an eligible target file is part of this pack, the link
 *    becomes `pack:<target-relpath>` (preserving any `#fragment`), which
 *    resolves to the section whose `[source: ...]` marker matches. When the
 *    target is outside the pack and a git context is available, it becomes the
 *    pinned permanent blob URL. With no git context, the link is left unchanged
 *    and counted.
 *  - In-page `#anchor` links are intentionally left unchanged. Titles are now
 *    preserved verbatim, so the heading text is directly greppable; a `pack:`
 *    target plus a grep on the heading is the resolution path. This is a known
 *    limitation: fragments are not rewritten to any explicit anchor scheme.
 *
 * The prose is walked by a single opaque-aware tokenizer rather than a stack of
 * regexes, so a link's TEXT is treated as opaque: it may contain inline code
 * (backticks), nested images, or nested brackets, and the rewrite decision
 * depends only on the link's TARGET. Inline code spans outside links are emitted
 * verbatim and never rewritten. Fenced code blocks never reach this function
 * (they are separate content blocks), which keeps the code-fidelity guarantee
 * intact.
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
  return rewriteSegment(text, definitions, context);
}

/**
 * A single link/image construct located by the tokenizer.
 *
 * `text` is the raw inner text of the outer brackets, captured opaquely (it may
 * contain backtick code spans, nested images, or nested brackets). `end` is the
 * index just past the whole construct in the source string.
 */
interface LinkMatch {
  isImage: boolean;
  text: string;
  end: number;
  kind: 'inline' | 'reference';
  // Inline links (`[text](url "title")`):
  url?: string;
  /** Title with its original leading whitespace and quotes, e.g. ` "t"`. */
  title?: string;
  // Reference links (`[text][label]`, `[text][]`, shortcut `[text]`):
  label?: string;
  isShortcut?: boolean;
  /** Exact original substring, emitted verbatim when a reference is unresolved. */
  raw?: string;
}

/**
 * Walk one prose string left to right, rewriting links/images while emitting
 * inline code spans and plain text verbatim. Recurses into link text so nested
 * constructs (e.g. an image reference inside a link's text) are also resolved.
 */
function rewriteSegment(
  text: string,
  definitions: Map<string, string>,
  context: LinkRewriteContext
): string {
  const out: string[] = [];
  let index = 0;
  const length = text.length;

  while (index < length) {
    const ch = text.charAt(index);

    if (ch === '`') {
      const spanEnd = codeSpanEnd(text, index);
      if (spanEnd !== -1) {
        // Inline code span: opaque, never rewritten.
        out.push(text.slice(index, spanEnd));
        index = spanEnd;
        continue;
      }
      out.push(ch);
      index += 1;
      continue;
    }

    if (ch === '\\' && index + 1 < length) {
      // Backslash escape (e.g. `\[`): emit both chars so an escaped bracket is
      // literal and never starts a link, per CommonMark.
      out.push(text.slice(index, index + 2));
      index += 2;
      continue;
    }

    if (ch === '[' || (ch === '!' && text[index + 1] === '[')) {
      const link = matchLink(text, index);
      if (link !== undefined) {
        out.push(renderLink(link, definitions, context));
        index = link.end;
        continue;
      }
    }

    out.push(ch);
    index += 1;
  }

  return out.join('');
}

/**
 * Return the index just past a code span opened at `start`, or -1 if the opening
 * backtick run has no matching closing run (in which case the backticks are
 * literal text, not a span).
 */
function codeSpanEnd(text: string, start: number): number {
  let runEnd = start;
  while (runEnd < text.length && text[runEnd] === '`') {
    runEnd += 1;
  }
  const runLength = runEnd - start;
  const closing = findClosingBacktickRun(text, runEnd, runLength);
  return closing === -1 ? -1 : closing + runLength;
}

/**
 * Match a link or image beginning at `start` (`[` or `![`). The link text is
 * captured opaquely: code spans, escapes, and nested `[...]` are skipped so a
 * `]` inside them does not prematurely close the text.
 */
function matchLink(text: string, start: number): LinkMatch | undefined {
  const isImage = text[start] === '!';
  const bracketOpen = isImage ? start + 1 : start;
  if (text[bracketOpen] !== '[') {
    return undefined;
  }

  const textClose = findClosingBracket(text, bracketOpen + 1);
  if (textClose === -1) {
    return undefined;
  }
  const innerText = text.slice(bracketOpen + 1, textClose);
  const afterText = textClose + 1;

  // Inline link `[text](url "title")`.
  if (text[afterText] === '(') {
    const dest = parseInlineDestination(text, afterText);
    if (dest !== undefined) {
      return {
        isImage,
        text: innerText,
        kind: 'inline',
        url: dest.url,
        title: dest.title,
        raw: text.slice(start, dest.end),
        end: dest.end,
      };
    }
    // Malformed destination: fall through and treat the leading `[text]` as a
    // shortcut reference (only inlined if a definition exists).
  }

  // Full/collapsed reference `[text][label]` / `[text][]`.
  if (text[afterText] === '[') {
    const labelClose = findClosingBracket(text, afterText + 1);
    if (labelClose !== -1) {
      const rawLabel = text.slice(afterText + 1, labelClose);
      const label = rawLabel.trim().length > 0 ? rawLabel : innerText;
      return {
        isImage,
        text: innerText,
        kind: 'reference',
        label,
        isShortcut: false,
        raw: text.slice(start, labelClose + 1),
        end: labelClose + 1,
      };
    }
    // A `[` with no closing `]`: fall through to a shortcut on the text bracket.
  }

  // Shortcut reference `[text]` (only inlined when a definition exists).
  return {
    isImage,
    text: innerText,
    kind: 'reference',
    label: innerText,
    isShortcut: true,
    raw: text.slice(start, textClose + 1),
    end: textClose + 1,
  };
}

/**
 * Find the index of the `]` that closes a bracket opened just before `from`,
 * tracking nested `[...]`, skipping code spans, and honoring `\` escapes.
 */
function findClosingBracket(text: string, from: number): number {
  let depth = 0;
  let index = from;
  while (index < text.length) {
    const ch = text[index];
    if (ch === '\\') {
      index += 2;
      continue;
    }
    if (ch === '`') {
      const spanEnd = codeSpanEnd(text, index);
      index = spanEnd === -1 ? index + 1 : spanEnd;
      continue;
    }
    if (ch === '[') {
      depth += 1;
      index += 1;
      continue;
    }
    if (ch === ']') {
      if (depth === 0) {
        return index;
      }
      depth -= 1;
      index += 1;
      continue;
    }
    index += 1;
  }
  return -1;
}

/**
 * Parse an inline destination `(url "title")` starting at the `(` index. Matches
 * the historical shape: a whitespace/`)`-free URL and an optional double-quoted
 * title. Returns undefined when the parentheses are not a well-formed
 * destination, so the caller can fall back to reference handling.
 */
function parseInlineDestination(
  text: string,
  open: number
): { url: string; title: string; end: number } | undefined {
  let index = open + 1;
  while (index < text.length && isSpace(text[index])) {
    index += 1;
  }
  const urlStart = index;
  while (index < text.length && !isSpace(text[index]) && text[index] !== ')') {
    index += 1;
  }
  if (index === urlStart) {
    return undefined;
  }
  const url = text.slice(urlStart, index);

  let title = '';
  let cursor = index;
  let whitespace = '';
  while (cursor < text.length && isSpace(text[cursor])) {
    whitespace += text[cursor];
    cursor += 1;
  }
  if (whitespace.length > 0 && text[cursor] === '"') {
    const closingQuote = text.indexOf('"', cursor + 1);
    if (closingQuote !== -1) {
      title = `${whitespace}${text.slice(cursor, closingQuote + 1)}`;
      index = closingQuote + 1;
    }
  }

  let tail = index;
  while (tail < text.length && isSpace(text[tail])) {
    tail += 1;
  }
  if (text[tail] !== ')') {
    return undefined;
  }
  return { url, title, end: tail + 1 };
}

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

/**
 * Render one matched link/image. The target drives every rewrite decision; the
 * text is recursively processed so nested images/code inside it are resolved
 * too. Images never have their destination rewritten (the pack rewrites `.md`
 * document links, not image assets).
 */
function renderLink(
  link: LinkMatch,
  definitions: Map<string, string>,
  context: LinkRewriteContext
): string {
  const prefix = link.isImage ? '!' : '';

  if (link.kind === 'inline') {
    const renderedText = rewriteSegment(link.text, definitions, context);
    const title = link.title ?? '';
    // Images never have their destination rewritten; a plain untouched link is
    // emitted from its exact original bytes so incidental spacing is preserved.
    if (link.isImage) {
      if (renderedText === link.text && link.raw !== undefined) {
        return link.raw;
      }
      return `${prefix}[${renderedText}](${link.url}${title})`;
    }
    const rewritten = rewriteRelativeMarkdownUrl(link.url ?? '', context);
    if (rewritten === undefined && renderedText === link.text && link.raw !== undefined) {
      return link.raw;
    }
    const url = rewritten === undefined ? link.url : rewritten;
    return `[${renderedText}](${url}${title})`;
  }

  const href = definitions.get(normalizeLabel(link.label ?? ''));
  if (href === undefined) {
    // Full/collapsed uses warn; a bare shortcut is ordinary bracketed text.
    if (link.isShortcut !== true) {
      context.onUnresolvedReference((link.label ?? '').trim());
    }
    return link.raw ?? '';
  }

  const renderedText = rewriteSegment(link.text, definitions, context);
  if (link.isImage) {
    return `${prefix}[${renderedText}](${href})`;
  }
  const rewritten = rewriteRelativeMarkdownUrl(href, context);
  const url = rewritten === undefined ? href : rewritten;
  return `[${renderedText}](${url})`;
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

/**
 * Rewrite one URL if it targets a relative markdown file. Returns undefined when
 * the URL must be left unchanged (absolute URL, protocol-relative URL, in-page
 * anchor, site-absolute path, non-markdown target, or an unrewritable external
 * target with no git context).
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

  if (pathPart.startsWith('/')) {
    // A leading single `/` is a documentation-SITE absolute path (e.g.
    // `/router/latest/docs/.../README.md`), not a repo/pack-relative path. It
    // must never be joined onto the section dir or pinned to a blob URL. Only
    // `./`, `../`, and bare relative targets are eligible for rewriting. Count a
    // site-absolute markdown target in the unrewritten-links warning.
    if (MARKDOWN_TARGET.test(pathPart)) {
      context.onUnrewrittenRelativeLink();
    }
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
