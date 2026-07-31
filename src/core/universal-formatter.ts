/**
 * Universal LLM Documentation Formatter
 *
 * Works with the unified DocNode IR to generate LLM-optimized documentation.
 * Format-agnostic - handles OpenRef, Markdown, and any future formats.
 *
 * Performance optimizations:
 * - String concatenation using array join (O(n) vs O(n²))
 * - Hierarchical numbering for precise navigation
 */

import { statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { writeTextFileSafely } from '../utils/safe-write.js';

import type { DocNode, ContentBlock } from './models.js';
import { DocNodeType, ContentBlockType } from './models.js';
import {
  rewriteProseLinks,
  type MarkdownLinkGitContext,
  type UnrewrittenLinkClass,
} from './markdown-links.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const NEWLINE = '\n';
const DOUBLE_NEWLINE = '\n\n';
const MAX_HEADING_LEVEL = 6;

// ============================================================================
// UNIVERSAL FORMATTER
// ============================================================================

/**
 * Git provenance passed to the formatter for the header stamp and for pinning
 * out-of-pack relative links. Structurally compatible with
 * `GenerateSourceGitContext` in source-docs.ts (kept local to avoid a circular
 * import).
 */
export interface FormatterGitContext {
  remoteUrl: string | null;
  commit: string;
  tags: string[];
  dirty: boolean;
  sourceRootFromRepo: string;
}

/**
 * Source-pack rendering context. Its presence switches on the local-source-pack
 * behaviors (header provenance stamp, per-section `[source:]` markers, link
 * rewriting, and the optional table-of-contents output). Absent for the
 * configured-SDK/OpenRef path, which keeps its existing output verbatim.
 */
export interface FormatterSourcePack {
  resolvedPath: string;
  label?: string;
  gitContext?: FormatterGitContext;
  packRelpaths: ReadonlySet<string>;
  emitToc: boolean;
  onWarning: (warning: string) => void;
}

export interface FormatterOptions {
  outputDir: string;
  filenamePrefix?: string;
  title?: string;
  systemPrompt?: string;
  includeMetadata?: boolean;
  sourcePack?: FormatterSourcePack;
}

interface FileRenderContext {
  relpath: string;
  linkDefinitions: Map<string, string>;
}

interface RenderContext {
  file: FileRenderContext | undefined;
  collectWarnings: boolean;
}

/**
 * Universal Formatter for DocNode IR
 *
 * Generates LLM-optimized documentation from any format
 */
export class UniversalFormatter {
  constructor(
    private readonly root: DocNode,
    private readonly options: FormatterOptions
  ) {}

  /**
   * Generate all documentation files
   *
   * Performance: O(n) where n = total nodes in tree
   */
  // Link-rewrite warning accumulators. Populated only on the canonical full-doc
  // render (category/TOC renders reuse the same nodes and must not double-count).
  private readonly unresolvedReferenceLabels = new Set<string>();
  private readonly unrewrittenLinkCounts: Record<UnrewrittenLinkClass, number> = {
    'site-absolute': 0,
    'unresolvable-relative': 0,
    'no-git-context': 0,
  };
  private nonGithubRemoteCount = 0;

  async generateAll(): Promise<string[]> {
    const outputDir = this.options.outputDir;
    await mkdir(outputDir, { recursive: true });

    // Generate full combined document (canonical pass: collects link warnings).
    const outputPaths = [await this.generateFullDoc()];

    // Generate modular documents by category (if applicable). Warning collection
    // is suppressed so the same nodes are not counted twice.
    outputPaths.push(...(await this.generateModularDocs()));

    if (this.options.sourcePack?.emitToc === true) {
      outputPaths.push(await this.generateTableOfContents());
    }

    this.flushLinkWarnings();

    return outputPaths;
  }

  private flushLinkWarnings(): void {
    const sourcePack = this.options.sourcePack;
    if (sourcePack === undefined) {
      return;
    }

    for (const label of [...this.unresolvedReferenceLabels].sort()) {
      sourcePack.onWarning(`Unresolved reference-link label with no definition: [${label}]`);
    }

    // Honest per-class breakdown of every doc cross-reference left unrewritten,
    // so the total can never undercount (the previous message only counted a
    // subset). Each nonzero class is named; a `.md` and an extension-less dead
    // link both land here.
    const siteAbsolute = this.unrewrittenLinkCounts['site-absolute'];
    const unresolvableRelative = this.unrewrittenLinkCounts['unresolvable-relative'];
    const noGitContext = this.unrewrittenLinkCounts['no-git-context'];
    const total = siteAbsolute + unresolvableRelative + noGitContext + this.nonGithubRemoteCount;
    if (total > 0) {
      const parts: string[] = [];
      if (siteAbsolute > 0) {
        parts.push(`${siteAbsolute} site-absolute`);
      }
      if (unresolvableRelative > 0) {
        parts.push(`${unresolvableRelative} unresolvable relative`);
      }
      if (noGitContext > 0) {
        parts.push(`${noGitContext} out-of-pack with no git context`);
      }
      if (this.nonGithubRemoteCount > 0) {
        parts.push(`${this.nonGithubRemoteCount} non-github remote`);
      }
      sourcePack.onWarning(`Left ${total} doc cross-reference(s) unrewritten: ${parts.join(', ')}`);
    }
  }

  /**
   * Generate full combined documentation
   */
  private async generateFullDoc(): Promise<string> {
    const prefix = sanitizeFileSegment(this.options.filenamePrefix || 'documentation');
    const filepath = join(this.options.outputDir, `${prefix}-full-llms.txt`);

    const parts: string[] = [];

    // Header
    parts.push(this.generateHeader());

    // Content
    parts.push(this.formatNode(this.root, [], { file: undefined, collectWarnings: true }));

    const content = parts.join('');

    // The full document is already materialized in memory, so streaming it
    // offers no memory benefit — write atomically for every size (temp + rename,
    // symlink-refusing) so a crash mid-write can't truncate the output and a
    // pre-existing symlink at the path is never followed.
    await writeTextFileSafely(filepath, content);

    return filepath;
  }

  /**
   * Reserved output basenames a category slice must never claim. These name
   * distinct generated artifacts: the combined `-full-llms.txt` (written before
   * the category pass) and, when emitted, the `-toc-llms.txt` table of contents
   * (written after it). A source directory literally named "full" or "toc" would
   * otherwise produce a category slice with an identical filename, so one file
   * would silently overwrite the other and the manifest would carry two
   * generatedOutputs entries for the same path.
   */
  private reservedOutputFilenames(prefix: string): Set<string> {
    const reserved = new Set<string>([`${prefix}-full-llms.txt`]);
    if (this.options.sourcePack?.emitToc === true) {
      reserved.add(`${prefix}-toc-llms.txt`);
    }
    return reserved;
  }

  /**
   * Generate modular documentation files (one per category)
   */
  private async generateModularDocs(): Promise<string[]> {
    // Find all CATEGORY nodes
    const categories = this.root.children.filter((child) => child.type === DocNodeType.CATEGORY);

    if (categories.length === 0) return [];

    const prefix = sanitizeFileSegment(this.options.filenamePrefix || 'documentation');
    const outputPaths: string[] = [];
    // Seed the dedup set with every reserved artifact name so a colliding
    // category is deterministically renamed via the same suffix mechanism used
    // for duplicate category ids (e.g. `${prefix}-toc-2-llms.txt`) instead of
    // overwriting the reserved artifact.
    const reservedFilenames = this.reservedOutputFilenames(prefix);
    const usedFilenames = new Set(reservedFilenames);

    // Generate file for each category
    for (const category of categories) {
      const baseName = `${prefix}-${sanitizeFileSegment(category.id)}`;
      const naturalFilename = `${baseName}-llms.txt`;
      const filename = uniqueFilename(baseName, '-llms.txt', usedFilenames);

      // Only warn when the natural name was claimed by a RESERVED artifact (not
      // by a sibling category), because that is the collision that would have
      // silently destroyed an artifact before this guard.
      if (filename !== naturalFilename && reservedFilenames.has(naturalFilename)) {
        this.options.sourcePack?.onWarning(
          `Category slice "${naturalFilename}" collides with the reserved ${reservedArtifactRole(naturalFilename, prefix)} output; renamed to "${filename}".`
        );
      }

      const filepath = join(this.options.outputDir, filename);

      const parts: string[] = [];

      // System prompt for category
      parts.push(this.generateCategoryHeader(category));

      // Format category content (warnings already collected on the full pass)
      parts.push(this.formatNode(category, [], { file: undefined, collectWarnings: false }));

      await writeTextFileSafely(filepath, parts.join(''));
      outputPaths.push(filepath);
    }

    return outputPaths;
  }

  /**
   * Generate document header with metadata
   */
  private generateHeader(): string {
    const parts: string[] = [];

    // System prompt (stamped with provenance for local source packs)
    parts.push(`<SYSTEM>${this.buildSystemPrompt()}</SYSTEM>`, DOUBLE_NEWLINE);

    // Metadata. No generation date: it would make repeated runs over identical
    // input produce different bytes (and vary by locale and timezone).
    if (this.options.includeMetadata !== false) {
      const format = this.root.metadata.get('format') || 'unknown';
      parts.push(`<!-- Format: ${format} -->`, DOUBLE_NEWLINE);
    }

    // Title
    const title = this.options.title || this.root.title;
    parts.push(`# ${title}`, DOUBLE_NEWLINE);

    return parts.join('');
  }

  /**
   * Build the SYSTEM prompt. For local source packs the first line carries the
   * source path and, when provided, the operator label and pinned git
   * provenance (remote, commit, tags), so the pack is self-describing.
   */
  private buildSystemPrompt(): string {
    const sourcePack = this.options.sourcePack;
    const base =
      this.options.systemPrompt ||
      (sourcePack !== undefined
        ? `This is a local source documentation pack generated from ${sourcePack.resolvedPath}.`
        : `This is the complete developer documentation for ${this.options.title || this.root.title}.`);

    if (sourcePack === undefined) {
      return base;
    }
    return this.appendProvenance(base);
  }

  /**
   * Append the pack's provenance segments (operator label + pinned git
   * remote@commit with tags/dirty flags) to a base SYSTEM sentence. Used by the
   * full doc, every category slice, and the TOC so each generated output is
   * self-describing and an agent loading only one file can still state the
   * version. Returns the base unchanged when no provenance is available.
   */
  private appendProvenance(base: string): string {
    const segments = this.provenanceSegments();
    if (segments.length === 0) {
      return base;
    }
    return `${base.replace(/\.\s*$/, '')} | ${segments.join(' | ')}`;
  }

  private provenanceSegments(): string[] {
    const sourcePack = this.options.sourcePack;
    if (sourcePack === undefined) {
      return [];
    }
    const segments: string[] = [];
    if (sourcePack.label !== undefined && sourcePack.label.length > 0) {
      segments.push(`label: ${sourcePack.label}`);
    }
    const git = sourcePack.gitContext;
    if (git !== undefined) {
      let gitSegment =
        git.remoteUrl !== null && git.remoteUrl.length > 0
          ? `source: ${git.remoteUrl}@${git.commit}`
          : `commit: ${git.commit}`;
      if (git.tags.length > 0) {
        gitSegment += ` (tags: ${git.tags.join(', ')})`;
      }
      if (git.dirty) {
        gitSegment += ' (dirty)';
      }
      segments.push(gitSegment);
    }
    return segments;
  }

  /**
   * Generate category-specific header
   */
  private generateCategoryHeader(category: DocNode): string {
    const parts: string[] = [];

    const title = this.options.title || this.root.title;
    // Stamp the same provenance (label + git remote@commit) that the full doc
    // carries so a slice loaded on its own is self-describing and version-stated.
    const systemPrompt = this.appendProvenance(
      `This is the developer documentation for ${title} - ${category.title}.`
    );
    parts.push(`<SYSTEM>${systemPrompt}</SYSTEM>`, DOUBLE_NEWLINE);

    parts.push(`# ${title} ${category.title} Documentation`, DOUBLE_NEWLINE);

    if (category.description) {
      parts.push(category.description, DOUBLE_NEWLINE);
    }

    return parts.join('');
  }

  /**
   * Format a DocNode and its children with hierarchical numbering
   *
   * @param node - Node to format
   * @param numbers - Hierarchical number path (e.g., [1, 2, 3] for 1.2.3)
   * @returns Formatted string
   */
  private formatNode(node: DocNode, numbers: number[], ctx: RenderContext): string {
    const parts: string[] = [];

    // A node with a source relpath opens a new file context: its `[source:]`
    // marker anchors links, and its captured reference definitions and relpath
    // apply to itself and all descendants until a deeper file context replaces
    // them.
    const nodeCtx = this.enterFileContext(node, ctx);

    // For ROOT nodes, don't format the node itself, just children
    if (node.type === DocNodeType.ROOT) {
      let childNum = 1;
      for (const child of node.children) {
        parts.push(this.formatNode(child, [childNum], nodeCtx));
        childNum++;
      }
      return parts.join('');
    }

    // The document or category header already names a top-level non-root node.
    if (numbers.length > 0) {
      const numberString = numbers.join('.');
      const heading = this.getHeading(node.type, numbers.length);
      const sourceRelpath = this.sourceRelpathOf(node);
      if (sourceRelpath !== undefined) {
        // Marker immediately follows the section heading, greppable via ^\[source:
        parts.push(
          `${heading} ${numberString}. ${node.title}`,
          NEWLINE,
          `[source: ${sourceRelpath}]`,
          DOUBLE_NEWLINE
        );
      } else {
        parts.push(`${heading} ${numberString}. ${node.title}`, DOUBLE_NEWLINE);
      }
    }

    // Format description as prose if present
    if (node.description) {
      parts.push(this.rewriteProse(node.description, nodeCtx), DOUBLE_NEWLINE);
    }

    // Format content blocks
    for (const content of node.content) {
      parts.push(this.formatContent(content, nodeCtx));
    }

    // Format children recursively
    let childNum = 1;
    for (const child of node.children) {
      const childNumbers = [...numbers, childNum];
      parts.push(this.formatNode(child, childNumbers, nodeCtx));
      childNum++;
    }

    return parts.join('');
  }

  private sourceRelpathOf(node: DocNode): string | undefined {
    const relpath = node.metadata.get('sourceRelPath');
    return typeof relpath === 'string' && relpath.length > 0 ? relpath : undefined;
  }

  private enterFileContext(node: DocNode, ctx: RenderContext): RenderContext {
    const relpath = this.sourceRelpathOf(node);
    if (relpath === undefined) {
      return ctx;
    }
    return {
      collectWarnings: ctx.collectWarnings,
      file: {
        relpath,
        linkDefinitions: readLinkDefinitions(node),
      },
    };
  }

  private rewriteProse(text: string, ctx: RenderContext): string {
    const sourcePack = this.options.sourcePack;
    if (sourcePack === undefined || ctx.file === undefined) {
      return text;
    }
    const collect = ctx.collectWarnings;
    return rewriteProseLinks(text, {
      currentRelpath: ctx.file.relpath,
      packRelpaths: sourcePack.packRelpaths,
      linkDefinitions: ctx.file.linkDefinitions,
      ...(sourcePack.gitContext === undefined
        ? {}
        : { gitContext: toLinkGitContext(sourcePack.gitContext) }),
      fileExistsInRepo: (relpath) => this.repoFileExists(sourcePack, relpath),
      onUnresolvedReference: (label) => {
        if (collect) {
          this.unresolvedReferenceLabels.add(label);
        }
      },
      onUnrewrittenLink: (kind) => {
        if (collect) {
          this.unrewrittenLinkCounts[kind] += 1;
        }
      },
      onNonGithubRemote: () => {
        if (collect) {
          this.nonGithubRemoteCount += 1;
        }
      },
    });
  }

  /**
   * Existence oracle for out-of-pack resolution, covering every doc target
   * shape (explicit `.md` and extension-less alike). Resolves a source-root-
   * relative candidate to an absolute path and reports whether a regular file
   * lives there, constrained to within the repo (or, absent git context, within
   * the source root) so a `../`-escaping target can never probe arbitrary disk
   * locations. Only targets this oracle proves to exist are pinned; the link
   * rewriter additionally refuses to build a blob URL for any path that
   * escapes the repo root, independent of this containment.
   */
  private repoFileExists(sourcePack: FormatterSourcePack, relpath: string): boolean {
    const containmentRoot = this.diskContainmentRoot(sourcePack);
    const absolute = resolve(sourcePack.resolvedPath, relpath);
    if (absolute !== containmentRoot && !absolute.startsWith(`${containmentRoot}${sep}`)) {
      return false;
    }
    try {
      return statSync(absolute).isFile();
    } catch {
      return false;
    }
  }

  /**
   * The directory that on-disk extension-less resolution is confined to: the
   * repo root when git context pins the source root within a repo, otherwise the
   * source root itself.
   */
  private diskContainmentRoot(sourcePack: FormatterSourcePack): string {
    const git = sourcePack.gitContext;
    if (git === undefined) {
      return resolve(sourcePack.resolvedPath);
    }
    const depth = git.sourceRootFromRepo.split('/').filter((s) => s.length > 0 && s !== '.');
    const upFromSource = depth.length === 0 ? '.' : depth.map(() => '..').join('/');
    return resolve(sourcePack.resolvedPath, upFromSource);
  }

  /**
   * Get markdown heading prefix based on node type and depth. The relative
   * heading structure of each source file is preserved by tree depth; the `#`
   * run is clamped at H6 while the hierarchical numbering keeps going.
   */
  private getHeading(_type: DocNodeType, depth: number): string {
    const level = Math.min(depth + 1, MAX_HEADING_LEVEL);
    return '#'.repeat(level);
  }

  /**
   * Format a content block
   */
  private formatContent(content: ContentBlock, ctx: RenderContext): string {
    const parts: string[] = [];

    switch (content.type) {
      case ContentBlockType.PROSE:
        parts.push(this.rewriteProse(content.content, ctx), DOUBLE_NEWLINE);
        break;

      case ContentBlockType.CODE: {
        // Reproduce the source fence info string byte-verbatim: undefined means a
        // legacy block with no recorded info string (rendered as `text`), an
        // empty string means a genuinely bare fence, anything else is emitted
        // exactly. Use a fence longer than any backtick run in the content so
        // embedded ``` fences cannot terminate it prematurely.
        const info = content.language === undefined ? 'text' : content.language;
        const longestBacktickRun = (content.content.match(/`+/g) ?? []).reduce(
          (max, run) => Math.max(max, run.length),
          0
        );
        const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
        parts.push(fence, info, NEWLINE);
        parts.push(content.content, NEWLINE);
        parts.push(fence, DOUBLE_NEWLINE);
        break;
      }

      case ContentBlockType.DATA: {
        // Data block (SQL, JSON, etc.) as inline comment
        const dataType = content.annotations?.get('type') || 'data';
        parts.push(NEWLINE, `// ${dataType}`, NEWLINE);
        parts.push('/*', NEWLINE);
        parts.push(content.content, NEWLINE);
        parts.push('*/', NEWLINE, NEWLINE);
        break;
      }
    }

    return parts.join('');
  }

  /**
   * Generate the table-of-contents output: the hierarchical heading tree with
   * numbering and, for each file section, its `[source: relpath]` marker. This
   * is a distinct `<prefix>-toc-llms.txt` file and never replaces an
   * agent-authored `index.md`.
   */
  private async generateTableOfContents(): Promise<string> {
    const prefix = sanitizeFileSegment(this.options.filenamePrefix || 'documentation');
    const filepath = join(this.options.outputDir, `${prefix}-toc-llms.txt`);

    const title = this.options.title || this.root.title;
    const hasSlices = this.root.children.some((child) => child.type === DocNodeType.CATEGORY);
    const navSentence = hasSlices
      ? `Each entry lists the heading number, title, and, for file sections, its [source: path]. Load the matching per-topic slice ("<topic>-llms.txt") to read a section, or grep its [source: path] within that slice. Slices duplicate the full pack — load a slice or the full file, never both.`
      : 'Each entry lists the heading number, title, and, for file sections, the [source: path] to grep in the full pack.';
    const tocSystemPrompt = this.appendProvenance(`Table of contents for ${title}. ${navSentence}`);
    const lines: string[] = [
      `<SYSTEM>${tocSystemPrompt}</SYSTEM>`,
      '',
      `# ${title} Table of Contents`,
      '',
    ];
    this.collectTocLines(this.root, [], lines);

    const content = `${lines.join(NEWLINE)}${NEWLINE}`;
    await writeTextFileSafely(filepath, content);
    return filepath;
  }

  private collectTocLines(node: DocNode, numbers: number[], lines: string[]): void {
    if (node.type !== DocNodeType.ROOT && numbers.length > 0) {
      const indent = '  '.repeat(numbers.length - 1);
      const numberString = numbers.join('.');
      const sourceRelpath = this.sourceRelpathOf(node);
      const suffix = sourceRelpath === undefined ? '' : ` [source: ${sourceRelpath}]`;
      lines.push(`${indent}${numberString}. ${node.title}${suffix}`);
    }

    let childNum = 1;
    for (const child of node.children) {
      this.collectTocLines(child, [...numbers, childNum], lines);
      childNum += 1;
    }
  }
}

function readLinkDefinitions(node: DocNode): Map<string, string> {
  const definitions = new Map<string, string>();
  const raw = node.metadata.get('linkDefinitions');
  if (raw === null || typeof raw !== 'object') {
    return definitions;
  }
  for (const [label, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value !== null && typeof value === 'object' && 'href' in value) {
      const href = (value as { href?: unknown }).href;
      if (typeof href === 'string' && href.length > 0) {
        definitions.set(label, href);
      }
    }
  }
  return definitions;
}

function toLinkGitContext(git: FormatterGitContext): MarkdownLinkGitContext {
  return {
    remoteUrl: git.remoteUrl,
    commit: git.commit,
    sourceRootFromRepo: git.sourceRootFromRepo,
  };
}

/**
 * Format DocNode tree (convenience function)
 */
export async function formatDocNode(root: DocNode, options: FormatterOptions): Promise<string[]> {
  const formatter = new UniversalFormatter(root, options);
  return await formatter.generateAll();
}

function sanitizeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'documentation';
}

/**
 * Human-readable role of the reserved artifact a category slice collided with,
 * used only to phrase the rename warning. Reserved names are exactly the
 * combined `-full` file and the optional `-toc` table of contents.
 */
function reservedArtifactRole(filename: string, prefix: string): string {
  return filename === `${prefix}-toc-llms.txt` ? 'table-of-contents' : 'combined full-document';
}

function uniqueFilename(baseName: string, extension: string, usedFilenames: Set<string>): string {
  let suffix = 1;
  let filename = `${baseName}${extension}`;

  while (usedFilenames.has(filename)) {
    suffix++;
    filename = `${baseName}-${suffix}${extension}`;
  }

  usedFilenames.add(filename);
  return filename;
}
