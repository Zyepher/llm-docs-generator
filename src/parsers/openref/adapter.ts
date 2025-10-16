/**
 * OpenRef → IR Adapter
 *
 * Converts OpenRef SpecData into the unified DocNode intermediate representation.
 * This allows the formatter to work with a format-agnostic structure.
 *
 * Mapping:
 * - SpecData → DocNode (ROOT)
 * - Category → DocNode (CATEGORY)
 * - Operation → DocNode (OPERATION)
 * - Example → DocNode (ITEM) with code ContentBlocks
 */

import type {
  SpecData,
  Operation,
  Example,
} from '../../core/models.js';

import {
  DocNode,
  DocNodeType,
  ContentBlock,
  ContentBlockType,
  createDocNode,
  createContentBlock,
} from '../../core/models.js';

/**
 * Convert OpenRef SpecData to unified DocNode IR
 *
 * Performance: O(n * m) where n = operations, m = examples per operation
 * Same complexity as the original structure traversal
 *
 * @param specData - Parsed OpenRef specification
 * @param categoryMap - Optional category groupings (from config)
 * @returns Root DocNode representing the entire SDK documentation
 */
export function openRefToDocNode(
  specData: SpecData,
  categoryMap?: Map<string, string[]>
): DocNode {
  const metadata = new Map<string, unknown>();
  metadata.set('format', 'openref');
  metadata.set('sdk', specData.info.id);
  metadata.set('title', specData.info.title);
  metadata.set('specUrl', specData.info.specUrl);

  const root = createDocNode(
    DocNodeType.ROOT,
    specData.info.id,
    specData.info.title,
    {
      description: specData.info.description,
      metadata,
    }
  );

  // If we have category mappings, organize by category
  if (categoryMap && categoryMap.size > 0) {
    root.children = convertWithCategories(specData, categoryMap);
  } else {
    // Otherwise, treat each operation as a top-level section
    root.children = specData.operations.map((op) => convertOperation(op));
  }

  return root;
}

/**
 * Convert operations grouped by categories
 *
 * @param specData - Parsed OpenRef specification
 * @param categoryMap - Map of category name to operation IDs
 * @returns Array of category DocNodes
 */
function convertWithCategories(
  specData: SpecData,
  categoryMap: Map<string, string[]>
): DocNode[] {
  const categoryNodes: DocNode[] = [];

  // Build operation lookup map
  const operationMap = specData._operationMap ?? new Map(
    specData.operations.map((op) => [op.id, op])
  );

  for (const [categoryName, operationIds] of categoryMap.entries()) {
    const operations: Operation[] = [];

    // Collect operations for this category
    for (const opId of operationIds) {
      const op = operationMap.get(opId);
      if (op) {
        operations.push(op);
      }
    }

    if (operations.length === 0) continue;

    // Create category node
    const categoryNode = createDocNode(
      DocNodeType.CATEGORY,
      categoryName,
      categoryName,
      {
        children: operations.map((op) => convertOperation(op)),
      }
    );

    categoryNodes.push(categoryNode);
  }

  return categoryNodes;
}

/**
 * Convert single OpenRef Operation to DocNode
 *
 * Performance: O(k) where k = number of examples
 *
 * @param operation - OpenRef operation
 * @returns DocNode representing the operation
 */
export function convertOperation(operation: Operation): DocNode {
  const metadata = new Map<string, unknown>();
  metadata.set('operationId', operation.id);
  metadata.set('notes', operation.notes);

  // Convert examples to child nodes
  const children = operation.examples.map((example) => convertExample(example));

  // Add description as prose content if present
  const content: ContentBlock[] = [];
  if (operation.description) {
    content.push(
      createContentBlock(ContentBlockType.PROSE, operation.description)
    );
  }
  if (operation.notes) {
    content.push(
      createContentBlock(ContentBlockType.PROSE, operation.notes)
    );
  }

  return createDocNode(
    DocNodeType.OPERATION,
    operation.id,
    operation.title,
    {
      description: operation.description,
      content,
      children,
      metadata,
    }
  );
}

/**
 * Convert single OpenRef Example to DocNode (ITEM)
 *
 * Performance: O(1)
 *
 * @param example - OpenRef example
 * @returns DocNode representing the example
 */
export function convertExample(example: Example): DocNode {
  const metadata = new Map<string, unknown>();
  metadata.set('exampleId', example.id);
  metadata.set('isSpotlight', example.isSpotlight);

  const content: ContentBlock[] = [];

  // Add description as prose if present
  if (example.description) {
    content.push(
      createContentBlock(ContentBlockType.PROSE, example.description)
    );
  }

  // Add code block
  if (example.code) {
    // Try to infer language from code content or use generic
    const language = inferLanguage(example.code);
    content.push(
      createContentBlock(ContentBlockType.CODE, example.code, { language })
    );
  }

  // Add SQL schema as data block if present
  if (example.dataSql) {
    content.push(
      createContentBlock(ContentBlockType.DATA, example.dataSql, {
        language: 'sql',
        annotations: new Map([['type', 'schema']]),
      })
    );
  }

  // Add JSON response as data block if present
  if (example.response) {
    content.push(
      createContentBlock(ContentBlockType.DATA, example.response, {
        language: 'json',
        annotations: new Map([['type', 'response']]),
      })
    );
  }

  return createDocNode(
    DocNodeType.ITEM,
    example.id,
    example.name,
    {
      description: example.description,
      content,
      metadata,
    }
  );
}

/**
 * Infer programming language from code content
 *
 * Simple heuristics - can be enhanced
 *
 * @param code - Code snippet
 * @returns Language identifier
 */
function inferLanguage(code: string): string {
  // Check for language-specific patterns
  if (code.includes('const ') || code.includes('let ') || code.includes('async ')) {
    return 'javascript';
  }
  if (code.includes('func ') || code.includes('let ') && code.includes(':')) {
    return 'swift';
  }
  if (code.includes('def ') || code.includes('import ') && code.includes('from ')) {
    return 'python';
  }
  if (code.includes('public class') || code.includes('private val')) {
    return 'kotlin';
  }
  if (code.includes('class ') && code.includes('{') || code.includes('using ')) {
    return 'csharp';
  }
  if (code.includes('void ') || code.includes('Future<')) {
    return 'dart';
  }

  // Default to generic code
  return 'code';
}

/**
 * Convert DocNode back to OpenRef SpecData (for backward compatibility)
 *
 * This is mainly for testing and validation purposes.
 *
 * @param root - Root DocNode
 * @returns OpenRef SpecData
 */
export function docNodeToOpenRef(root: DocNode): SpecData {
  // Note: This is a lossy conversion since DocNode is more generic
  // Only implement if needed for backward compatibility tests
  throw new Error('docNodeToOpenRef not yet implemented');
}
