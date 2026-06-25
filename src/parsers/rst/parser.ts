/**
 * reStructuredText parser foundation.
 *
 * This parser intentionally supports a deterministic subset suitable for
 * Python-style docs. It does not execute directives, resolve includes, fetch
 * remote content, or claim full docutils/Sphinx compatibility.
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
import { ParserError } from '../base.js';

const SECTION_ADORNMENT_PATTERN = /^([=\-~^"`'#*+_:.<>])\1*\s*$/;
const BULLET_PATTERN = /^\s*[-+*]\s+\S/;
const ENUMERATED_PATTERN = /^\s*(?:\d+|[A-Za-z]|[ivxlcdmIVXLCDM]+|#)[.)]\s+\S/;
const DIRECTIVE_PATTERN = /^\s*\.\.\s+([A-Za-z][\w-]*)::\s*(.*)$/;
const CODE_DIRECTIVES = new Set(['code-block', 'code']);

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
          subset: 'underline headings, paragraphs, simple lists, literal blocks, code directives',
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

    const currentContent = (): ContentBlock[] => stack.at(-1)?.content ?? rootContent;

    while (index < lines.length) {
      if (isBlank(lines[index])) {
        index += 1;
        continue;
      }

      const heading = this.readHeading(lines, index);
      if (heading !== null) {
        const level = getOrCreateLevel(sectionLevels, heading.adornment);
        if (title === '' && level === 1) {
          title = heading.title;
          index += 2;
          continue;
        }

        const section: RstSection = {
          level,
          title: heading.title,
          id: slugify(heading.title),
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
        index += 2;
        continue;
      }

      const directive = this.readDirective(lines[index] ?? '');
      if (directive !== null) {
        const parsedDirective = this.parseDirective(lines, index, directive, warnings);
        currentContent().push(...parsedDirective.blocks);
        index = parsedDirective.nextIndex;
        continue;
      }

      if (BULLET_PATTERN.test(lines[index] ?? '') || ENUMERATED_PATTERN.test(lines[index] ?? '')) {
        const parsedList = this.parseList(lines, index);
        currentContent().push(createContentBlock(ContentBlockType.PROSE, parsedList.content));
        index = parsedList.nextIndex;
        continue;
      }

      const paragraph = this.parseParagraph(lines, index);
      if (paragraph.literalBlock !== undefined) {
        const prose = paragraph.content.replace(/::\s*$/, ':').trim();
        if (prose !== '') {
          currentContent().push(createContentBlock(ContentBlockType.PROSE, prose));
        }
        currentContent().push(
          createContentBlock(ContentBlockType.CODE, paragraph.literalBlock, { language: 'text' })
        );
      } else if (paragraph.content !== '') {
        currentContent().push(createContentBlock(ContentBlockType.PROSE, paragraph.content));
      }
      index = paragraph.nextIndex;
    }

    return { title, content: rootContent, sections: rootSections, warnings };
  }

  private readHeading(lines: string[], index: number): SectionHeading | null {
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

    return { title, adornment: match[1] };
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
    warnings: RstParserWarning[]
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
        : [message, directive.argument, safeBody].filter(Boolean).join('\n');

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
        this.readDirective(line) !== null ||
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
  const match = line.match(/^ */);
  return match?.[0].length ?? 0;
}

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim() === '';
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
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
