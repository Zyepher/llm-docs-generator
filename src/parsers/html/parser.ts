/**
 * Static HTML parser foundation.
 *
 * This parser extracts deterministic structure from explicit local HTML files.
 * It never renders JavaScript, executes content, fetches linked resources, or
 * infers source authority.
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

const STRIPPED_ELEMENTS = ['script', 'style', 'template'] as const;
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const NON_CONTENT_ELEMENTS = new Set([
  'head',
  'title',
  'meta',
  'link',
  'base',
  'script',
  'style',
  'template',
]);
const BLOCK_ELEMENTS = new Set([
  'article',
  'aside',
  'blockquote',
  'body',
  'code',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

export interface HtmlDocument {
  path: string;
  title: string;
  content: ContentBlock[];
  children: DocNode[];
  metadata: Map<string, unknown>;
}

export interface HtmlParserWarning {
  message: string;
  tag?: string;
}

export interface HtmlLink {
  text: string;
  href: string;
}

interface ParsedHtml {
  title: string;
  content: ContentBlock[];
  sections: HtmlSection[];
  warnings: HtmlParserWarning[];
  links: HtmlLink[];
  strippedElementCounts: Record<(typeof STRIPPED_ELEMENTS)[number], number>;
}

interface HtmlSection {
  level: number;
  title: string;
  id: string;
  content: ContentBlock[];
  children: HtmlSection[];
}

interface HtmlRootNode {
  type: 'root';
  children: HtmlNode[];
}

interface HtmlElementNode {
  type: 'element';
  tag: string;
  attrs: Map<string, string>;
  children: HtmlNode[];
}

interface HtmlTextNode {
  type: 'text';
  text: string;
}

type HtmlNode = HtmlRootNode | HtmlElementNode | HtmlTextNode;

export class HtmlParser {
  constructor(private readonly filePath: string) {}

  async parse(): Promise<HtmlDocument> {
    const raw = await readFile(this.filePath, 'utf-8');
    const parsed = this.parseContent(raw.replace(/^\uFEFF/, ''));
    const metadata = new Map<string, unknown>([
      ['format', 'html'],
      ['sourcePath', this.filePath],
      ['sourceKind', 'rendered-html-fallback'],
      ['renderedHtmlFallback', true],
      ['confidence', 'lower'],
      ['parser', 'html-static-subset'],
      ['parserDetails', getParserDetails()],
      ['warnings', parsed.warnings],
    ]);

    if (parsed.links.length > 0) {
      metadata.set('links', parsed.links);
    }

    metadata.set('strippedElementCounts', parsed.strippedElementCounts);

    return {
      path: this.filePath,
      title: parsed.title,
      content: parsed.content,
      children: parsed.sections.map((section) => sectionToDocNode(section)),
      metadata,
    };
  }

  private parseContent(content: string): ParsedHtml {
    const normalized = content.replace(/\r\n?/g, '\n');
    const strippedElementCounts = countStrippedElements(normalized);
    const safeHtml = stripUnsafeElements(normalized);
    const tree = parseHtmlTree(safeHtml);
    const body = findFirstElement(tree, 'body') ?? tree;
    const htmlTitle = extractFirstElementText(tree, 'title');
    const h1Title = extractFirstElementText(body, 'h1') ?? extractFirstElementText(tree, 'h1');
    const title = htmlTitle || h1Title || basenameWithoutHtmlExtension(this.filePath);

    const extractor = new HtmlContentExtractor();
    const extracted = extractor.extract(body);
    const warnings: HtmlParserWarning[] = [
      {
        message:
          'Parsed with lower-confidence static rendered HTML fallback; JavaScript was not rendered or executed.',
      },
    ];

    for (const tag of STRIPPED_ELEMENTS) {
      const count = strippedElementCounts[tag];
      if (count > 0) {
        warnings.push({
          tag,
          message: `Stripped ${count} <${tag}> element${count === 1 ? '' : 's'} before parsing.`,
        });
      }
    }

    return {
      title,
      content: extracted.content,
      sections: extracted.sections,
      warnings,
      links: extracted.links,
      strippedElementCounts,
    };
  }
}

class HtmlContentExtractor {
  private readonly rootContent: ContentBlock[] = [];
  private readonly rootSections: HtmlSection[] = [];
  private readonly sectionStack: HtmlSection[] = [];
  private readonly usedIds = new Map<string, number>();
  private readonly links: HtmlLink[] = [];

  extract(root: HtmlNode): { content: ContentBlock[]; sections: HtmlSection[]; links: HtmlLink[] } {
    this.visitChildren(root);
    return {
      content: this.rootContent,
      sections: this.rootSections,
      links: this.links,
    };
  }

  private visitChildren(node: HtmlNode): void {
    if (node.type === 'text') {
      return;
    }

    for (const child of node.children) {
      this.visitNode(child);
    }
  }

  private visitNode(node: HtmlNode): void {
    if (node.type === 'text') {
      return;
    }

    if (node.type === 'root') {
      this.visitChildren(node);
      return;
    }

    if (NON_CONTENT_ELEMENTS.has(node.tag)) {
      return;
    }

    if (node.tag === 'h1') {
      return;
    }

    if (isHeadingTag(node.tag)) {
      const title = this.extractInlineText(node);
      if (title !== '') {
        this.startSection(Number(node.tag.slice(1)), title);
      }
      return;
    }

    if (node.tag === 'p') {
      this.addProse(this.extractInlineText(node));
      return;
    }

    if (node.tag === 'blockquote') {
      this.addProse(this.extractInlineText(node), new Map([['style', 'blockquote']]));
      return;
    }

    if (node.tag === 'pre') {
      this.addCode(extractCodeText(node), inferCodeLanguage(node));
      return;
    }

    if (node.tag === 'code') {
      this.addCode(extractCodeText(node), inferCodeLanguage(node));
      return;
    }

    if (node.tag === 'table') {
      this.addTable(node);
      return;
    }

    if (node.tag === 'ul' || node.tag === 'ol') {
      this.addList(node, node.tag === 'ol');
      return;
    }

    if (node.tag === 'br') {
      return;
    }

    if (hasDirectBlockChild(node)) {
      this.visitChildren(node);
      return;
    }

    this.addProse(this.extractInlineText(node));
  }

  private startSection(level: number, title: string): void {
    const section: HtmlSection = {
      level,
      title,
      id: this.uniqueId(slugify(title)),
      content: [],
      children: [],
    };

    while (this.sectionStack.length > 0 && (this.sectionStack.at(-1)?.level ?? 0) >= level) {
      this.sectionStack.pop();
    }

    const parent = this.sectionStack.at(-1);
    if (parent === undefined) {
      this.rootSections.push(section);
    } else {
      parent.children.push(section);
    }

    this.sectionStack.push(section);
  }

  private addProse(content: string, annotations?: Map<string, unknown>): void {
    const trimmed = normalizeInlineWhitespace(content);
    if (trimmed === '') {
      return;
    }
    const options = annotations === undefined ? undefined : { annotations };
    this.currentContent().push(createContentBlock(ContentBlockType.PROSE, trimmed, options));
  }

  private addCode(content: string, language: string): void {
    const trimmed = trimCodeBlock(content);
    if (trimmed === '') {
      return;
    }
    this.currentContent().push(createContentBlock(ContentBlockType.CODE, trimmed, { language }));
  }

  private addTable(node: HtmlElementNode): void {
    const rows = collectTableRows(node);
    if (rows.length === 0) {
      this.addProse(this.extractInlineText(node));
      return;
    }

    const content = rows.map((row) => row.join(' | ')).join('\n').trim();
    if (content === '') {
      return;
    }

    this.currentContent().push(
      createContentBlock(ContentBlockType.DATA, content, {
        annotations: new Map([['type', 'table']]),
      })
    );
  }

  private addList(node: HtmlElementNode, ordered: boolean): void {
    const items = node.children.filter(
      (child): child is HtmlElementNode => child.type === 'element' && child.tag === 'li'
    );
    const lines = items
      .map((item, index) => {
        const marker = ordered ? `${index + 1}.` : '-';
        const text = this.extractInlineTextExcludingNestedLists(item);
        return text === '' ? '' : `${marker} ${text}`;
      })
      .filter((line) => line !== '');

    if (lines.length > 0) {
      this.currentContent().push(createContentBlock(ContentBlockType.PROSE, lines.join('\n')));
    }
  }

  private extractInlineTextExcludingNestedLists(node: HtmlNode): string {
    return this.extractInlineText(node, (child) => {
      return child.type === 'element' && (child.tag === 'ul' || child.tag === 'ol');
    });
  }

  private extractInlineText(
    node: HtmlNode,
    shouldSkip?: (node: HtmlNode) => boolean
  ): string {
    if (shouldSkip?.(node)) {
      return '';
    }

    if (node.type === 'text') {
      return decodeHtmlEntities(node.text);
    }

    if (node.type === 'root') {
      return node.children.map((child) => this.extractInlineText(child, shouldSkip)).join(' ');
    }

    if (NON_CONTENT_ELEMENTS.has(node.tag)) {
      return '';
    }

    if (node.tag === 'br') {
      return '\n';
    }

    if (node.tag === 'a') {
      const text = normalizeInlineWhitespace(
        node.children.map((child) => this.extractInlineText(child, shouldSkip)).join(' ')
      );
      const href = normalizeInlineWhitespace(node.attrs.get('href') ?? '');
      if (href !== '') {
        this.links.push({ text, href });
        if (text !== '' && text !== href) {
          return `${text} (${href})`;
        }
        return text || href;
      }
      return text;
    }

    if (node.tag === 'img') {
      return normalizeInlineWhitespace(node.attrs.get('alt') ?? '');
    }

    return node.children.map((child) => this.extractInlineText(child, shouldSkip)).join(' ');
  }

  private currentContent(): ContentBlock[] {
    return this.sectionStack.at(-1)?.content ?? this.rootContent;
  }

  private uniqueId(baseId: string): string {
    const existing = this.usedIds.get(baseId) ?? 0;
    this.usedIds.set(baseId, existing + 1);
    return existing === 0 ? baseId : `${baseId}-${existing + 1}`;
  }
}

function parseHtmlTree(content: string): HtmlRootNode {
  const root: HtmlRootNode = { type: 'root', children: [] };
  const stack: Array<HtmlRootNode | HtmlElementNode> = [root];
  const tokenPattern = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/?[A-Za-z][^>]*>|[^<]+|</g;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('<!')) {
      continue;
    }

    if (/^<\/[A-Za-z]/.test(token)) {
      const tagName = readTagName(token);
      if (tagName !== undefined) {
        popToMatchingTag(stack, tagName);
      }
      continue;
    }

    if (/^<[A-Za-z]/.test(token)) {
      const tagName = readTagName(token);
      if (tagName === undefined) {
        appendText(stack, token);
        continue;
      }

      const node: HtmlElementNode = {
        type: 'element',
        tag: tagName,
        attrs: parseAttributes(token),
        children: [],
      };
      stack.at(-1)?.children.push(node);

      if (!VOID_ELEMENTS.has(tagName) && !/\/\s*>$/.test(token)) {
        stack.push(node);
      }
      continue;
    }

    appendText(stack, token);
  }

  return root;
}

function popToMatchingTag(stack: Array<HtmlRootNode | HtmlElementNode>, tagName: string): void {
  for (let index = stack.length - 1; index > 0; index -= 1) {
    const node = stack[index];
    if (node?.type === 'element' && node.tag === tagName) {
      stack.splice(index);
      return;
    }
  }
}

function appendText(stack: Array<HtmlRootNode | HtmlElementNode>, text: string): void {
  if (text === '') {
    return;
  }

  stack.at(-1)?.children.push({ type: 'text', text });
}

function parseAttributes(token: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const withoutBrackets = token.replace(/^<\/?\s*[A-Za-z][\w:-]*/, '').replace(/\/?>$/, '');
  const attrPattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;

  while ((match = attrPattern.exec(withoutBrackets)) !== null) {
    const name = match[1]?.toLowerCase();
    if (name === undefined || name === '') {
      continue;
    }
    attrs.set(name, decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? ''));
  }

  return attrs;
}

function readTagName(token: string): string | undefined {
  return token.match(/^<\/?\s*([A-Za-z][\w:-]*)/)?.[1]?.toLowerCase();
}

function stripUnsafeElements(content: string): string {
  return STRIPPED_ELEMENTS.reduce((result, tag) => {
    const pairedPattern = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
    const selfClosingPattern = new RegExp(`<${tag}\\b[^>]*\\/\\s*>`, 'gi');
    const unclosedPattern = new RegExp(`<${tag}\\b[\\s\\S]*$`, 'gi');
    return result
      .replace(pairedPattern, '')
      .replace(selfClosingPattern, '')
      .replace(unclosedPattern, '');
  }, content);
}

function countStrippedElements(content: string): Record<(typeof STRIPPED_ELEMENTS)[number], number> {
  return STRIPPED_ELEMENTS.reduce(
    (counts, tag) => {
      counts[tag] = [...content.matchAll(new RegExp(`<${tag}\\b`, 'gi'))].length;
      return counts;
    },
    { script: 0, style: 0, template: 0 }
  );
}

function findFirstElement(node: HtmlNode, tagName: string): HtmlElementNode | undefined {
  if (node.type === 'element' && node.tag === tagName) {
    return node;
  }

  if (node.type === 'text') {
    return undefined;
  }

  for (const child of node.children) {
    const found = findFirstElement(child, tagName);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function extractFirstElementText(node: HtmlNode, tagName: string): string | undefined {
  const element = findFirstElement(node, tagName);
  if (element === undefined) {
    return undefined;
  }

  const text = normalizeInlineWhitespace(
    collectText(element, { preserveWhitespace: false, includeNonContent: true })
  );
  return text === '' ? undefined : text;
}

function collectText(
  node: HtmlNode,
  options: { preserveWhitespace: boolean; skipNestedLists?: boolean; includeNonContent?: boolean }
): string {
  if (node.type === 'text') {
    return decodeHtmlEntities(node.text);
  }

  if (node.type === 'element') {
    if (NON_CONTENT_ELEMENTS.has(node.tag) && options.includeNonContent !== true) {
      return '';
    }
    if (node.tag === 'br') {
      return options.preserveWhitespace ? '\n' : ' ';
    }
    if (options.skipNestedLists && (node.tag === 'ul' || node.tag === 'ol')) {
      return '';
    }
  }

  return node.children.map((child) => collectText(child, options)).join(
    options.preserveWhitespace ? '' : ' '
  );
}

function extractCodeText(node: HtmlElementNode): string {
  const nestedCode = node.tag === 'pre' ? findFirstElement(node, 'code') : undefined;
  return collectText(nestedCode ?? node, { preserveWhitespace: true });
}

function inferCodeLanguage(node: HtmlElementNode): string {
  const codeNode = node.tag === 'pre' ? findFirstElement(node, 'code') ?? node : node;
  const className = codeNode.attrs.get('class') ?? node.attrs.get('class') ?? '';
  const classMatch = className.match(/(?:^|\s)(?:language|lang)-([A-Za-z0-9_+.-]+)/);
  const dataLanguage = codeNode.attrs.get('data-language') ?? node.attrs.get('data-language');

  return classMatch?.[1] ?? dataLanguage ?? 'text';
}

function collectTableRows(node: HtmlElementNode): string[][] {
  return findElements(node, 'tr')
    .map((row) => collectTableCells(row))
    .filter((row) => row.length > 0);
}

function collectTableCells(row: HtmlElementNode): string[] {
  const cells = row.children.filter(
    (child): child is HtmlElementNode =>
      child.type === 'element' && (child.tag === 'th' || child.tag === 'td')
  );
  const resolvedCells = cells.length > 0 ? cells : findElements(row, 'th').concat(findElements(row, 'td'));
  return resolvedCells.map((cell) =>
    normalizeInlineWhitespace(collectText(cell, { preserveWhitespace: false }))
  );
}

function findElements(node: HtmlNode, tagName: string): HtmlElementNode[] {
  if (node.type === 'text') {
    return [];
  }

  const own = node.type === 'element' && node.tag === tagName ? [node] : [];
  return own.concat(node.children.flatMap((child) => findElements(child, tagName)));
}

function hasDirectBlockChild(node: HtmlElementNode): boolean {
  return node.children.some((child) => child.type === 'element' && BLOCK_ELEMENTS.has(child.tag));
}

function isHeadingTag(tagName: string): boolean {
  return /^h[2-6]$/.test(tagName);
}

function sectionToDocNode(section: HtmlSection): DocNode {
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
    children: section.children.map((child) => sectionToDocNode(child)),
    metadata: new Map([['level', section.level]]),
  });
}

function normalizeInlineWhitespace(content: string): string {
  return content
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function trimCodeBlock(content: string): string {
  return content.replace(/^\n+/, '').replace(/\n+$/, '').trimEnd();
}

function decodeHtmlEntities(content: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    apos: "'",
    copy: '(c)',
    gt: '>',
    hellip: '...',
    laquo: '<<',
    ldquo: '"',
    lsquo: "'",
    lt: '<',
    mdash: '--',
    nbsp: ' ',
    ndash: '-',
    quot: '"',
    raquo: '>>',
    rdquo: '"',
    reg: '(R)',
    rsquo: "'",
    trade: '(TM)',
  };

  return content.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (entity, rawName: string) => {
    const name = rawName.toLowerCase();
    if (name.startsWith('#x')) {
      return decodeNumericEntity(entity, name.slice(2), 16);
    }

    if (name.startsWith('#')) {
      return decodeNumericEntity(entity, name.slice(1), 10);
    }

    return namedEntities[name] ?? entity;
  });
}

function decodeNumericEntity(entity: string, value: string, radix: number): string {
  const codePoint = Number.parseInt(value, radix);
  if (
    !Number.isInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return entity;
  }

  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return entity;
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

function basenameWithoutHtmlExtension(path: string): string {
  return basename(path).replace(/\.html?$/i, '') || 'HTML Document';
}

export function getParserDetails(): Record<string, string | boolean> {
  return {
    subset:
      'document title/H1 fallback, H2-H6 hierarchy, paragraphs, simple lists, pre/code blocks, and simple tables',
    renderedHtmlFallback: true,
    confidence: 'lower',
    javascript: 'not rendered or executed',
    network: 'no linked resources are fetched',
    strippedElements: 'script, style, and template elements are removed before parsing',
  };
}

export async function parseHtmlFile(filePath: string): Promise<HtmlDocument> {
  const stats = await lstat(filePath);
  if (!stats.isFile()) {
    throw new ParserError(`Invalid HTML file path: ${filePath}`, 'Static HTML Parser');
  }

  if (!/\.html?$/i.test(filePath)) {
    throw new ParserError(`Unsupported HTML file extension: ${filePath}`, 'Static HTML Parser');
  }

  const parser = new HtmlParser(filePath);
  return await parser.parse();
}
