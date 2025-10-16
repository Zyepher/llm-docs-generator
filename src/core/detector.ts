/**
 * Format Auto-Detection
 *
 * Automatically detects the format of input sources (OpenRef YAML, Markdown, etc.)
 * Uses file extensions, content sniffing, and parser detection methods.
 *
 * Performance: O(k) where k is a small constant (file extension check + first 200 bytes)
 */

import { FormatType } from '../parsers/base.js';
import { openRefParser } from '../parsers/openref/index.js';
import { markdownParser } from '../parsers/markdown/index.js';
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
    this.registerParser(markdownParser);
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
   * Performance: O(n * k) where n = parsers, k = detection cost per parser
   * Typically O(1) due to file extension check
   *
   * @param sourcePath - Path to source file or directory
   * @param hint - Optional format hint to skip detection
   * @returns Detected format type
   */
  async detect(
    sourcePath: string,
    hint?: FormatType
  ): Promise<FormatType> {
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
      if (parser && await parser.detect(sourcePath)) {
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
      `Unable to detect format for: ${sourcePath}\n` +
      `Supported formats: ${this.parsers.map((p) => p.format).join(', ')}\n` +
      `Try specifying --format explicitly`
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

      case 'md':
      case 'markdown':
        return FormatType.MARKDOWN;

      default:
        return FormatType.AUTO;
    }
  }

  /**
   * Get file extension
   */
  private getFileExtension(path: string): string {
    const parts = path.split('.');
    return parts.length > 1 ? parts[parts.length - 1] : '';
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
export async function detectFormat(
  sourcePath: string,
  hint?: FormatType
): Promise<FormatType> {
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
