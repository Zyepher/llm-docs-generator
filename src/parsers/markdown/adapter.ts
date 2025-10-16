/**
 * Markdown → IR Adapter
 *
 * Converts parsed MarkdownDocument into the unified DocNode intermediate representation.
 *
 * Mapping:
 * - MarkdownDocument → DocNode (ROOT or SECTION based on context)
 * - MarkdownSection (H2) → DocNode (CATEGORY or SECTION)
 * - MarkdownSection (H3) → DocNode (OPERATION or SECTION)
 * - MarkdownSection (H4) → DocNode (ITEM)
 * - MarkdownContent → ContentBlock
 */

import type {
  MarkdownDocument,
  MarkdownSection,
  MarkdownContent,
} from './parser.js';

import {
  DocNode,
  DocNodeType,
  ContentBlock,
  ContentBlockType,
  createDocNode,
  createContentBlock,
} from '../../core/models.js';

/**
 * Convert MarkdownDocument to unified DocNode IR
 *
 * Performance: O(n) where n = total sections + content blocks
 *
 * @param doc - Parsed markdown document
 * @param options - Conversion options
 * @returns Root DocNode representing the document
 */
export function markdownToDocNode(
  doc: MarkdownDocument,
  options?: {
    documentType?: DocNodeType; // ROOT or SECTION
    mapH2ToCategory?: boolean; // Treat H2 as CATEGORY vs SECTION
  }
): DocNode {
  const docType = options?.documentType ?? DocNodeType.SECTION;
  const metadata = new Map(doc.metadata);
  metadata.set('format', 'markdown');
  metadata.set('path', doc.path);

  const root = createDocNode(
    docType,
    extractIdFromPath(doc.path),
    doc.title,
    {
      metadata,
    }
  );

  // Convert each top-level section
  root.children = doc.sections.map((section) =>
    convertSection(section, options?.mapH2ToCategory ?? false)
  );

  return root;
}

/**
 * Extract ID from file path
 *
 * @param path - File path
 * @returns ID derived from filename
 */
function extractIdFromPath(path: string): string {
  const parts = path.split('/');
  const filename = parts[parts.length - 1];
  return filename.replace(/\.md$/, '').toLowerCase().replace(/\s+/g, '-');
}

/**
 * Convert MarkdownSection to DocNode
 *
 * Maps heading levels to node types:
 * - H1: SECTION (usually document title, becomes root)
 * - H2: CATEGORY or SECTION (based on mapH2ToCategory)
 * - H3: OPERATION or SECTION
 * - H4+: ITEM
 *
 * Performance: O(n) where n = total content + children
 */
export function convertSection(
  section: MarkdownSection,
  mapH2ToCategory: boolean
): DocNode {
  // Determine node type based on heading level
  let nodeType: DocNodeType;
  if (section.level === 2 && mapH2ToCategory) {
    nodeType = DocNodeType.CATEGORY;
  } else if (section.level === 3) {
    nodeType = DocNodeType.OPERATION;
  } else if (section.level >= 4) {
    nodeType = DocNodeType.ITEM;
  } else {
    nodeType = DocNodeType.SECTION;
  }

  // Convert content blocks
  const content = section.content.map((c) => convertContent(c));

  // Convert child sections recursively
  const children = section.children.map((child) =>
    convertSection(child, mapH2ToCategory)
  );

  const metadata = new Map<string, unknown>();
  metadata.set('level', section.level);

  return createDocNode(
    nodeType,
    section.id,
    section.title,
    {
      content,
      children,
      metadata,
    }
  );
}

/**
 * Convert MarkdownContent to ContentBlock
 *
 * Performance: O(1)
 */
export function convertContent(content: MarkdownContent): ContentBlock {
  switch (content.type) {
    case 'code':
      return createContentBlock(
        ContentBlockType.CODE,
        content.content,
        {
          language: content.language || 'text',
        }
      );

    case 'prose':
      return createContentBlock(
        ContentBlockType.PROSE,
        content.content
      );

    case 'blockquote':
      // Treat blockquotes as prose with annotation
      return createContentBlock(
        ContentBlockType.PROSE,
        content.content,
        {
          annotations: new Map([['style', 'blockquote']]),
        }
      );

    case 'image':
      // Treat images as data blocks
      return createContentBlock(
        ContentBlockType.DATA,
        content.content,
        {
          annotations: new Map([['type', 'image']]),
        }
      );

    default:
      return createContentBlock(
        ContentBlockType.PROSE,
        content.content
      );
  }
}

/**
 * Merge multiple markdown documents into a single root DocNode
 *
 * Useful for parsing multiple files (like swift-book's multiple chapters)
 *
 * Performance: O(n * m) where n = documents, m = avg sections per document
 *
 * @param docs - Array of parsed markdown documents
 * @param rootTitle - Title for the combined root node
 * @returns Combined root DocNode
 */
export function mergeMarkdownDocuments(
  docs: MarkdownDocument[],
  rootTitle: string
): DocNode {
  const root = createDocNode(
    DocNodeType.ROOT,
    'root',
    rootTitle,
    {
      metadata: new Map([['format', 'markdown'], ['count', docs.length]]),
    }
  );

  // Convert each document to a SECTION node
  root.children = docs.map((doc) => markdownToDocNode(doc, {
    documentType: DocNodeType.SECTION,
    mapH2ToCategory: false,
  }));

  return root;
}

/**
 * Convert DocNode back to MarkdownDocument (for testing/export)
 *
 * This is mainly for validation purposes
 *
 * @param node - DocNode to convert
 * @returns MarkdownDocument
 */
export function docNodeToMarkdown(node: DocNode): MarkdownDocument {
  // Note: This is a lossy conversion
  // Implement only if needed for export/testing
  throw new Error('docNodeToMarkdown not yet implemented');
}
