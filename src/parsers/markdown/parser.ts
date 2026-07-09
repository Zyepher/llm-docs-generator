/**
 * Markdown Parser
 *
 * Parses Markdown/DocC files and extracts hierarchical structure.
 * Supports:
 * - Standard Markdown headers (H1-H4)
 * - Code blocks with language tags
 * - DocC directives (stripped during parsing)
 * - Cross-references
 *
 * Performance: O(n) where n = file size
 */

import { readFile } from 'node:fs/promises';
import { load as yamlLoad } from 'js-yaml';
import { marked } from 'marked';
import type { Token } from 'marked';

import { ParserError } from '../base.js';
import { getOpeningFence, isClosingFence, type FenceState } from './fences.js';
import { applyMarkdownDirectives } from './directives/index.js';

type MarkdownSourceSyntax = 'markdown' | 'mdx';
type MdxDeclarationKind = 'import' | 'export';

const MDX_WRAPPER_COMPONENTS = new Set([
  'Tabs',
  'Tab',
  'TabItem',
  'Steps',
  'Step',
  'Cards',
  'Card',
  'Accordion',
  'AccordionItem',
  'Callout',
  'Alert',
  'Note',
  'Warning',
  'Tip',
]);

const MDX_ADMONITION_COMPONENTS = new Set(['Callout', 'Alert', 'Note', 'Warning', 'Tip']);

/**
 * Reference-link definition captured from a markdown document, keyed by the
 * definition label (as authored). Stored on document metadata under
 * `linkDefinitions` so the formatter can inline `[text][label]` uses.
 */
export interface MarkdownLinkDefinition {
  href: string;
  title?: string;
}

function collectLinkDefinitions(
  links: Record<string, { href?: string | null; title?: string | null }> | undefined
): Record<string, MarkdownLinkDefinition> | undefined {
  if (links === undefined) {
    return undefined;
  }

  const definitions: Record<string, MarkdownLinkDefinition> = {};
  for (const [label, target] of Object.entries(links)) {
    const href = target?.href;
    if (typeof href !== 'string' || href.length === 0) {
      continue;
    }
    const definition: MarkdownLinkDefinition =
      typeof target?.title === 'string' && target.title.length > 0
        ? { href, title: target.title }
        : { href };
    definitions[label] = definition;
  }

  return Object.keys(definitions).length > 0 ? definitions : undefined;
}

/**
 * Parsed markdown document structure
 */
export interface MarkdownDocument {
  path: string;
  title: string;
  /**
   * Document-level content with no owning section: leading prose before the
   * first heading, or the entire body of a headingless document. Kept separate
   * from `sections` so it is preserved rather than silently dropped.
   */
  content: MarkdownContent[];
  sections: MarkdownSection[];
  metadata: Map<string, unknown>;
}

/**
 * Hierarchical section within markdown
 */
export interface MarkdownSection {
  level: number; // 1-6 (H1-H6)
  title: string;
  id: string;
  content: MarkdownContent[];
  children: MarkdownSection[];
}

/**
 * Content block within a section
 */
export interface MarkdownContent {
  type: 'prose' | 'code' | 'image' | 'blockquote';
  content: string;
  language?: string; // for code blocks
  metadata?: Map<string, unknown>;
}

/**
 * Markdown Parser class
 */
export class MarkdownParser {
  constructor(private readonly filePath: string) {}

  /**
   * Parse markdown file into structured document
   *
   * Performance: O(n) where n = file size
   */
  async parse(): Promise<MarkdownDocument> {
    // Read file
    const content = await readFile(this.filePath, 'utf-8');
    const sourceSyntax = this.inferSourceSyntax(this.filePath);

    // Extract metadata before stripping frontmatter from parseable content
    const metadata = this.extractMetadata(content);
    metadata.set('sourceSyntax', sourceSyntax);

    try {
      // Clean unsupported Markdown/MDX syntax outside fenced code
      const cleaned = this.cleanMarkdownContent(content, sourceSyntax);

      // Parse with marked
      const tokens = marked.lexer(cleaned);

      // Capture reference-link definitions (`[label]: url`) so the formatter can
      // inline them at each use site. marked collects these into tokens.links and
      // removes them from the token stream; without capturing them here they are
      // lost and every `[text][label]` use dangles.
      const linkDefinitions = collectLinkDefinitions(tokens.links);
      if (linkDefinitions !== undefined) {
        metadata.set('linkDefinitions', linkDefinitions);
      }

      // Extract title (frontmatter title, then first H1, then filename slug)
      const title = this.extractTitle(tokens, this.filePath, metadata);

      // Build hierarchical sections plus any document-level (headingless) content
      const { content: documentContent, sections } = this.buildSections(tokens);

      return {
        path: this.filePath,
        title,
        content: documentContent,
        sections,
        metadata,
      };
    } catch (error) {
      // Pathologically deep MDX component nesting overflows the recursive
      // component cleaners; surface it as an honest ParserError instead of a raw
      // RangeError (parity with the HTML and OpenAPI parsers).
      if (error instanceof RangeError) {
        throw new ParserError(
          `Markdown/MDX is too deeply nested to parse safely: ${this.filePath}`,
          'Markdown Parser'
        );
      }

      throw error;
    }
  }

  /**
   * Clean Markdown syntax extensions that are not documentation prose.
   *
   * Removes:
   * - YAML frontmatter from parseable content
   * - @Metadata blocks
   * - <doc:...> cross-references (keep text)
   * - <!-- test comments -->
   * - @Options directives
   * - MDX imports/exports, wrapper tags, JSX comments, and expression-only lines
   *
   * Performance: O(n) - line-oriented pass over text and fenced code segments
   */
  private cleanMarkdownContent(content: string, sourceSyntax: MarkdownSourceSyntax): string {
    const withoutFrontmatter = this.stripYamlFrontmatter(content);
    // Directive dialects (e.g. TanStack tabs) run through the extension seam,
    // which only activates a dialect whose exact markers are present. A document
    // with no directive markers is returned unchanged.
    const withTabs = applyMarkdownDirectives(withoutFrontmatter);
    return this.cleanOutsideFencedCode(withTabs, (segment) => {
      let cleanedSegment = this.cleanDocCContentSegment(segment);
      if (sourceSyntax === 'mdx') {
        cleanedSegment = this.cleanMdxContentSegment(cleanedSegment);
      }
      return this.compressBlankLines(cleanedSegment);
    }).trim();
  }

  /**
   * Clean DocC-specific syntax and test comments outside fenced code.
   */
  private cleanDocCContentSegment(content: string): string {
    let cleaned = content;

    // Remove @Metadata blocks
    cleaned = cleaned.replace(/@Metadata\s*\{[^}]*\}/gs, '');

    // Remove @Options blocks
    cleaned = cleaned.replace(/@Options\([^)]*\)\s*\{[^}]*\}/gs, '');

    // Convert <doc:Reference> to just "Reference"
    cleaned = cleaned.replace(/<doc:([^>]+)>/g, '$1');

    // Remove HTML test comments (<!-- ... -->)
    cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '');

    return cleaned;
  }

  /**
   * Clean common MDX syntax outside fenced code without evaluating expressions.
   */
  private cleanMdxContentSegment(content: string): string {
    const lines = content.split('\n');
    const output: string[] = [];
    let inJsxComment = false;
    let skippingDeclaration: MdxDeclarationKind | null = null;
    let declarationBalance = 0;
    let declarationQuote: string | null = null;
    let expressionBalance = 0;
    let expressionQuote: string | null = null;
    let pendingComponentLines: string[] | null = null;

    for (const originalLine of lines) {
      const commentResult = this.stripJsxCommentsFromLine(originalLine, inJsxComment);
      const line = commentResult.line;
      inJsxComment = commentResult.inComment;
      const trimmed = line.trim();

      if (pendingComponentLines !== null) {
        pendingComponentLines.push(line);
        if (trimmed.includes('>')) {
          const replacement = this.cleanMdxComponentLine(
            pendingComponentLines.map((componentLine) => componentLine.trim()).join(' ')
          );
          if (replacement !== undefined) {
            output.push(...replacement);
          } else {
            output.push(...pendingComponentLines);
          }
          pendingComponentLines = null;
        }
        continue;
      }

      if (skippingDeclaration !== null) {
        const balanceResult = this.delimiterBalance(line, declarationQuote);
        declarationBalance += balanceResult.balance;
        declarationQuote = balanceResult.quote;
        if (declarationBalance <= 0 && declarationQuote === null) {
          skippingDeclaration = null;
          declarationBalance = 0;
        }
        continue;
      }

      if (expressionBalance > 0 || expressionQuote !== null) {
        const balanceResult = this.delimiterBalance(line, expressionQuote);
        expressionBalance += balanceResult.balance;
        expressionQuote = balanceResult.quote;
        if (expressionBalance <= 0 && expressionQuote === null) {
          expressionBalance = 0;
        }
        continue;
      }

      if (trimmed === '') {
        output.push(line);
        continue;
      }

      const declarationKind = this.getMdxDeclarationKind(trimmed);
      if (declarationKind !== null) {
        const balanceResult = this.delimiterBalance(trimmed, null);
        declarationBalance = balanceResult.balance;
        declarationQuote = balanceResult.quote;
        if (this.shouldContinueMdxDeclaration(trimmed, declarationKind, declarationBalance)) {
          skippingDeclaration = declarationKind;
        } else {
          declarationBalance = 0;
          declarationQuote = null;
        }
        continue;
      }

      if (this.isMdxExpressionOnlyLine(trimmed)) {
        const balanceResult = this.delimiterBalance(trimmed, null);
        expressionBalance = balanceResult.balance;
        expressionQuote = balanceResult.quote;
        if (expressionBalance <= 0) {
          expressionBalance = 0;
          expressionQuote = null;
        }
        continue;
      }

      if (this.startsMultilineMdxComponentTag(trimmed)) {
        pendingComponentLines = [line];
        continue;
      }

      const componentReplacement = this.cleanMdxComponentLine(line);
      if (componentReplacement !== undefined) {
        output.push(...componentReplacement);
        continue;
      }

      output.push(line);
    }

    if (pendingComponentLines !== null) {
      output.push(...pendingComponentLines);
    }

    return output.join('\n');
  }

  /**
   * Apply text cleanup only outside fenced code blocks.
   */
  private cleanOutsideFencedCode(
    content: string,
    cleanSegment: (segment: string) => string
  ): string {
    const output: string[] = [];
    let textLines: string[] = [];
    let fence: FenceState | null = null;

    const flushText = (): void => {
      if (textLines.length === 0) {
        return;
      }

      const cleaned = cleanSegment(textLines.join('\n'));
      if (cleaned.length > 0) {
        output.push(...cleaned.split('\n'));
      }
      textLines = [];
    };

    for (const line of content.split('\n')) {
      if (fence !== null) {
        output.push(line);
        if (isClosingFence(line, fence)) {
          fence = null;
        }
        continue;
      }

      const openingFence = getOpeningFence(line);
      if (openingFence !== null) {
        flushText();
        output.push(line);
        fence = openingFence;
        continue;
      }

      textLines.push(line);
    }

    flushText();
    return output.join('\n');
  }

  private stripYamlFrontmatter(content: string): string {
    return this.readYamlFrontmatter(content)?.contentAfter ?? content;
  }

  private readYamlFrontmatter(
    content: string
  ): { frontmatter: string; contentAfter: string } | null {
    const withoutBom = content.replace(/^\uFEFF/, '');
    const lines = withoutBom.split('\n');

    if (lines[0]?.trim() !== '---') {
      return null;
    }

    for (let index = 1; index < lines.length; index += 1) {
      const trimmed = lines[index]?.trim();
      if (trimmed === '---' || trimmed === '...') {
        const frontmatter = lines.slice(1, index).join('\n');
        if (!this.isYamlMappingBlock(frontmatter)) {
          return null;
        }

        return {
          frontmatter,
          contentAfter: lines.slice(index + 1).join('\n'),
        };
      }
    }

    return null;
  }

  /**
   * A leading '---' can open a thematic break rather than a frontmatter fence.
   * Only treat the captured block as frontmatter when it parses as a YAML
   * mapping (or is empty); a scalar, sequence, or parse error means the
   * delimiters were real document content that must not be stripped.
   */
  private isYamlMappingBlock(block: string): boolean {
    try {
      const parsed = yamlLoad(block);
      if (parsed === null || parsed === undefined) {
        return true;
      }

      return typeof parsed === 'object' && Object.getPrototypeOf(parsed) === Object.prototype;
    } catch {
      return false;
    }
  }

  private compressBlankLines(content: string): string {
    return content.replace(/\n{3,}/g, '\n\n');
  }

  private stripJsxCommentsFromLine(
    line: string,
    inComment: boolean
  ): { line: string; inComment: boolean } {
    let result = '';
    let rest = line;
    let insideComment = inComment;

    while (rest.length > 0) {
      if (insideComment) {
        const endIndex = rest.indexOf('*/}');
        if (endIndex === -1) {
          return { line: result, inComment: true };
        }
        rest = rest.slice(endIndex + 3);
        insideComment = false;
        continue;
      }

      const startIndex = rest.indexOf('{/*');
      if (startIndex === -1) {
        result += rest;
        break;
      }

      result += rest.slice(0, startIndex);
      rest = rest.slice(startIndex + 3);
      insideComment = true;
    }

    return { line: result, inComment: insideComment };
  }

  private getMdxDeclarationKind(line: string): MdxDeclarationKind | null {
    if (
      /^import\s+/.test(line) &&
      (/^import\s+['"]/.test(line) ||
        /\bfrom\s+['"]/.test(line) ||
        // A default binding followed by a comma is only a real import when the
        // comma introduces named/namespace bindings (`import Foo, { … }` /
        // `import Foo, * as NS`) or ends the line as a continuation. Requiring
        // `{`, `*`, or end-of-line after the comma stops ordinary prose such as
        // "import them, then run setup." from being misread as an import and
        // silently dropped.
        /^import\s+(?:type\s+)?(?:\{|\*|[\w$]+\s*,\s*(?:\{|\*|$))/.test(line))
    ) {
      return 'import';
    }

    if (
      /^export\s+/.test(line) &&
      /^export\s+(?:\{|\*|default\b|const\b|let\b|var\b|function\b|class\b|type\b|interface\b|enum\b)/.test(
        line
      )
    ) {
      return 'export';
    }

    return null;
  }

  private shouldContinueMdxDeclaration(
    line: string,
    kind: MdxDeclarationKind,
    balance: number
  ): boolean {
    if (balance > 0) {
      return true;
    }

    if (kind === 'import') {
      return !this.isMdxDeclarationEnd(line, kind);
    }

    return /[({[,]\s*$/.test(line);
  }

  private isMdxDeclarationEnd(line: string, kind: MdxDeclarationKind): boolean {
    const normalized = this.normalizeMdxDeclarationLine(line);

    if (normalized.endsWith(';')) {
      return true;
    }

    if (kind === 'import') {
      return this.isCompleteMdxImportDeclaration(normalized);
    }

    return (
      /^[})\]](?:\s+(?:as\s+const|satisfies\s+[\w.]+))?;?$/.test(normalized) ||
      /^}\s*from\s+['"][^'"]+['"];?$/.test(normalized)
    );
  }

  private normalizeMdxDeclarationLine(line: string): string {
    return line
      .replace(/\s+\/\/.*$/, '')
      .replace(/\s+\/\*.*?\*\/\s*$/, '')
      .trim();
  }

  private isCompleteMdxImportDeclaration(line: string): boolean {
    const importAttributes = String.raw`(?:\s+(?:assert|with)\s+\{.*\})?`;
    return (
      new RegExp(String.raw`^import\s+['"][^'"]+['"]${importAttributes}$`).test(line) ||
      new RegExp(String.raw`\bfrom\s+['"][^'"]+['"]${importAttributes}$`).test(line)
    );
  }

  private isMdxExpressionOnlyLine(line: string): boolean {
    return line.startsWith('{');
  }

  private startsMultilineMdxComponentTag(line: string): boolean {
    const match = line.match(/^<([A-Z][\w.]*)\b/);
    return match?.[1] !== undefined && !line.includes('>');
  }

  /**
   * Remove or unwrap one complete MDX component tag line.
   *
   * Returns undefined when the line should be preserved as-is.
   */
  private cleanMdxComponentLine(line: string): string[] | undefined {
    const trimmed = line.trim();

    const compactReplacement = this.cleanCompactMdxComponentSequence(trimmed);
    if (compactReplacement !== undefined) {
      return compactReplacement;
    }

    const closingMatch = trimmed.match(/^<\/([A-Z][\w.]*)>\s*;?$/);
    if (closingMatch?.[1] !== undefined && this.isMdxWrapperComponent(closingMatch[1])) {
      return [];
    }

    const pairedMatch = trimmed.match(/^<([A-Z][\w.]*)\b([^>]*)>(.*?)<\/\1>\s*;?$/);
    if (pairedMatch?.[1] !== undefined) {
      const component = pairedMatch[1];
      if (!this.isMdxWrapperComponent(component)) {
        return undefined;
      }

      const replacement = this.labelReplacementForComponent(component, pairedMatch[2] ?? '');
      const innerText = (pairedMatch[3] ?? '').trim();
      const cleanedInnerText =
        innerText === ''
          ? []
          : this.cleanMdxContentSegment(innerText)
              .split('\n')
              .filter((innerLine) => innerLine !== '');
      return [...replacement, ...cleanedInnerText];
    }

    const selfClosingMatch = trimmed.match(/^<([A-Z][\w.]*)\b([^>]*)\/>\s*;?$/);
    if (selfClosingMatch?.[1] !== undefined) {
      const component = selfClosingMatch[1];
      const attributes = selfClosingMatch[2] ?? '';
      const label = this.extractUsefulMdxAttribute(
        attributes,
        this.isMdxWrapperComponent(component)
      );
      if (label !== undefined) {
        return [this.formatMdxAttributeLine(component, label)];
      }
      return [];
    }

    const openingMatch = trimmed.match(/^<([A-Z][\w.]*)\b([^>]*)>\s*$/);
    if (openingMatch?.[1] !== undefined && this.isMdxWrapperComponent(openingMatch[1])) {
      return this.labelReplacementForComponent(openingMatch[1], openingMatch[2] ?? '');
    }

    return undefined;
  }

  private cleanCompactMdxComponentSequence(line: string): string[] | undefined {
    let remaining = line.replace(/;$/, '').trim();
    if (!remaining.startsWith('<')) {
      return undefined;
    }

    const output: string[] = [];

    while (remaining !== '') {
      const parsed = this.parseLeadingMdxComponent(remaining);
      if (parsed === null) {
        return undefined;
      }

      if (!this.isMdxWrapperComponent(parsed.component) && !parsed.selfClosing) {
        return undefined;
      }

      if (parsed.selfClosing) {
        const label = this.extractUsefulMdxAttribute(
          parsed.attributes,
          this.isMdxWrapperComponent(parsed.component)
        );
        if (label !== undefined) {
          output.push(this.formatMdxAttributeLine(parsed.component, label));
        }
      } else {
        output.push(...this.labelReplacementForComponent(parsed.component, parsed.attributes));

        const inner = parsed.inner.trim();
        if (inner !== '') {
          const nested = this.cleanCompactMdxComponentSequence(inner);
          if (nested !== undefined) {
            output.push(...nested);
          } else {
            output.push(
              ...this.cleanMdxContentSegment(inner)
                .split('\n')
                .filter((innerLine) => innerLine !== '')
            );
          }
        }
      }

      remaining = parsed.rest.replace(/;$/, '').trim();
    }

    return output;
  }

  private parseLeadingMdxComponent(line: string): {
    component: string;
    attributes: string;
    inner: string;
    rest: string;
    selfClosing: boolean;
  } | null {
    const selfClosingMatch = line.match(/^<([A-Z][\w.]*)\b([^>]*)\/>\s*/);
    if (selfClosingMatch?.[1] !== undefined) {
      return {
        component: selfClosingMatch[1],
        attributes: selfClosingMatch[2] ?? '',
        inner: '',
        rest: line.slice(selfClosingMatch[0].length),
        selfClosing: true,
      };
    }

    const openingMatch = line.match(/^<([A-Z][\w.]*)\b([^>]*)>\s*/);
    if (openingMatch?.[1] === undefined) {
      return null;
    }

    const component = openingMatch[1];
    const afterOpening = openingMatch[0].length;
    const tagPattern = new RegExp(String.raw`</?${this.escapeRegExp(component)}\b[^>]*>`, 'g');
    tagPattern.lastIndex = afterOpening;
    let depth = 1;

    for (let match = tagPattern.exec(line); match !== null; match = tagPattern.exec(line)) {
      const tag = match[0];
      if (tag.startsWith('</')) {
        depth -= 1;
      } else if (!tag.endsWith('/>')) {
        depth += 1;
      }

      if (depth === 0) {
        return {
          component,
          attributes: openingMatch[2] ?? '',
          inner: line.slice(afterOpening, match.index),
          rest: line.slice(match.index + tag.length),
          selfClosing: false,
        };
      }
    }

    return null;
  }

  private escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private labelReplacementForComponent(component: string, attributes: string): string[] {
    const label = this.extractUsefulMdxAttribute(attributes, true);
    if (label === undefined) {
      return [];
    }

    return [this.formatMdxAttributeLine(component, label)];
  }

  private formatMdxAttributeLine(component: string, label: string): string {
    if (MDX_ADMONITION_COMPONENTS.has(this.baseMdxComponentName(component))) {
      return `> ${label}`;
    }

    return `### ${label}`;
  }

  private extractUsefulMdxAttribute(
    attributes: string,
    includeNameAndValue: boolean
  ): string | undefined {
    const allowedAttributes = includeNameAndValue
      ? ['title', 'label', 'name', 'value']
      : ['title', 'label', 'aria-label', 'alt'];
    const values = new Map<string, string>();
    const attributePattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

    for (const match of attributes.matchAll(attributePattern)) {
      const name = match[1];
      const value = match[2] ?? match[3] ?? '';
      if (name !== undefined) {
        values.set(name, value);
      }
    }

    for (const name of allowedAttributes) {
      const safeValue = this.sanitizeMdxAttributeValue(values.get(name));
      if (safeValue !== undefined) {
        return safeValue;
      }
    }

    return undefined;
  }

  private sanitizeMdxAttributeValue(value: string | undefined): string | undefined {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    if (
      normalized === undefined ||
      normalized === '' ||
      normalized.length > 120 ||
      /[<>{}\n\r]/.test(normalized)
    ) {
      return undefined;
    }

    return normalized;
  }

  private isMdxWrapperComponent(component: string): boolean {
    return MDX_WRAPPER_COMPONENTS.has(this.baseMdxComponentName(component));
  }

  private baseMdxComponentName(component: string): string {
    return component.split('.')[0] ?? component;
  }

  private delimiterBalance(
    text: string,
    openQuote: string | null
  ): { balance: number; quote: string | null } {
    // Count brace/paren/bracket balance while skipping quoted-string contents.
    // A single linear pass tracks the active quote and honors backslash escapes,
    // so this is O(n). The previous global quote-stripping regex, even after the
    // ReDoS fix, still rescanned to end-of-line from every quote start on an
    // unterminated quote run: O(n^2), ~65s on one ~400KB line.
    //
    // `openQuote` carries an unterminated template literal in from the previous
    // line, so delimiters inside multi-line backtick strings stay hidden. Only
    // backticks survive the line break in the returned state: ' and " strings
    // cannot span lines in JavaScript, and treating a stray apostrophe (e.g. in
    // a trailing comment) as still open would swallow the rest of the document.
    // A trailing backslash escapes the newline itself, so the escape state never
    // carries into the next line.
    let balance = 0;
    let quote: string | null = openQuote;
    let escaped = false;

    for (const char of text) {
      if (quote !== null) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }

      if (char === "'" || char === '"' || char === '`') {
        quote = char;
      } else if (char === '{' || char === '(' || char === '[') {
        balance += 1;
      } else if (char === '}' || char === ')' || char === ']') {
        balance -= 1;
      }
    }

    return { balance, quote: quote === '`' ? quote : null };
  }

  private inferSourceSyntax(filePath: string): MarkdownSourceSyntax {
    return filePath.toLowerCase().endsWith('.mdx') ? 'mdx' : 'markdown';
  }

  /**
   * Extract document title
   *
   * Performance: O(k) where k = number of tokens until first H1
   */
  private extractTitle(tokens: Token[], filePath: string, metadata: Map<string, unknown>): string {
    // Prefer the frontmatter title so a file's section heading reflects the
    // authored title (156 of 162 router source files carry `title:`), instead of
    // silently falling back to the filename slug.
    const frontmatterTitle = metadata.get('title');
    if (typeof frontmatterTitle === 'string' && frontmatterTitle.trim().length > 0) {
      return frontmatterTitle.trim();
    }

    // Then the first H1 heading in the body.
    for (const token of tokens) {
      if (token.type === 'heading' && token.depth === 1) {
        return token.text;
      }
    }

    // Finally the filename slug.
    const parts = filePath.split('/');
    const filename = parts.at(-1) ?? 'document';
    return filename.replace(/\.(?:md|mdx|markdown)$/i, '');
  }

  /**
   * Extract metadata from frontmatter or content
   *
   * Performance: O(k) where k = small constant (frontmatter size)
   */
  private extractMetadata(content: string): Map<string, unknown> {
    const metadata = new Map<string, unknown>();

    const frontmatter = this.readYamlFrontmatter(content)?.frontmatter;
    if (frontmatter !== undefined) {
      // Simple key-value parsing keeps broad, backward-compatible key coverage.
      const lines = frontmatter.split('\n');
      for (const line of lines) {
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
          const key = line.substring(0, colonIndex).trim();
          const value = line.substring(colonIndex + 1).trim();
          metadata.set(key, value);
        }
      }

      // Robustly resolve `title` and `id` via a real YAML parse so quoted or
      // escaped scalars (e.g. `title: "Foo: Bar"`) are not mangled by the naive
      // split above. Only string/number/boolean scalars are accepted.
      try {
        const parsed = yamlLoad(frontmatter);
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          Object.getPrototypeOf(parsed) === Object.prototype
        ) {
          const record = parsed as Record<string, unknown>;
          for (const key of ['title', 'id']) {
            const value = record[key];
            if (typeof value === 'string' && value.trim().length > 0) {
              metadata.set(key, value.trim());
            } else if (typeof value === 'number' || typeof value === 'boolean') {
              metadata.set(key, String(value));
            }
          }
        }
      } catch {
        // Keep the line-parsed values when the block is not clean YAML.
      }
    }

    return metadata;
  }

  /**
   * Build hierarchical section structure from flat token list
   *
   * Performance: O(n) where n = number of tokens
   * Creates tree structure based on heading levels
   */
  private buildSections(tokens: Token[]): {
    content: MarkdownContent[];
    sections: MarkdownSection[];
  } {
    const rootSections: MarkdownSection[] = [];
    // Content that has no open section to live in: leading prose before the
    // first heading, or a document with no headings at all (e.g. a README,
    // CHANGELOG, or plain-prose fragment). Without this it was silently dropped.
    const documentContent: MarkdownContent[] = [];
    const stack: MarkdownSection[] = [];
    let currentContent: MarkdownContent[] = [];

    const flushCurrentContent = (): void => {
      if (currentContent.length === 0) {
        return;
      }

      if (stack.length > 0) {
        stack[stack.length - 1]!.content.push(...currentContent);
      } else {
        documentContent.push(...currentContent);
      }

      currentContent = [];
    };

    for (const token of tokens) {
      if (token.type === 'heading') {
        // Save accumulated content to the current section, or to the document
        // level when no section is open yet.
        flushCurrentContent();

        // Create new section
        const section: MarkdownSection = {
          level: token.depth,
          title: token.text,
          id: this.slugify(token.text),
          content: [],
          children: [],
        };

        // Pop stack until we find the parent level
        while (stack.length > 0 && stack[stack.length - 1]!.level >= token.depth) {
          stack.pop();
        }

        // Add as child of parent or as root
        if (stack.length > 0) {
          stack[stack.length - 1]!.children.push(section);
        } else {
          rootSections.push(section);
        }

        // Push onto stack
        stack.push(section);
      } else {
        // Accumulate content for current section
        const content = this.tokenToContent(token);
        if (content) {
          currentContent.push(content);
        }
      }
    }

    // Flush any remaining content (to the last open section, or to the document
    // level when there were no headings).
    flushCurrentContent();

    return { content: documentContent, sections: rootSections };
  }

  /**
   * Convert marked token to MarkdownContent
   *
   * Performance: O(1)
   */
  private tokenToContent(token: Token): MarkdownContent | null {
    switch (token.type) {
      case 'code':
        // Preserve the fence info string byte-verbatim, including the empty
        // string for a bare ``` fence. Never inject a synthetic `text` tag: the
        // formatter renders an empty info string as a genuinely bare fence and a
        // non-empty one (for example `ts title="vite.config.ts"`) exactly.
        return {
          type: 'code',
          content: token.text,
          language: token.lang ?? '',
        };

      case 'paragraph':
      case 'text':
        return {
          type: 'prose',
          content: token.text,
        };

      case 'blockquote': {
        // Extract text from blockquote
        const text = token.text || '';
        return {
          type: 'blockquote',
          content: text,
        };
      }

      case 'space':
        // Skip whitespace tokens
        return null;

      default: {
        // Convert other tokens to prose
        const tokenText =
          ('text' in token && typeof token.text === 'string' ? token.text : '') ||
          ('raw' in token && typeof token.raw === 'string' ? token.raw : '');
        if (tokenText.trim()) {
          return {
            type: 'prose',
            content: tokenText,
          };
        }
        return null;
      }
    }
  }

  /**
   * Convert text to slug/id
   *
   * Performance: O(n) where n = text length
   */
  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
  }
}
