/**
 * Base Parser Interface
 *
 * Defines the contract that all format-specific parsers must implement.
 * Each parser is responsible for converting its specific format into
 * the unified DocNode intermediate representation.
 */

import type { DocNode } from '../core/models.js';

/**
 * Format types supported by the generator
 */
export enum FormatType {
  OPENREF = 'openref',
  MARKDOWN = 'markdown',
  AUTO = 'auto',
}

/**
 * Parser interface that all format parsers must implement
 *
 * Performance: Parsers should be stateless and reusable
 */
export interface Parser {
  /**
   * Human-readable name of the parser
   */
  readonly name: string;

  /**
   * Format type this parser handles
   */
  readonly format: FormatType;

  /**
   * Detect if this parser can handle the given source
   *
   * @param sourcePath - Path to the source file or directory
   * @returns true if this parser can handle the source
   *
   * Performance: Should be fast (O(1) file extension check + O(k) content sniffing)
   * where k is a small constant (e.g., first 100 bytes)
   */
  detect(sourcePath: string): Promise<boolean>;

  /**
   * Parse the source into unified DocNode representation
   *
   * @param sourcePath - Path to the source file or directory
   * @returns Root DocNode containing the parsed documentation tree
   *
   * Performance: O(n) where n = content size
   * Should use streaming/lazy loading for large files
   */
  parse(sourcePath: string): Promise<DocNode>;

  /**
   * Validate that the source is well-formed (optional)
   *
   * @param sourcePath - Path to the source file or directory
   * @returns Validation result with any errors/warnings
   *
   * Performance: Similar to parse but may skip some transformations
   */
  validate?(sourcePath: string): Promise<ValidationResult>;
}

/**
 * Validation result from parser
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  message: string;
  location?: {
    file?: string;
    line?: number;
    column?: number;
  };
}

export interface ValidationWarning {
  message: string;
  location?: {
    file?: string;
    line?: number;
    column?: number;
  };
}

/**
 * Abstract base class for parsers with common functionality
 *
 * Parsers can extend this class to inherit utility methods
 */
export abstract class BaseParser implements Parser {
  abstract readonly name: string;
  abstract readonly format: FormatType;

  abstract detect(sourcePath: string): Promise<boolean>;
  abstract parse(sourcePath: string): Promise<DocNode>;

  /**
   * Helper: Check if file exists
   */
  protected async fileExists(path: string): Promise<boolean> {
    try {
      const { access } = await import('fs/promises');
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Helper: Read file content
   */
  protected async readFile(path: string): Promise<string> {
    const { readFile } = await import('fs/promises');
    return await readFile(path, 'utf-8');
  }

  /**
   * Helper: Read first N bytes of file for content sniffing
   */
  protected async readFileHead(path: string, bytes = 100): Promise<string> {
    const { readFile } = await import('fs/promises');
    const content = await readFile(path, 'utf-8');
    return content.substring(0, bytes);
  }

  /**
   * Helper: Get file extension
   */
  protected getFileExtension(path: string): string {
    const parts = path.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
  }

  /**
   * Default validation implementation
   * Subclasses can override for format-specific validation
   */
  async validate(sourcePath: string): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // Check if file exists
    if (!(await this.fileExists(sourcePath))) {
      errors.push({
        message: `Source file not found: ${sourcePath}`,
      });
      return { valid: false, errors, warnings };
    }

    // Try parsing
    try {
      await this.parse(sourcePath);
      return { valid: true, errors, warnings };
    } catch (error) {
      errors.push({
        message: error instanceof Error ? error.message : String(error),
      });
      return { valid: false, errors, warnings };
    }
  }
}

/**
 * Parser registry error
 */
export class ParserError extends Error {
  constructor(message: string, public readonly parser?: string) {
    super(message);
    this.name = 'ParserError';
  }
}
