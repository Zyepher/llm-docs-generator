/**
 * Format Auto-Detection
 *
 * Automatically detects the format of input sources (OpenRef YAML, Markdown, etc.)
 * Uses file extensions and parser detection methods. Structured formats such
 * as OpenRef, OpenAPI, and Swagger inspect parsed local file content so YAML
 * files are classified by shape instead of extension alone.
 *
 * Performance: O(p * n) worst case where p = registered parsers and n = local
 * file content size for parsers that need structured content inspection.
 */

import { FormatType } from '../parsers/base.js';
import { openApiParser } from '../parsers/openapi/index.js';
import { openRefParser } from '../parsers/openref/index.js';
import { markdownParser } from '../parsers/markdown/index.js';
import { rstParser } from '../parsers/rst/index.js';
import { htmlParser } from '../parsers/html/index.js';
import type { Parser } from '../parsers/base.js';

/**
 * Format Detector
 *
 * Detects the format of a given source path
 */
export class FormatDetector {
  private readonly parsers: Parser[] = [];

  constructor() {
    // Register available parsers
    this.registerParser(openRefParser);
    this.registerParser(openApiParser);
    this.registerParser(markdownParser);
    this.registerParser(rstParser);
    this.registerParser(htmlParser);
  }

  /**
   * Register a parser for detection
   */
  registerParser(parser: Parser): void {
    this.parsers.push(parser);
  }

  /**
   * Detect format of source
   *
   * Strategy:
   * 1. Try file extension quick check
   * 2. Ask each parser if it can handle the source
   * 3. Return first parser that matches
   *
   * Performance: O(p * n) worst case where p = parsers and n = content size
   * for parsers that need structured content inspection.
   *
   * @param sourcePath - Path to source file or directory
   * @param hint - Optional format hint to skip detection
   * @returns Detected format type
   */
  async detect(sourcePath: string, hint?: FormatType): Promise<FormatType> {
    // If hint provided and not AUTO, use it
    if (hint && hint !== FormatType.AUTO) {
      return hint;
    }

    // Quick file extension check
    const ext = this.getFileExtension(sourcePath);
    const quickGuess = this.guessFromExtension(ext);
    if (quickGuess !== FormatType.AUTO) {
      // Verify with parser
      const parser = this.getParserForFormat(quickGuess);
      if (parser && (await parser.detect(sourcePath))) {
        return quickGuess;
      }
    }

    // Ask each parser
    for (const parser of this.parsers) {
      if (await parser.detect(sourcePath)) {
        return parser.format;
      }
    }

    // Could not detect
    throw new Error(
      `Unable to detect format for: ${sourcePath}\nSupported formats: ${this.parsers.map((p) => p.format).join(', ')}\nTry specifying --format explicitly`
    );
  }

  /**
   * Get parser for a specific format
   */
  getParserForFormat(format: FormatType): Parser | undefined {
    return this.parsers.find((p) => p.format === format);
  }

  /**
   * Get all available formats
   */
  getAvailableFormats(): FormatType[] {
    return this.parsers.map((p) => p.format);
  }

  /**
   * Get all registered parsers
   */
  getParsers(): Parser[] {
    return [...this.parsers];
  }

  /**
   * Quick format guess from file extension
   *
   * Performance: O(1)
   */
  private guessFromExtension(ext: string): FormatType {
    const normalized = ext.toLowerCase();

    switch (normalized) {
      case 'yml':
      case 'yaml':
        return FormatType.OPENREF;

      case 'json':
        return FormatType.OPENAPI;

      case 'md':
      case 'mdx':
      case 'markdown':
        return FormatType.MARKDOWN;

      case 'rst':
        return FormatType.RST;

      case 'html':
      case 'htm':
        return FormatType.HTML;

      default:
        return FormatType.AUTO;
    }
  }

  /**
   * Get file extension
   */
  private getFileExtension(path: string): string {
    // Take the extension from the basename so a dotted parent directory
    // (e.g. /a.b/file) does not yield a slash-containing "extension", and treat
    // a leading-dot dotfile (.env) as having no extension.
    const base = path.split(/[\\/]/).pop() ?? '';
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  }
}

// Singleton instance
let detectorInstance: FormatDetector | null = null;

/**
 * Get the global format detector instance
 */
export function getFormatDetector(): FormatDetector {
  if (!detectorInstance) {
    detectorInstance = new FormatDetector();
  }
  return detectorInstance;
}

/**
 * Detect format (convenience function)
 */
export async function detectFormat(sourcePath: string, hint?: FormatType): Promise<FormatType> {
  const detector = getFormatDetector();
  return await detector.detect(sourcePath, hint);
}

/**
 * Get parser for format (convenience function)
 */
export function getParserForFormat(format: FormatType): Parser | undefined {
  const detector = getFormatDetector();
  return detector.getParserForFormat(format);
}
