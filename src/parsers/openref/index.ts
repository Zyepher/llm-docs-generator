/**
 * OpenRef Parser Implementation
 *
 * Implements the Parser interface for OpenRef YAML specifications.
 * Uses the legacy OpenRefParser internally and adapts output to DocNode IR.
 */

import { BaseParser, FormatType } from '../base.js';
import type { DocNode } from '../../core/models.js';
import { OpenRefParser } from './parser.js';
import { openRefToDocNode } from './adapter.js';

/**
 * OpenRef format parser
 *
 * Handles OpenRef YAML specification files (used by Supabase and others)
 */
export class OpenRefFormatParser extends BaseParser {
  readonly name = 'OpenRef Parser';
  readonly format = FormatType.OPENREF;

  /**
   * Detect if source is an OpenRef YAML file
   *
   * Performance: O(1) file extension + O(k) content sniffing (k = 100 bytes)
   */
  async detect(sourcePath: string): Promise<boolean> {
    // Check file extension
    const ext = this.getFileExtension(sourcePath);
    if (ext !== 'yml' && ext !== 'yaml') {
      return false;
    }

    // Check if file exists
    if (!(await this.fileExists(sourcePath))) {
      return false;
    }

    // Sniff content for OpenRef structure
    try {
      const head = await this.readFileHead(sourcePath, 200);

      // Look for OpenRef-specific markers
      const hasInfo = head.includes('info:');
      const hasFunctions = head.includes('functions:');
      const hasId = head.includes('id:');

      return hasInfo || hasFunctions || hasId;
    } catch {
      return false;
    }
  }

  /**
   * Parse OpenRef YAML into unified DocNode IR
   *
   * Performance: O(n) where n = spec size
   * Delegates to legacy OpenRefParser then converts to IR
   */
  async parse(sourcePath: string): Promise<DocNode> {
    // Use legacy parser
    const parser = new OpenRefParser(sourcePath);
    const specData = await parser.parse();

    // Convert to IR
    // Note: We don't have category mapping here yet
    // That will come from config in the full pipeline
    const docNode = openRefToDocNode(specData);

    return docNode;
  }

  /**
   * Parse with category mapping (extended method)
   *
   * This allows organizing operations by category when config is available
   */
  async parseWithCategories(
    sourcePath: string,
    categoryMap: Map<string, string[]>
  ): Promise<DocNode> {
    const parser = new OpenRefParser(sourcePath);
    const specData = await parser.parse();
    const docNode = openRefToDocNode(specData, categoryMap);
    return docNode;
  }
}

// Export the parser instance
export const openRefParser = new OpenRefFormatParser();

// Re-export components for backward compatibility
export { OpenRefParser } from './parser.js';
export { openRefToDocNode, convertOperation, convertExample } from './adapter.js';
export type { SpecData, Operation, Example, SpecInfo } from '../../core/models.js';
