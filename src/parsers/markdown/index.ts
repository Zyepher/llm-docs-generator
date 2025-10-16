/**
 * Markdown Parser Implementation
 *
 * Implements the Parser interface for Markdown/DocC files.
 * Handles standard Markdown and Apple's DocC-flavored markdown.
 */

import { BaseParser, FormatType } from '../base.js';
import type { DocNode } from '../../core/models.js';
import { MarkdownParser } from './parser.js';
import { markdownToDocNode } from './adapter.js';
import { readdir } from 'fs/promises';
import { join } from 'path';

/**
 * Markdown format parser
 *
 * Handles Markdown files including DocC-flavored markdown
 */
export class MarkdownFormatParser extends BaseParser {
  readonly name = 'Markdown Parser';
  readonly format = FormatType.MARKDOWN;

  /**
   * Detect if source is a Markdown file or directory of Markdown files
   *
   * Performance: O(1) file extension + O(k) content sniffing (k = 100 bytes)
   */
  async detect(sourcePath: string): Promise<boolean> {
    // Check file extension
    const ext = this.getFileExtension(sourcePath);
    if (ext === 'md' || ext === 'markdown') {
      return await this.fileExists(sourcePath);
    }

    // Check if it's a directory (like TSPL.docc)
    try {
      const { stat } = await import('fs/promises');
      const stats = await stat(sourcePath);
      if (stats.isDirectory()) {
        // Check if directory contains .md files
        const files = await readdir(sourcePath);
        return files.some((f) => f.endsWith('.md'));
      }
    } catch {
      return false;
    }

    return false;
  }

  /**
   * Parse Markdown file(s) into unified DocNode IR
   *
   * Performance:
   * - Single file: O(n) where n = file size
   * - Directory: O(m * n) where m = files, n = avg file size
   */
  async parse(sourcePath: string): Promise<DocNode> {
    // Check if it's a file or directory
    const { stat } = await import('fs/promises');
    const stats = await stat(sourcePath);

    if (stats.isFile()) {
      // Parse single file
      return await this.parseSingleFile(sourcePath);
    } else if (stats.isDirectory()) {
      // Parse directory
      return await this.parseDirectory(sourcePath);
    }

    throw new Error(`Invalid source path: ${sourcePath}`);
  }

  /**
   * Parse a single markdown file
   */
  private async parseSingleFile(filePath: string): Promise<DocNode> {
    const parser = new MarkdownParser(filePath);
    const doc = await parser.parse();
    const docNode = markdownToDocNode(doc, {
      documentType: 'SECTION' as any,
      mapH2ToCategory: true,
    });
    return docNode;
  }

  /**
   * Parse a directory of markdown files
   *
   * Recursively finds all .md files and combines them
   */
  private async parseDirectory(dirPath: string): Promise<DocNode> {
    const files = await this.findMarkdownFiles(dirPath);

    if (files.length === 0) {
      throw new Error(`No markdown files found in ${dirPath}`);
    }

    // Parse all files
    const docs = await Promise.all(
      files.map(async (file) => {
        const parser = new MarkdownParser(file);
        return await parser.parse();
      })
    );

    // Merge into single root
    const { mergeMarkdownDocuments } = await import('./adapter.js');
    const dirName = dirPath.split('/').pop() || 'Documentation';
    return mergeMarkdownDocuments(docs, dirName);
  }

  /**
   * Find all .md files in directory recursively
   */
  private async findMarkdownFiles(dirPath: string): Promise<string[]> {
    const results: string[] = [];
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        // Recurse into subdirectories
        const subFiles = await this.findMarkdownFiles(fullPath);
        results.push(...subFiles);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }

    return results;
  }
}

// Export the parser instance
export const markdownParser = new MarkdownFormatParser();

// Re-export components
export { MarkdownParser } from './parser.js';
export { markdownToDocNode, convertSection, convertContent } from './adapter.js';
export type { MarkdownDocument, MarkdownSection, MarkdownContent } from './parser.js';
