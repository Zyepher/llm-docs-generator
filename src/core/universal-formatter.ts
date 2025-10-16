/**
 * Universal LLM Documentation Formatter
 *
 * Works with the unified DocNode IR to generate LLM-optimized documentation.
 * Format-agnostic - handles OpenRef, Markdown, and any future formats.
 *
 * Performance optimizations:
 * - String concatenation using array join (O(n) vs O(n²))
 * - Streaming writes for large outputs
 * - Hierarchical numbering for precise navigation
 */

import { createWriteStream } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

import type {
  DocNode,
  ContentBlock,
} from './models.js';
import { DocNodeType, ContentBlockType } from './models.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const NEWLINE = '\n';
const DOUBLE_NEWLINE = '\n\n';

// ============================================================================
// UNIVERSAL FORMATTER
// ============================================================================

export interface FormatterOptions {
  outputDir: string;
  filenamePrefix?: string;
  title?: string;
  systemPrompt?: string;
  includeMetadata?: boolean;
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
  async generateAll(): Promise<void> {
    const outputDir = this.options.outputDir;
    await mkdir(outputDir, { recursive: true });

    // Generate full combined document
    await this.generateFullDoc();

    // Generate modular documents by category (if applicable)
    await this.generateModularDocs();
  }

  /**
   * Generate full combined documentation
   */
  private async generateFullDoc(): Promise<void> {
    const prefix = this.options.filenamePrefix || 'documentation';
    const filepath = `${this.options.outputDir}/${prefix}-full-llms.txt`;

    const parts: string[] = [];

    // Header
    parts.push(this.generateHeader());

    // Content
    parts.push(this.formatNode(this.root, []));

    const content = parts.join('');

    // Stream for large files
    if (content.length > 10 * 1024 * 1024) {
      await this.writeFileStream(filepath, content);
    } else {
      await writeFile(filepath, content, 'utf-8');
    }
  }

  /**
   * Generate modular documentation files (one per category)
   */
  private async generateModularDocs(): Promise<void> {
    // Find all CATEGORY nodes
    const categories = this.root.children.filter(
      (child) => child.type === DocNodeType.CATEGORY
    );

    if (categories.length === 0) return;

    const prefix = this.options.filenamePrefix || 'documentation';

    // Generate file for each category
    for (const category of categories) {
      const filename = `${prefix}-${category.id}-llms.txt`;
      const filepath = `${this.options.outputDir}/${filename}`;

      const parts: string[] = [];

      // System prompt for category
      parts.push(this.generateCategoryHeader(category));

      // Format category content
      parts.push(this.formatNode(category, []));

      await writeFile(filepath, parts.join(''), 'utf-8');
    }
  }

  /**
   * Generate document header with metadata
   */
  private generateHeader(): string {
    const parts: string[] = [];

    // System prompt
    const systemPrompt = this.options.systemPrompt ||
      `This is the complete developer documentation for ${this.options.title || this.root.title}.`;
    parts.push(`<SYSTEM>${systemPrompt}</SYSTEM>`, DOUBLE_NEWLINE);

    // Metadata
    if (this.options.includeMetadata !== false) {
      const now = new Date();
      const date = now.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      const format = this.root.metadata.get('format') || 'unknown';
      parts.push(`<!-- Format: ${format}, Generated: ${date} -->`, DOUBLE_NEWLINE);
    }

    // Title
    const title = this.options.title || this.root.title;
    parts.push(`# ${title}`, DOUBLE_NEWLINE);

    return parts.join('');
  }

  /**
   * Generate category-specific header
   */
  private generateCategoryHeader(category: DocNode): string {
    const parts: string[] = [];

    const title = this.options.title || this.root.title;
    const systemPrompt = `This is the developer documentation for ${title} - ${category.title}.`;
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
  private formatNode(node: DocNode, numbers: number[]): string {
    const parts: string[] = [];

    // For ROOT nodes, don't format the node itself, just children
    if (node.type === DocNodeType.ROOT) {
      let childNum = 1;
      for (const child of node.children) {
        parts.push(this.formatNode(child, [childNum]));
        childNum++;
      }
      return parts.join('');
    }

    // Format heading with hierarchical number
    const numberString = numbers.join('.');
    const heading = this.getHeading(node.type, numbers.length);
    parts.push(`${heading} ${numberString}. ${node.title}`, DOUBLE_NEWLINE);

    // Format description as prose if present
    if (node.description) {
      parts.push(node.description, DOUBLE_NEWLINE);
    }

    // Format content blocks
    for (const content of node.content) {
      parts.push(this.formatContent(content));
    }

    // Format children recursively
    let childNum = 1;
    for (const child of node.children) {
      const childNumbers = [...numbers, childNum];
      parts.push(this.formatNode(child, childNumbers));
      childNum++;
    }

    return parts.join('');
  }

  /**
   * Get markdown heading prefix based on node type and depth
   */
  private getHeading(type: DocNodeType, depth: number): string {
    // Map depth to heading level (H2-H4)
    const level = Math.min(depth + 1, 4); // Cap at H4
    return '#'.repeat(level);
  }

  /**
   * Format a content block
   */
  private formatContent(content: ContentBlock): string {
    const parts: string[] = [];

    switch (content.type) {
      case ContentBlockType.PROSE:
        parts.push(content.content, DOUBLE_NEWLINE);
        break;

      case ContentBlockType.CODE:
        // Code block with language
        const lang = content.language || 'text';
        parts.push('```', lang, NEWLINE);
        parts.push(content.content, NEWLINE);
        parts.push('```', DOUBLE_NEWLINE);
        break;

      case ContentBlockType.DATA:
        // Data block (SQL, JSON, etc.) as inline comment
        const dataType = content.annotations?.get('type') || 'data';
        parts.push(NEWLINE, `// ${dataType}`, NEWLINE);
        parts.push('/*', NEWLINE);
        parts.push(content.content, NEWLINE);
        parts.push('*/', NEWLINE, NEWLINE);
        break;
    }

    return parts.join('');
  }

  /**
   * Stream large file writes
   */
  private async writeFileStream(filepath: string, content: string): Promise<void> {
    const readable = Readable.from([content]);
    const writable = createWriteStream(filepath, { encoding: 'utf-8' });
    await pipeline(readable, writable);
  }
}

/**
 * Format DocNode tree (convenience function)
 */
export async function formatDocNode(
  root: DocNode,
  options: FormatterOptions
): Promise<void> {
  const formatter = new UniversalFormatter(root, options);
  await formatter.generateAll();
}
