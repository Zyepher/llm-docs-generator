/**
 * Core data models for LLM Documentation Generator
 *
 * This file contains:
 * 1. Unified Intermediate Representation (IR) - format-agnostic models
 * 2. Legacy OpenRef models - for backward compatibility
 *
 * Performance considerations:
 * - Zod schemas are created once and reused (O(1) schema lookup)
 * - Lazy validation only when needed
 * - Immutable data structures for safety
 * - Efficient property access patterns
 */

import { z } from 'zod';

// ============================================================================
// UNIFIED INTERMEDIATE REPRESENTATION (IR)
// ============================================================================

/**
 * Content block types within documentation
 * - prose: Descriptive text, explanations
 * - code: Code examples with language
 * - data: SQL schemas, JSON responses, etc.
 */
export enum ContentBlockType {
  PROSE = 'prose',
  CODE = 'code',
  DATA = 'data',
}

/**
 * ContentBlock - A single content element
 *
 * Can represent prose paragraphs, code blocks, data schemas, etc.
 * Format-agnostic representation used by all parsers.
 */
export const ContentBlockSchema = z.object({
  type: z.nativeEnum(ContentBlockType),
  language: z.string().optional(), // e.g., 'swift', 'sql', 'json'
  content: z.string(),
  annotations: z.map(z.string(), z.unknown()).optional(), // Flexible metadata
});

export type ContentBlock = z.infer<typeof ContentBlockSchema>;

/**
 * DocNode types representing the documentation hierarchy
 */
export enum DocNodeType {
  ROOT = 'root',         // Top-level document
  CATEGORY = 'category', // Major section (e.g., "Database Operations")
  SECTION = 'section',   // Subsection or chapter
  OPERATION = 'operation', // Single API method or topic
  ITEM = 'item',        // Individual example or detail
}

/**
 * DocNode - Universal documentation node
 *
 * Hierarchical tree structure that can represent:
 * - OpenRef: SDK → Category → Operation → Example
 * - Markdown: File → H2 → H3 → H4 → Code block
 * - Any other format with hierarchical structure
 *
 * Performance: O(1) access to children, O(log n) tree operations
 */
export const DocNodeSchema: z.ZodType<DocNode> = z.lazy(() =>
  z.object({
    type: z.nativeEnum(DocNodeType),
    id: z.string(),
    title: z.string(),
    description: z.string().default(''),
    content: z.array(ContentBlockSchema).default([]),
    children: z.array(DocNodeSchema).default([]),
    metadata: z.map(z.string(), z.unknown()).default(new Map()),
  })
);

export interface DocNode {
  type: DocNodeType;
  id: string;
  title: string;
  description: string;
  content: ContentBlock[];
  children: DocNode[];
  metadata: Map<string, unknown>;
}

/**
 * Builder for creating DocNodes with sensible defaults
 */
export function createDocNode(
  type: DocNodeType,
  id: string,
  title: string,
  options?: {
    description?: string;
    content?: ContentBlock[];
    children?: DocNode[];
    metadata?: Map<string, unknown>;
  }
): DocNode {
  return {
    type,
    id,
    title,
    description: options?.description ?? '',
    content: options?.content ?? [],
    children: options?.children ?? [],
    metadata: options?.metadata ?? new Map(),
  };
}

/**
 * Builder for creating ContentBlocks
 */
export function createContentBlock(
  type: ContentBlockType,
  content: string,
  options?: {
    language?: string;
    annotations?: Map<string, unknown>;
  }
): ContentBlock {
  return {
    type,
    content,
    language: options?.language,
    annotations: options?.annotations,
  };
}

/**
 * Type guard for DocNode
 */
export function isDocNode(obj: unknown): obj is DocNode {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'type' in obj &&
    'id' in obj &&
    'title' in obj &&
    'children' in obj &&
    Array.isArray((obj as DocNode).children)
  );
}

/**
 * Traverse DocNode tree depth-first
 * Performance: O(n) where n = total nodes
 */
export function traverseDocNode(
  node: DocNode,
  callback: (node: DocNode, depth: number) => void,
  depth = 0
): void {
  callback(node, depth);
  for (const child of node.children) {
    traverseDocNode(child, callback, depth + 1);
  }
}

/**
 * Find all nodes of a specific type
 * Performance: O(n) where n = total nodes
 */
export function findNodesByType(root: DocNode, type: DocNodeType): DocNode[] {
  const results: DocNode[] = [];
  traverseDocNode(root, (node) => {
    if (node.type === type) {
      results.push(node);
    }
  });
  return results;
}

/**
 * Count total nodes in tree
 * Performance: O(n)
 */
export function countNodes(root: DocNode): number {
  let count = 0;
  traverseDocNode(root, () => count++);
  return count;
}

// ============================================================================
// LEGACY OPENREF MODELS (for backward compatibility)
// ============================================================================

/**
 * @deprecated Use DocNode with ContentBlock instead
 * Kept for backward compatibility with existing OpenRef code
 */

/**
 * Code example with optional SQL context and response data
 *
 * Performance: Minimal schema overhead, defaults handled efficiently
 */
export const ExampleSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  description: z.string().default(''),
  dataSql: z.string().default(''),
  response: z.string().default(''),
  isSpotlight: z.boolean().default(false),
});

export type Example = z.infer<typeof ExampleSchema>;

/**
 * Type guard for Example (O(1) check without full validation)
 */
export function isExample(obj: unknown): obj is Example {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'id' in obj &&
    'name' in obj &&
    'code' in obj
  );
}

// ============================================================================
// OPERATION SCHEMA
// ============================================================================

/**
 * API operation containing multiple code examples
 *
 * Performance: Array operations optimized with proper typing
 */
export const OperationSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().default(''),
  notes: z.string().default(''),
  examples: z.array(ExampleSchema).default([]),
  overwriteParams: z.array(z.record(z.unknown())).default([]),
});

export type Operation = z.infer<typeof OperationSchema>;

/**
 * Type guard for Operation (O(1) check without full validation)
 */
export function isOperation(obj: unknown): obj is Operation {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'id' in obj &&
    'title' in obj &&
    'examples' in obj &&
    Array.isArray((obj as Operation).examples)
  );
}

/**
 * Get spotlight examples efficiently (O(n) single pass)
 */
export function getSpotlightExamples(operation: Operation): Example[] {
  return operation.examples.filter((ex) => ex.isSpotlight);
}

/**
 * Count examples efficiently (O(1) array length access)
 */
export function getExampleCount(operation: Operation): number {
  return operation.examples.length;
}

// ============================================================================
// SPEC INFO SCHEMA
// ============================================================================

/**
 * Specification metadata from OpenRef format
 */
export const SpecInfoSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  specUrl: z.string().optional(),
  slugPrefix: z.string().default('/'),
  libraries: z.array(z.record(z.string())).default([]),
});

export type SpecInfo = z.infer<typeof SpecInfoSchema>;

// ============================================================================
// SPEC DATA SCHEMA
// ============================================================================

/**
 * Complete parsed specification with all operations
 *
 * Performance:
 * - Pre-computed operation map for O(1) lookups
 * - Cached total examples count
 */
export interface SpecData {
  info: SpecInfo;
  operations: Operation[];
  _operationMap?: Map<string, Operation>; // Cached for O(1) lookup
  _totalExamples?: number; // Cached count
}

/**
 * Create SpecData with performance optimizations
 * Builds operation map for O(1) lookups vs O(n) linear search
 */
export function createSpecData(info: SpecInfo, operations: Operation[]): SpecData {
  // Pre-build operation map for efficient lookups (O(n) once vs O(n) per lookup)
  const operationMap = new Map<string, Operation>();
  let totalExamples = 0;

  for (const op of operations) {
    operationMap.set(op.id, op);
    totalExamples += op.examples.length;
  }

  return {
    info,
    operations,
    _operationMap: operationMap,
    _totalExamples: totalExamples,
  };
}

/**
 * Get operation by ID (O(1) with cached map vs O(n) linear search)
 */
export function getOperationById(
  specData: SpecData,
  operationId: string
): Operation | undefined {
  // Use cached map if available (O(1))
  if (specData._operationMap !== undefined) {
    return specData._operationMap.get(operationId);
  }

  // Fallback to linear search (O(n)) and build cache
  const op = specData.operations.find((o) => o.id === operationId);

  // Build cache for future lookups
  if (specData._operationMap === undefined) {
    specData._operationMap = new Map(
      specData.operations.map((o) => [o.id, o])
    );
  }

  return op;
}

/**
 * Get multiple operations by IDs (O(k) where k = ids.length, using cached map)
 * More efficient than multiple individual lookups
 */
export function getOperationsByIds(
  specData: SpecData,
  operationIds: string[]
): Operation[] {
  // Ensure map is built (O(n) once)
  if (specData._operationMap === undefined) {
    specData._operationMap = new Map(
      specData.operations.map((o) => [o.id, o])
    );
  }

  // Collect operations (O(k) where k = operationIds.length)
  const result: Operation[] = [];
  for (const id of operationIds) {
    const op = specData._operationMap.get(id);
    if (op !== undefined) {
      result.push(op);
    }
  }

  return result;
}

/**
 * Get total examples count (O(1) with cache)
 */
export function getTotalExamples(specData: SpecData): number {
  // Return cached value if available
  if (specData._totalExamples !== undefined) {
    return specData._totalExamples;
  }

  // Calculate and cache
  const total = specData.operations.reduce(
    (sum, op) => sum + op.examples.length,
    0
  );

  specData._totalExamples = total;
  return total;
}

/**
 * Check if operation exists (O(1) with cached map)
 */
export function hasOperation(specData: SpecData, operationId: string): boolean {
  return getOperationById(specData, operationId) !== undefined;
}

// ============================================================================
// UTILITY TYPES
// ============================================================================

/**
 * Operation categorization result for formatter
 * Using Map for O(1) category lookups vs object property access
 */
export type CategorizedOperations = Map<string, Operation[]>;

/**
 * Create empty categorized operations map
 */
export function createCategorizedOperations(): CategorizedOperations {
  return new Map();
}

/**
 * Add operation to category (O(1) map operations)
 */
export function addOperationToCategory(
  categorized: CategorizedOperations,
  category: string,
  operation: Operation
): void {
  const existing = categorized.get(category);

  if (existing !== undefined) {
    existing.push(operation);
  } else {
    categorized.set(category, [operation]);
  }
}

/**
 * Get operations for category with fallback (O(1) lookup)
 */
export function getOperationsForCategory(
  categorized: CategorizedOperations,
  category: string
): Operation[] {
  return categorized.get(category) ?? [];
}
