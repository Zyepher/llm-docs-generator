/**
 * reStructuredText parser foundation.
 *
 * This parser intentionally supports a deterministic subset suitable for
 * Python-style docs. It does not execute directives, resolve includes, fetch
 * remote content, or claim full docutils/Sphinx compatibility.
 *
 * Inline markup coverage: interpreted-text roles are rendered readably
 * (code-referencing roles as backticked targets with Sphinx `~` display
 * semantics, :ref:/:doc: as their link text), `.. |name| replace::` single
 * line substitution definitions are collected and applied in one pass (a
 * substitution whose value contains another |ref| is left as-is, no
 * recursive expansion), and hyperlink references become markdown links when
 * an http(s) or relative target is known from the same document. URLs are
 * never invented; unresolved references degrade to their plain text.
 */

import { lstat, readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import {
  ContentBlockType,
  DocNodeType,
  createContentBlock,
  createDocNode,
  type ContentBlock,
  type DocNode,
} from '../../core/models.js';
import { slugifyAscii } from '../../utils/slug.js';
import { ParserError } from '../base.js';

const SECTION_ADORNMENT_PATTERN = /^([=\-~^"`'#*+_:.<>])\1*\s*$/;
const BULLET_PATTERN = /^\s*[-+*]\s+\S/;
const ENUMERATED_PATTERN = /^\s*(?:\d+|[A-Za-z]|[ivxlcdmIVXLCDM]+|#)[.)]\s+\S/;
const DIRECTIVE_PATTERN = /^\s*\.\.\s+([A-Za-z][\w-]*)::\s*(.*)$/;
// Explicit-markup marker: `..` followed by whitespace or end of line. Lines
// matching this but not DIRECTIVE_PATTERN (comments, hyperlink targets,
// substitution definitions, footnote/citation targets) are consumed silently
// like docutils comments, including their indented continuation block.
const EXPLICIT_MARKUP_PATTERN = /^\s*\.\.(?:\s|$)/;
const CODE_DIRECTIVES = new Set(['code-block', 'code']);
const SUBSTITUTION_DEF_PATTERN = /^\s*\.\.\s+\|([^|]+)\|\s+replace::\s*(.*)$/;
const HYPERLINK_TARGET_PATTERN = /^\s*\.\.\s+_([^:`]+):\s*(.*)$/;
// Role names may be domain-prefixed (py:func, c:macro); match through colons
// and dots, then key behavior off the last segment.
const ROLE_PATTERN = /:([A-Za-z][\w+.:-]*):`([^`]+)`/g;
const INLINE_LINK_PATTERN = /`([^`<>]*\S)\s+<([^`<>\s]+)>`__?/g;
const NAMED_REFERENCE_PATTERN = /`([^`]+)`__?/g;
const SUBSTITUTION_USE_PATTERN = /\|([^|\s][^|]*)\|/g;

export interface RstDocument {
  path: string;
  title: string;
  content: ContentBlock[];
  children: DocNode[];
  metadata: Map<string, unknown>;
}

interface RstParserWarning {
  message: string;
  line: number;
}

interface ParsedRst {
  title: string;
  content: ContentBlock[];
  sections: RstSection[];
  warnings: RstParserWarning[];
}

interface RstSection {
  level: number;
  title: string;
  id: string;
  content: ContentBlock[];
  children: RstSection[];
}

interface SectionHeading {
  title: string;
  adornment: string;
  linesConsumed: number;
}

interface Directive {
  name: string;
  argument: string;
}

export class RstParser {
  constructor(private readonly filePath: string) {}

  async parse(): Promise<RstDocument> {
    const raw = await readFile(this.filePath, 'utf-8');
    const parsed = this.parseContent(raw.replace(/^\uFEFF/, ''));
    const metadata = new Map<string, unknown>([
      ['format', 'rst'],
      ['sourcePath', this.filePath],
      ['parser', 'rst-subset'],
      [
        'parserDetails',
        {
          subset:
            'underline headings, paragraphs, simple lists, literal blocks, code directives, interpreted-text roles, single-line replace substitutions, hyperlink references',
          unsupportedDirectives:
            'warned and preserved as prose where safe; includes are not executed',
        },
      ],
      ['warnings', parsed.warnings],
    ]);

    const rootTitle = parsed.title || basename(this.filePath).replace(/\.rst$/i, '');

    return {
      path: this.filePath,
      title: rootTitle,
      content: parsed.content,
      children: parsed.sections.map((section) => this.sectionToDocNode(section)),
      metadata,
    };
  }

  private parseContent(content: string): ParsedRst {
    const lines = content.replace(/\r\n?/g, '\n').split('\n');
    const rootContent: ContentBlock[] = [];
    const rootSections: RstSection[] = [];
    const stack: RstSection[] = [];
    const sectionLevels = new Map<string, number>();
    const warnings: RstParserWarning[] = [];
    let title = '';
    let index = 0;

    const inlineContext = collectInlineContext(lines);
    const render = (text: string): string => renderInlineMarkup(text, inlineContext);
    const currentContent = (): ContentBlock[] => stack.at(-1)?.content ?? rootContent;

    while (index < lines.length) {
      if (isBlank(lines[index])) {
        index += 1;
        continue;
      }

      const heading = this.readHeading(lines, index);
      if (heading !== null) {
        const level = getOrCreateLevel(sectionLevels, heading.adornment);
        const headingTitle = render(heading.title);
        if (title === '' && level === 1) {
          title = headingTitle;
          index += heading.linesConsumed;
          continue;
        }

        const section: RstSection = {
          level,
          title: headingTitle,
          id: slugifyAscii(headingTitle),
          content: [],
          children: [],
        };

        while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= level) {
          stack.pop();
        }

        const parent = stack.at(-1);
        if (parent === undefined) {
          rootSections.push(section);
        } else {
          parent.children.push(section);
        }
        stack.push(section);
        index += heading.linesConsumed;
        continue;
      }

      const directive = this.readDirective(lines[index] ?? '');
      if (directive !== null) {
        const parsedDirective = this.parseDirective(lines, index, directive, warnings, render);
        currentContent().push(...parsedDirective.blocks);
        index = parsedDirective.nextIndex;
        continue;
      }

      if (EXPLICIT_MARKUP_PATTERN.test(lines[index] ?? '')) {
        // Not a directive (checked above), so this is a comment, hyperlink
        // target, substitution definition, or footnote/citation target.
        index = this.skipExplicitMarkupBlock(lines, index);
        continue;
      }

      if (BULLET_PATTERN.test(lines[index] ?? '') || ENUMERATED_PATTERN.test(lines[index] ?? '')) {
        const parsedList = this.parseList(lines, index);
        currentContent().push(
          createContentBlock(ContentBlockType.PROSE, render(parsedList.content))
        );
        index = parsedList.nextIndex;
        continue;
      }

      const paragraph = this.parseParagraph(lines, index);
      const literalBody = paragraph.literalBlock;
      if (literalBody !== undefined) {
        // The paragraph ended with `::`. Emit the prose with the standard
        // `::` -> `:` cleanup, and a literal code block ONLY when an actual
        // indented body followed. An empty body must not produce a spurious
        // empty code block (and a lone `::` paragraph is dropped entirely).
        const prose = paragraph.content.replace(/::\s*$/, ':').trim();
        if (prose !== '' && prose !== ':') {
          currentContent().push(createContentBlock(ContentBlockType.PROSE, render(prose)));
        }
        if (literalBody !== '') {
          currentContent().push(
            createContentBlock(ContentBlockType.CODE, literalBody, { language: 'text' })
          );
        }
      } else if (paragraph.content !== '') {
        currentContent().push(
          createContentBlock(ContentBlockType.PROSE, render(paragraph.content))
        );
      }
      index = paragraph.nextIndex;
    }

    return { title, content: rootContent, sections: rootSections, warnings };
  }

  private readHeading(lines: string[], index: number): SectionHeading | null {
    const overlined = this.readOverlinedHeading(lines, index);
    if (overlined !== null) {
      return overlined;
    }

    const title = lines[index]?.trim();
    const underline = lines[index + 1]?.trim();

    if (title === undefined || title === '' || underline === undefined) {
      return null;
    }

    const match = underline.match(SECTION_ADORNMENT_PATTERN);
    if (match?.[1] === undefined) {
      return null;
    }

    if (underline.length < title.length) {
      return null;
    }

    return { title, adornment: match[1], linesConsumed: 2 };
  }

  private readOverlinedHeading(lines: string[], index: number): SectionHeading | null {
    const overline = lines[index]?.trim();
    const title = lines[index + 1]?.trim();
    const underline = lines[index + 2]?.trim();

    if (overline === undefined || title === undefined || title === '' || underline === undefined) {
      return null;
    }

    const overMatch = overline.match(SECTION_ADORNMENT_PATTERN);
    const underMatch = underline.match(SECTION_ADORNMENT_PATTERN);
    if (overMatch?.[1] === undefined || overMatch[1] !== underMatch?.[1]) {
      return null;
    }

    if (overline.length < title.length || underline.length < title.length) {
      return null;
    }

    // Docutils treats an overlined style as a different section level from
    // the same character used underline-only, so key the level registry with
    // a distinct prefix.
    return { title, adornment: `over:${overMatch[1]}`, linesConsumed: 3 };
  }

  private readDirective(line: string): Directive | null {
    const match = line.match(DIRECTIVE_PATTERN);
    if (match?.[1] === undefined) {
      return null;
    }

    return {
      name: match[1].toLowerCase(),
      argument: match[2]?.trim() ?? '',
    };
  }

  private parseDirective(
    lines: string[],
    index: number,
    directive: Directive,
    warnings: RstParserWarning[],
    render: (text: string) => string
  ): { blocks: ContentBlock[]; nextIndex: number } {
    const body = this.readIndentedBody(lines, index + 1);

    if (CODE_DIRECTIVES.has(directive.name)) {
      const code = stripDirectiveOptions(body.lines).join('\n').trimEnd();
      return {
        blocks: [
          createContentBlock(ContentBlockType.CODE, code, {
            language: directive.argument || 'text',
          }),
        ],
        nextIndex: body.nextIndex,
      };
    }

    const message =
      directive.name === 'include'
        ? `Unsupported RST include directive not executed: ${directive.argument || '(no target)'}`
        : `Unsupported RST directive preserved as prose where safe: ${directive.name}`;
    warnings.push({ message, line: index + 1 });

    const safeBody = body.lines
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith(':'))
      .join(' ')
      .trim();
    const content =
      directive.name === 'include'
        ? message
        : [message, render(directive.argument), render(safeBody)].filter(Boolean).join('\n');

    return {
      blocks: [createContentBlock(ContentBlockType.PROSE, content)],
      nextIndex: body.nextIndex,
    };
  }

  private parseList(lines: string[], index: number): { content: string; nextIndex: number } {
    const output: string[] = [];
    let cursor = index;

    while (cursor < lines.length) {
      const line = lines[cursor] ?? '';
      if (isBlank(line)) {
        const nextLine = lines[cursor + 1] ?? '';
        if (BULLET_PATTERN.test(nextLine) || ENUMERATED_PATTERN.test(nextLine)) {
          output.push('');
          cursor += 1;
          continue;
        }
        break;
      }

      if (
        output.length > 0 &&
        !BULLET_PATTERN.test(line) &&
        !ENUMERATED_PATTERN.test(line) &&
        !/^\s{2,}\S/.test(line)
      ) {
        break;
      }

      output.push(line.trim());
      cursor += 1;
    }

    return {
      content: output.join('\n').trim(),
      nextIndex: cursor,
    };
  }

  private parseParagraph(
    lines: string[],
    index: number
  ): { content: string; literalBlock?: string; nextIndex: number } {
    const paragraphLines: string[] = [];
    let cursor = index;

    while (cursor < lines.length) {
      const line = lines[cursor] ?? '';
      if (
        isBlank(line) ||
        this.readHeading(lines, cursor) !== null ||
        EXPLICIT_MARKUP_PATTERN.test(line) ||
        BULLET_PATTERN.test(line) ||
        ENUMERATED_PATTERN.test(line)
      ) {
        break;
      }
      paragraphLines.push(line.trim());
      cursor += 1;
    }

    const content = paragraphLines.join(' ').trim();
    if (!content.endsWith('::')) {
      return { content, nextIndex: cursor };
    }

    const literal = this.readLiteralBlock(lines, cursor);
    return {
      content,
      literalBlock: literal.lines.join('\n').trimEnd(),
      nextIndex: literal.nextIndex,
    };
  }

  private skipExplicitMarkupBlock(lines: string[], index: number): number {
    const markerIndent = countIndent(lines[index] ?? '');
    let cursor = index + 1;

    while (cursor < lines.length) {
      const line = lines[cursor] ?? '';
      if (isBlank(line)) {
        cursor += 1;
        continue;
      }
      if (countIndent(line) <= markerIndent) {
        break;
      }
      cursor += 1;
    }

    return cursor;
  }

  private readLiteralBlock(lines: string[], index: number): { lines: string[]; nextIndex: number } {
    let cursor = index;
    while (cursor < lines.length && isBlank(lines[cursor])) {
      cursor += 1;
    }
    return this.readIndentedBody(lines, cursor);
  }

  private readIndentedBody(lines: string[], index: number): { lines: string[]; nextIndex: number } {
    const body: string[] = [];
    let cursor = index;
    let minimumIndent: number | null = null;

    while (cursor < lines.length) {
      const line = lines[cursor] ?? '';
      if (isBlank(line)) {
        body.push('');
        cursor += 1;
        continue;
      }

      const indent = countIndent(line);
      if (indent === 0) {
        break;
      }

      minimumIndent = minimumIndent === null ? indent : Math.min(minimumIndent, indent);
      body.push(line);
      cursor += 1;
    }

    const trimIndent = minimumIndent ?? 0;
    return {
      lines: body.map((line) => (line.trim() === '' ? '' : line.slice(trimIndent))),
      nextIndex: cursor,
    };
  }

  private sectionToDocNode(section: RstSection): DocNode {
    let type = DocNodeType.SECTION;
    if (section.level === 2) {
      type = DocNodeType.CATEGORY;
    } else if (section.level === 3) {
      type = DocNodeType.OPERATION;
    } else if (section.level >= 4) {
      type = DocNodeType.ITEM;
    }

    return createDocNode(type, section.id, section.title, {
      content: section.content,
      children: section.children.map((child) => this.sectionToDocNode(child)),
      metadata: new Map([['level', section.level]]),
    });
  }
}

interface InlineContext {
  substitutions: Map<string, string>;
  linkTargets: Map<string, string>;
}

function collectInlineContext(lines: string[]): InlineContext {
  const substitutions = new Map<string, string>();
  const linkTargets = new Map<string, string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';

    const substitution = line.match(SUBSTITUTION_DEF_PATTERN);
    if (substitution?.[1] !== undefined) {
      substitutions.set(substitution[1].trim(), (substitution[2] ?? '').trim());
      continue;
    }

    const target = line.match(HYPERLINK_TARGET_PATTERN);
    if (target?.[1] !== undefined) {
      let url = (target[2] ?? '').trim();
      if (url === '') {
        // Docutils allows the URL on the next indented line.
        const next = lines[index + 1] ?? '';
        if (!isBlank(next) && countIndent(next) > countIndent(line)) {
          url = next.trim();
        }
      }
      // Skip anchors (no URL) and indirect targets (`.. _a: b_`); references
      // to them degrade to plain text at render time.
      if (url !== '' && !url.endsWith('_')) {
        linkTargets.set(target[1].trim().toLowerCase(), url);
      }
    }
  }

  return { substitutions, linkTargets };
}

function renderInlineMarkup(text: string, context: InlineContext): string {
  // Split out ``inline literals`` so their contents are never rewritten.
  return text
    .split(/(``[^`]+``)/)
    .map((segment) =>
      segment.startsWith('``') && segment.endsWith('``')
        ? segment
        : renderInlineSegment(segment, context)
    )
    .join('');
}

function renderInlineSegment(text: string, context: InlineContext): string {
  let result = text.replace(
    SUBSTITUTION_USE_PATTERN,
    (whole, name: string) => context.substitutions.get(name.trim()) ?? whole
  );

  result = result.replace(ROLE_PATTERN, (_whole, roleName: string, target: string) => {
    const role = roleName.split(':').at(-1)?.toLowerCase() ?? '';
    const explicit = target.match(/^(.*\S)\s*<([^<>]+)>$/);
    const label = explicit?.[1]?.trim();
    const bareTarget = (explicit?.[2] ?? target).trim();
    if (role === 'ref' || role === 'doc') {
      // Cross-references carry no resolvable URL here; keep the readable text.
      return label ?? bareTarget;
    }
    if (label !== undefined) {
      return `\`${label}\``;
    }
    // Sphinx `~` display semantics: show only the last dotted segment.
    const display = bareTarget.startsWith('~')
      ? (bareTarget.slice(1).split('.').at(-1) ?? bareTarget.slice(1))
      : bareTarget;
    return `\`${display}\``;
  });

  result = result.replace(INLINE_LINK_PATTERN, (_whole, label: string, url: string) =>
    isRenderableUrl(url) ? `[${label.trim()}](${url})` : label.trim()
  );

  result = result.replace(NAMED_REFERENCE_PATTERN, (_whole, label: string) => {
    const url = context.linkTargets.get(label.trim().toLowerCase());
    return url !== undefined && isRenderableUrl(url) ? `[${label.trim()}](${url})` : label.trim();
  });

  return result;
}

function isRenderableUrl(url: string): boolean {
  if (/\s/.test(url)) {
    return false;
  }
  if (/^https?:\/\//i.test(url)) {
    return true;
  }
  // A scheme other than http(s) (mailto:, ftp:, javascript:) is rejected;
  // scheme-less values are treated as relative URLs.
  return !/^[a-z][a-z0-9+.-]*:/i.test(url);
}

function getOrCreateLevel(levels: Map<string, number>, adornment: string): number {
  const existing = levels.get(adornment);
  if (existing !== undefined) {
    return existing;
  }

  const level = levels.size + 1;
  levels.set(adornment, level);
  return level;
}

function stripDirectiveOptions(lines: string[]): string[] {
  let index = 0;
  while (index < lines.length) {
    const trimmed = lines[index]?.trim() ?? '';
    if (trimmed === '') {
      index += 1;
      continue;
    }
    if (!trimmed.startsWith(':')) {
      break;
    }
    index += 1;
  }
  return lines.slice(index);
}

function countIndent(line: string): number {
  // Count the full leading-whitespace run (spaces AND tabs) in characters.
  // Tabs were previously ignored, so tab-indented literal/directive bodies
  // measured as indent 0 and were silently dropped. Counting characters keeps
  // this consistent with the char-based `line.slice(trimIndent)` in
  // readIndentedBody.
  const match = line.match(/^[ \t]*/);
  return match?.[0].length ?? 0;
}

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim() === '';
}

export async function parseRstFile(filePath: string): Promise<RstDocument> {
  const stats = await lstat(filePath);
  if (!stats.isFile()) {
    throw new ParserError(`Invalid RST file path: ${filePath}`, 'reStructuredText Parser');
  }

  if (!/\.rst$/i.test(filePath)) {
    throw new ParserError(`Unsupported RST file extension: ${filePath}`, 'reStructuredText Parser');
  }

  const parser = new RstParser(filePath);
  return await parser.parse();
}
