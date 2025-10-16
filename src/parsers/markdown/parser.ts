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

import { readFile } from 'fs/promises';
import { marked } from 'marked';

/**
 * Parsed markdown document structure
 */
export interface MarkdownDocument {
  path: string;
  title: string;
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

    // Clean DocC directives and test comments
    const cleaned = this.cleanDocCContent(content);

    // Parse with marked
    const tokens = marked.lexer(cleaned);

    // Extract title (first H1 or filename)
    const title = this.extractTitle(tokens, this.filePath);

    // Build hierarchical sections
    const sections = this.buildSections(tokens);

    // Extract metadata
    const metadata = this.extractMetadata(content);

    return {
      path: this.filePath,
      title,
      sections,
      metadata,
    };
  }

  /**
   * Clean DocC-specific syntax and test comments
   *
   * Removes:
   * - @Metadata blocks
   * - <doc:...> cross-references (keep text)
   * - <!-- test comments -->
   * - @Options directives
   *
   * Performance: O(n) - single pass with regex
   */
  private cleanDocCContent(content: string): string {
    let cleaned = content;

    // Remove @Metadata blocks
    cleaned = cleaned.replace(/@Metadata\s*\{[^}]*\}/gs, '');

    // Remove @Options blocks
    cleaned = cleaned.replace(/@Options\([^)]*\)\s*\{[^}]*\}/gs, '');

    // Convert <doc:Reference> to just "Reference"
    cleaned = cleaned.replace(/<doc:([^>]+)>/g, '$1');

    // Remove HTML test comments (<!-- ... -->)
    cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '');

    // Remove empty lines (more than 2 consecutive)
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    return cleaned.trim();
  }

  /**
   * Extract document title
   *
   * Performance: O(k) where k = number of tokens until first H1
   */
  private extractTitle(tokens: marked.Token[], filePath: string): string {
    // Find first heading
    for (const token of tokens) {
      if (token.type === 'heading' && token.depth === 1) {
        return token.text;
      }
    }

    // Fallback to filename
    const parts = filePath.split('/');
    const filename = parts[parts.length - 1];
    return filename.replace(/\.md$/, '');
  }

  /**
   * Extract metadata from frontmatter or content
   *
   * Performance: O(k) where k = small constant (frontmatter size)
   */
  private extractMetadata(content: string): Map<string, unknown> {
    const metadata = new Map<string, unknown>();

    // Check for YAML frontmatter (--- at start)
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      // Simple key-value parsing (could use yaml parser for complex cases)
      const lines = frontmatterMatch[1].split('\n');
      for (const line of lines) {
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
          const key = line.substring(0, colonIndex).trim();
          const value = line.substring(colonIndex + 1).trim();
          metadata.set(key, value);
        }
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
  private buildSections(tokens: marked.Token[]): MarkdownSection[] {
    const rootSections: MarkdownSection[] = [];
    const stack: MarkdownSection[] = [];
    let currentContent: MarkdownContent[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];

      if (token.type === 'heading') {
        // Save accumulated content to previous section
        if (stack.length > 0 && currentContent.length > 0) {
          stack[stack.length - 1].content.push(...currentContent);
          currentContent = [];
        }

        // Create new section
        const section: MarkdownSection = {
          level: token.depth,
          title: token.text,
          id: this.slugify(token.text),
          content: [],
          children: [],
        };

        // Pop stack until we find the parent level
        while (stack.length > 0 && stack[stack.length - 1].level >= token.depth) {
          stack.pop();
        }

        // Add as child of parent or as root
        if (stack.length > 0) {
          stack[stack.length - 1].children.push(section);
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

    // Add remaining content to last section
    if (stack.length > 0 && currentContent.length > 0) {
      stack[stack.length - 1].content.push(...currentContent);
    }

    return rootSections;
  }

  /**
   * Convert marked token to MarkdownContent
   *
   * Performance: O(1)
   */
  private tokenToContent(token: marked.Token): MarkdownContent | null {
    switch (token.type) {
      case 'code':
        return {
          type: 'code',
          content: token.text,
          language: token.lang || 'text',
        };

      case 'paragraph':
      case 'text':
        return {
          type: 'prose',
          content: token.text || (token as marked.Tokens.Text).text,
        };

      case 'blockquote':
        // Extract text from blockquote
        const text = token.text || '';
        return {
          type: 'blockquote',
          content: text,
        };

      case 'space':
        // Skip whitespace tokens
        return null;

      default:
        // Convert other tokens to prose
        const tokenText = (token as any).text || (token as any).raw || '';
        if (tokenText.trim()) {
          return {
            type: 'prose',
            content: tokenText,
          };
        }
        return null;
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

/**
 * Parse markdown file (convenience function)
 */
export async function parseMarkdownFile(filePath: string): Promise<MarkdownDocument> {
  const parser = new MarkdownParser(filePath);
  return await parser.parse();
}
