/**
 * Markdown Parser Implementation
 *
 * Implements the Parser interface for Markdown/MDX/DocC files.
 * Handles standard Markdown, MDX cleanup, and Apple's DocC-flavored markdown.
 */

import { BaseParser, FormatType } from '../base.js';
import { DocNodeType, type DocNode } from '../../core/models.js';
import { MarkdownParser } from './parser.js';
import { markdownToDocNode } from './adapter.js';

import {
  directoryContainsMatchingFile,
  findFilesRecursively,
} from '../../utils/traversal.js';

/**
 * Markdown format parser
 *
 * Handles Markdown files including MDX and DocC-flavored markdown
 */
export class MarkdownFormatParser extends BaseParser {
  readonly name = 'Markdown Parser';
  readonly format = FormatType.MARKDOWN;

  /**
   * Detect if source is a Markdown/MDX file or directory of Markdown/MDX files
   *
   * Performance: O(1) file extension + O(k) content sniffing (k = 100 bytes)
   */
  async detect(sourcePath: string): Promise<boolean> {
    // Check file extension
    const ext = this.getFileExtension(sourcePath);
    if (this.isMarkdownFileExtension(ext)) {
      return await this.fileExists(sourcePath);
    }

    // Check if it's a directory (like TSPL.docc)
    try {
      const { stat } = await import('node:fs/promises');
      const stats = await stat(sourcePath);
      if (stats.isDirectory()) {
        // Check if directory contains Markdown/MDX files
        return await directoryContainsMatchingFile(sourcePath, (fileName) =>
          this.isMarkdownFileName(fileName)
        );
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
    const { stat } = await import('node:fs/promises');
    const stats = await stat(sourcePath);

    if (stats.isFile()) {
      // Parse single file
      return await this.parseSingleFile(sourcePath);
    }if (stats.isDirectory()) {
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
      documentType: DocNodeType.SECTION,
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
    const files = (
      await findFilesRecursively(dirPath, (fileName) => this.isMarkdownFileName(fileName))
    ).sort();

    if (files.length === 0) {
      throw new Error(`No markdown or MDX files found in ${dirPath}`);
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

  private isMarkdownFileName(fileName: string): boolean {
    return this.isMarkdownFileExtension(this.getFileExtension(fileName));
  }

  private isMarkdownFileExtension(extension: string): boolean {
    return extension === 'md' || extension === 'mdx' || extension === 'markdown';
  }
}

// Export the parser instance
export const markdownParser = new MarkdownFormatParser();
