/**
 * Deterministic semantic chunking for DocNode IR.
 *
 * The chunker is a library capability only. It does not select sources, write
 * manifests, or change CLI generation behavior.
 */

import { isRecord } from '../utils/guards.js';
import { sha256Hex } from '../utils/hash.js';
import { DEFAULT_ESTIMATED_CHARACTERS_PER_TOKEN, estimateTokenCount } from '../utils/text-metrics.js';
import { ContentBlockType, type ContentBlock, type DocNode } from './models.js';

const DOUBLE_NEWLINE = '\n\n';
const GENERATED_SPLIT_SEGMENT_PREFIX = '~chunk-';

export const DEFAULT_CHUNK_MAX_CHARACTERS = 8000;

export type SemanticChunkWarningCode =
  | 'context_exceeds_max_characters'
  | 'cycle_detected'
  | 'duplicate_node_id'
  | 'hard_text_split'
  | 'malformed_children'
  | 'malformed_content'
  | 'malformed_content_block'
  | 'oversized_indivisible_block';

export interface SemanticChunkWarning {
  code: SemanticChunkWarningCode;
  message: string;
  nodePath: string[];
  chunkId?: string;
}

export interface SemanticChunkSource {
  format?: string;
  path?: string;
}

export interface SemanticChunkMetadata {
  nodeId: string;
  nodeType: string;
  sectionPath: string;
  splitIndex: number;
  splitCount: number;
  maxCharacters: number;
  oversized: boolean;
  blockTypes: string[];
}

export interface SemanticChunk {
  id: string;
  ordinal: number;
  title: string;
  path: string[];
  nodePath: string[];
  sourceFormat?: string;
  sourcePath?: string;
  content: string;
  contentHash: string;
  characterCount: number;
  estimatedTokenCount: number;
  warnings: SemanticChunkWarning[];
  metadata: SemanticChunkMetadata;
}

export interface ChunkDocNodeOptions {
  /**
   * Maximum target chunk size in JavaScript string characters. Prose can split
   * below this limit; code and data blocks remain indivisible and may exceed it
   * with an explicit warning.
   */
  maxCharacters?: number;
  /**
   * Deterministic token estimate divisor. Defaults to 4 characters per token.
   */
  estimatedCharactersPerToken?: number;
}

export interface ChunkDocNodeResult {
  chunks: SemanticChunk[];
  warnings: SemanticChunkWarning[];
}

interface PathLink {
  segment: string;
  title: string;
  parent?: PathLink;
  depth: number;
}

interface TraversalFrame {
  node: unknown;
  path: PathLink;
  source: SemanticChunkSource;
}

interface NormalizedNode {
  id: string;
  type: string;
  title: string;
  description: string;
  metadata: unknown;
  content: unknown;
  children: unknown;
}

interface FormattedUnit {
  text: string;
  splittable: boolean;
  blockType: string;
}

interface SplitPiece {
  text: string;
  warnings: SemanticChunkWarning[];
}

interface ChunkDraft {
  title: string;
  path: string[];
  nodePath: string[];
  nodeId: string;
  nodeType: string;
  source: SemanticChunkSource;
  content: string;
  blockTypes: string[];
  warnings: SemanticChunkWarning[];
  oversized: boolean;
}

/**
 * Chunk an existing DocNode tree into stable semantic records.
 *
 * Traversal is iterative preorder to avoid deep-tree call stack failures.
 * Runtime is O(nodes + content length), excluding the unavoidable emitted
 * heading/path text included in chunk content.
 */
export function chunkDocNode(root: DocNode, options: ChunkDocNodeOptions = {}): ChunkDocNodeResult {
  const maxCharacters = normalizePositiveInteger(
    options.maxCharacters,
    DEFAULT_CHUNK_MAX_CHARACTERS
  );
  const estimatedCharactersPerToken = normalizePositiveInteger(
    options.estimatedCharactersPerToken,
    DEFAULT_ESTIMATED_CHARACTERS_PER_TOKEN
  );

  const warnings: SemanticChunkWarning[] = [];
  const rootNode = normalizeNode(root);

  if (rootNode === undefined) {
    const warning = createWarning(
      'malformed_content_block',
      ['document'],
      'Root DocNode must be an object.'
    );
    return { chunks: [], warnings: [warning] };
  }

  const rootSegment = semanticSegment(rootNode, 'document');
  const rootPath: PathLink = {
    segment: rootSegment,
    title: normalizedTitle(rootNode, 'Untitled'),
    depth: 0,
  };

  const stack: TraversalFrame[] = [
    {
      node: root,
      path: rootPath,
      source: sourceFromMetadata(undefined, rootNode.metadata),
    },
  ];
  const visitedObjects = new WeakSet<object>();
  const drafts: ChunkDraft[] = [];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) {
      break;
    }

    if (!isRecord(frame.node)) {
      warnings.push(
        createWarning(
          'malformed_content_block',
          pathSegments(frame.path),
          'DocNode must be an object.'
        )
      );
      continue;
    }

    if (visitedObjects.has(frame.node)) {
      warnings.push(
        createWarning(
          'cycle_detected',
          pathSegments(frame.path),
          'Repeated DocNode object reference was skipped to avoid a traversal cycle.'
        )
      );
      continue;
    }
    visitedObjects.add(frame.node);

    const node = normalizeNode(frame.node);
    if (node === undefined) {
      warnings.push(
        createWarning(
          'malformed_content_block',
          pathSegments(frame.path),
          'DocNode must be an object.'
        )
      );
      continue;
    }

    const source = sourceFromMetadata(frame.source, node.metadata);
    drafts.push(...chunkSingleNode(node, frame.path, source, maxCharacters, warnings));
    pushChildren(stack, node, frame.path, source, warnings);
  }

  const chunkSplitCounts = countDraftsByNodePath(drafts);
  const chunkSplitIndexes = new Map<string, number>();
  const chunks = drafts.map((draft, index) => {
    const key = nodePathKey(draft.nodePath);
    const splitIndex = (chunkSplitIndexes.get(key) ?? 0) + 1;
    chunkSplitIndexes.set(key, splitIndex);

    return finalizeChunk(
      draft,
      index + 1,
      maxCharacters,
      estimatedCharactersPerToken,
      splitIndex,
      chunkSplitCounts.get(key) ?? 1
    );
  });

  return { chunks, warnings };
}

function chunkSingleNode(
  node: NormalizedNode,
  path: PathLink,
  source: SemanticChunkSource,
  maxCharacters: number,
  globalWarnings: SemanticChunkWarning[]
): ChunkDraft[] {
  let cachedNodePath: string[] | undefined;
  let cachedTitlePath: string[] | undefined;
  const getNodePath = (): string[] => {
    cachedNodePath ??= pathSegments(path);
    return cachedNodePath;
  };
  const getTitlePath = (): string[] => {
    cachedTitlePath ??= pathTitles(path);
    return cachedTitlePath;
  };

  const units = collectFormattedUnits(node, getNodePath, globalWarnings);

  if (units.length === 0) {
    return [];
  }

  const nodePath = getNodePath();
  const titlePath = getTitlePath();
  const chunkTitle = titlePath.at(-1) ?? node.title;
  const headingContext = formatHeadingContext(titlePath);

  if (headingContext.length > maxCharacters) {
    globalWarnings.push(
      createWarning(
        'context_exceeds_max_characters',
        nodePath,
        `Heading context is ${headingContext.length} characters, exceeding the ${maxCharacters} character target before content is added.`
      )
    );
  }

  const drafts: ChunkDraft[] = [];
  const currentParts: string[] = [];
  const currentBlockTypes: string[] = [];
  let currentPartsLength = 0;
  let currentOversized = false;
  let currentWarnings: SemanticChunkWarning[] = [];

  const flushCurrent = (): void => {
    if (currentParts.length === 0) {
      return;
    }

    drafts.push({
      title: chunkTitle,
      path: titlePath,
      nodePath,
      nodeId: node.id,
      nodeType: node.type,
      source,
      content: composeChunkContent(headingContext, currentParts),
      blockTypes: [...currentBlockTypes],
      warnings: currentWarnings,
      oversized: currentOversized,
    });

    currentParts.splice(0);
    currentBlockTypes.splice(0);
    currentPartsLength = 0;
    currentOversized = false;
    currentWarnings = [];
  };

  const addPart = (text: string, blockType: string): void => {
    currentParts.push(text);
    currentBlockTypes.push(blockType);
    currentPartsLength += text.length;
  };

  for (const unit of units) {
    if (
      currentParts.length > 0 &&
      measuredChunkLength(
        headingContext.length,
        currentPartsLength,
        currentParts.length,
        unit.text
      ) > maxCharacters
    ) {
      flushCurrent();
    }

    const unitLength = measuredChunkLength(headingContext.length, 0, 0, unit.text);
    if (unitLength <= maxCharacters || !unit.splittable) {
      if (unitLength > maxCharacters && !unit.splittable) {
        const warning = createWarning(
          'oversized_indivisible_block',
          nodePath,
          `${unit.blockType} block is ${unit.text.length} characters before heading context and cannot be split safely.`
        );
        currentWarnings.push(warning);
        globalWarnings.push(warning);
        currentOversized = true;
      }

      addPart(unit.text, unit.blockType);
      continue;
    }

    const available = maxCharacters - headingContext.length - DOUBLE_NEWLINE.length;
    const minSplittable = Math.max(1, Math.floor(maxCharacters / 4));
    if (available < minSplittable) {
      // The heading context leaves too little room to split this unit
      // productively. Splitting anyway would emit O(unit length) near-1-char
      // pieces, each re-prepending the full heading context, blowing output up
      // to O(unit length x heading length). Emit the unit as a single oversized
      // chunk instead, mirroring the indivisible-block path.
      const warning = createWarning(
        'oversized_indivisible_block',
        nodePath,
        `${unit.blockType} block (${unit.text.length} chars) cannot be split: the heading context (${headingContext.length} chars) leaves too little room within the ${maxCharacters} character target.`
      );
      currentWarnings.push(warning);
      globalWarnings.push(warning);
      currentOversized = true;
      addPart(unit.text, unit.blockType);
      continue;
    }

    const pieces = splitTextAtSafeBoundaries(unit.text, available, nodePath, globalWarnings);
    for (const piece of pieces) {
      if (
        currentParts.length > 0 &&
        measuredChunkLength(
          headingContext.length,
          currentPartsLength,
          currentParts.length,
          piece.text
        ) > maxCharacters
      ) {
        flushCurrent();
      }

      currentWarnings.push(...piece.warnings);
      addPart(piece.text, unit.blockType);
      flushCurrent();
    }
  }

  flushCurrent();
  return drafts;
}

function collectFormattedUnits(
  node: NormalizedNode,
  getNodePath: () => string[],
  globalWarnings: SemanticChunkWarning[]
): FormattedUnit[] {
  const units: FormattedUnit[] = [];

  if (node.description.trim().length > 0) {
    units.push({
      text: node.description.trim(),
      splittable: true,
      blockType: ContentBlockType.PROSE,
    });
  }

  if (node.content !== undefined && !Array.isArray(node.content)) {
    globalWarnings.push(
      createWarning(
        'malformed_content',
        getNodePath(),
        'DocNode content must be an array; invalid content was skipped.'
      )
    );
    return units;
  }

  const content = Array.isArray(node.content) ? node.content : [];
  for (const block of content) {
    const formatted = formatContentBlock(block, getNodePath, globalWarnings);
    if (formatted !== undefined) {
      units.push(formatted);
    }
  }

  return units;
}

function formatContentBlock(
  block: unknown,
  getNodePath: () => string[],
  globalWarnings: SemanticChunkWarning[]
): FormattedUnit | undefined {
  if (!isRecord(block)) {
    globalWarnings.push(
      createWarning('malformed_content_block', getNodePath(), 'Content block must be an object.')
    );
    return undefined;
  }

  const content = block.content;
  if (typeof content !== 'string') {
    globalWarnings.push(
      createWarning(
        'malformed_content_block',
        getNodePath(),
        'Content block content must be a string.'
      )
    );
    return undefined;
  }

  const type = block.type;
  if (type === ContentBlockType.CODE) {
    const language = typeof block.language === 'string' ? block.language : 'text';
    return {
      text: formatFencedBlock(content, language),
      splittable: false,
      blockType: ContentBlockType.CODE,
    };
  }

  if (type === ContentBlockType.DATA) {
    const dataType = readAnnotationString(block as ContentBlock, 'type') ?? 'data';
    return {
      text: formatFencedBlock(content, dataType),
      splittable: false,
      blockType: ContentBlockType.DATA,
    };
  }

  if (type !== ContentBlockType.PROSE) {
    globalWarnings.push(
      createWarning(
        'malformed_content_block',
        getNodePath(),
        `Unknown content block type "${String(type)}"; block was treated as prose.`
      )
    );
  }

  const prose = content.trim();
  if (prose.length === 0) {
    return undefined;
  }

  return {
    text: prose,
    splittable: true,
    blockType: ContentBlockType.PROSE,
  };
}

function pushChildren(
  stack: TraversalFrame[],
  node: NormalizedNode,
  parentPath: PathLink,
  source: SemanticChunkSource,
  globalWarnings: SemanticChunkWarning[]
): void {
  if (node.children !== undefined && !Array.isArray(node.children)) {
    globalWarnings.push(
      createWarning(
        'malformed_children',
        pathSegments(parentPath),
        'DocNode children must be an array; invalid children were skipped.'
      )
    );
    return;
  }

  const children = Array.isArray(node.children) ? node.children : [];
  const childFrames: TraversalFrame[] = [];
  const seenSegments = new Map<string, number>();

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    const normalizedChild = normalizeNode(child);
    if (normalizedChild === undefined) {
      globalWarnings.push(
        createWarning(
          'malformed_content_block',
          pathSegments(parentPath),
          `Child at ordinal ${index + 1} must be a DocNode object and was skipped.`
        )
      );
      continue;
    }

    const baseSegment = semanticSegment(normalizedChild, `node-${index + 1}`);
    const segmentCount = seenSegments.get(baseSegment) ?? 0;
    seenSegments.set(baseSegment, segmentCount + 1);
    const segment = segmentCount === 0 ? baseSegment : `${baseSegment}~${segmentCount + 1}`;

    if (segmentCount > 0) {
      globalWarnings.push(
        createWarning(
          'duplicate_node_id',
          [...pathSegments(parentPath), segment],
          `Duplicate sibling node id "${baseSegment}" was disambiguated as "${segment}".`
        )
      );
    }

    childFrames.push({
      node: child,
      path: {
        segment,
        title: normalizedTitle(normalizedChild, `Untitled ${index + 1}`),
        parent: parentPath,
        depth: parentPath.depth + 1,
      },
      source: sourceFromMetadata(source, normalizedChild.metadata),
    });
  }

  for (let index = childFrames.length - 1; index >= 0; index -= 1) {
    const childFrame = childFrames[index];
    if (childFrame !== undefined) {
      stack.push(childFrame);
    }
  }
}

function finalizeChunk(
  draft: ChunkDraft,
  ordinal: number,
  maxCharacters: number,
  estimatedCharactersPerToken: number,
  splitIndex: number,
  splitCount: number
): SemanticChunk {
  const baseId = draft.nodePath.join('/') || 'document';
  const id = splitCount === 1 ? baseId : `${baseId}/${GENERATED_SPLIT_SEGMENT_PREFIX}${splitIndex}`;
  const warnings = draft.warnings.map((warning) => withChunkId(warning, id));
  const contentHash = sha256(draft.content);
  const metadata: SemanticChunkMetadata = {
    nodeId: draft.nodeId,
    nodeType: draft.nodeType,
    sectionPath: draft.path.join(' > '),
    splitIndex,
    splitCount,
    maxCharacters,
    oversized: draft.oversized || draft.content.length > maxCharacters,
    blockTypes: draft.blockTypes,
  };

  const chunk: SemanticChunk = {
    id,
    ordinal,
    title: draft.title,
    path: draft.path,
    nodePath: draft.nodePath,
    content: draft.content,
    contentHash,
    characterCount: draft.content.length,
    estimatedTokenCount: estimateTokenCount(draft.content, estimatedCharactersPerToken),
    warnings,
    metadata,
  };

  if (draft.source.format !== undefined) {
    chunk.sourceFormat = draft.source.format;
  }
  if (draft.source.path !== undefined) {
    chunk.sourcePath = draft.source.path;
  }

  return chunk;
}

function countDraftsByNodePath(drafts: ChunkDraft[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const draft of drafts) {
    const key = nodePathKey(draft.nodePath);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

function nodePathKey(nodePath: string[]): string {
  return nodePath.join('\u0000');
}

function splitTextAtSafeBoundaries(
  text: string,
  limit: number,
  nodePath: string[],
  globalWarnings: SemanticChunkWarning[]
): SplitPiece[] {
  if (text.length <= limit) {
    return [{ text, warnings: [] }];
  }

  const pieces: SplitPiece[] = [];
  let start = 0;

  while (start < text.length) {
    const hardEnd = Math.min(text.length, start + limit);
    if (hardEnd >= text.length) {
      const finalPiece = text.slice(start).trim();
      if (finalPiece.length > 0) {
        pieces.push({ text: finalPiece, warnings: [] });
      }
      break;
    }

    const boundary = findSafeBoundary(text, start, hardEnd);
    const end = boundary.index;
    const piece = text.slice(start, end).trim();
    const pieceWarnings: SemanticChunkWarning[] = [];

    if (boundary.kind === 'hard') {
      const warning = createWarning(
        'hard_text_split',
        nodePath,
        `Prose was split at ${limit} characters because no safer boundary was available.`
      );
      pieceWarnings.push(warning);
      globalWarnings.push(warning);
    }

    if (piece.length > 0) {
      pieces.push({ text: piece, warnings: pieceWarnings });
    }

    start = end;
  }

  return pieces;
}

function findSafeBoundary(
  text: string,
  start: number,
  hardEnd: number
): {
  index: number;
  kind: 'paragraph' | 'line' | 'sentence' | 'space' | 'hard';
} {
  for (let index = hardEnd - 2; index >= start; index -= 1) {
    if (text[index] === '\n' && text[index + 1] === '\n') {
      return { index: index + 2, kind: 'paragraph' };
    }
  }

  for (let index = hardEnd - 1; index >= start; index -= 1) {
    if (text[index] === '\n') {
      return { index: index + 1, kind: 'line' };
    }
  }

  for (let index = hardEnd; index > start; index -= 1) {
    const char = text[index - 1];
    const nextChar = text[index];
    if ((char === '.' || char === '?' || char === '!') && (nextChar === ' ' || nextChar === '\n')) {
      return { index, kind: 'sentence' };
    }
  }

  for (let index = hardEnd - 1; index >= start; index -= 1) {
    if (text[index] === ' ') {
      return { index: index + 1, kind: 'space' };
    }
  }

  return { index: hardEnd, kind: 'hard' };
}

function normalizeNode(value: unknown): NormalizedNode | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const rawType = value.type;
  const rawId = value.id;
  const rawTitle = value.title;
  const rawDescription = value.description;

  return {
    id: typeof rawId === 'string' ? rawId : '',
    type: typeof rawType === 'string' ? rawType : 'unknown',
    title: typeof rawTitle === 'string' ? rawTitle : '',
    description: typeof rawDescription === 'string' ? rawDescription : '',
    metadata: value.metadata,
    content: value.content,
    children: value.children,
  };
}

function normalizedTitle(node: NormalizedNode, fallback: string): string {
  const title = node.title.trim();
  if (title.length > 0) {
    return title;
  }

  const id = node.id.trim();
  return id.length > 0 ? id : fallback;
}

function semanticSegment(node: NormalizedNode, fallback: string): string {
  return slugify(node.id) || slugify(node.title) || fallback;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function sourceFromMetadata(
  parent: SemanticChunkSource | undefined,
  metadata: unknown
): SemanticChunkSource {
  const source: SemanticChunkSource = {};
  const format =
    readMetadataString(metadata, 'format') ??
    readMetadataString(metadata, 'sourceFormat') ??
    readMetadataString(metadata, 'sourceKind') ??
    parent?.format;
  const explicitSourcePath = readMetadataString(metadata, 'sourcePath');
  const genericPath = readMetadataString(metadata, 'path');
  const path =
    explicitSourcePath ??
    (genericPath !== undefined &&
    !isKnownApiSourceFormat(format) &&
    isLikelyLocalFilePath(genericPath)
      ? genericPath
      : parent?.path);

  if (format !== undefined) {
    source.format = format;
  }
  if (path !== undefined) {
    source.path = path;
  }

  return source;
}

function isKnownApiSourceFormat(format: string | undefined): boolean {
  return format === 'openapi' || format === 'swagger';
}

function isLikelyLocalFilePath(path: string): boolean {
  const trimmed = path.trim();
  if (trimmed.length === 0 || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return false;
  }

  const pathWithoutHashOrQuery = trimmed.split(/[?#]/, 1)[0] ?? '';
  const segments = pathWithoutHashOrQuery.split(/[\\/]+/);
  const filename = segments.at(-1) ?? '';
  if (filename.length === 0 || filename === '.' || filename === '..') {
    return false;
  }

  if (/^[^.]+\.[A-Za-z0-9][A-Za-z0-9-]{0,15}$/.test(filename)) {
    return true;
  }

  return ['readme', 'license', 'changelog', 'contributing'].includes(filename.toLowerCase());
}

function readMetadataString(metadata: unknown, key: string): string | undefined {
  if (metadata instanceof Map) {
    const value = metadata.get(key);
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  if (isRecord(metadata)) {
    const value = metadata[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  return undefined;
}

function readAnnotationString(block: ContentBlock, key: string): string | undefined {
  const annotations = block.annotations;
  if (!(annotations instanceof Map)) {
    return undefined;
  }

  const value = annotations.get(key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function formatHeadingContext(titles: string[]): string {
  return titles
    .map((title, index) => `${'#'.repeat(Math.min(index + 1, 6))} ${title}`)
    .join(DOUBLE_NEWLINE);
}

function formatFencedBlock(content: string, language: string): string {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(content) + 1));
  const normalizedLanguage = language
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9_+#.-]/g, '');
  const infoString = normalizedLanguage.length > 0 ? normalizedLanguage : 'text';
  return `${fence}${infoString}\n${content}\n${fence}`;
}

function longestBacktickRun(content: string): number {
  let longest = 0;
  let current = 0;

  for (const char of content) {
    if (char === '`') {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }

  return longest;
}

function composeChunkContent(headingContext: string, parts: string[]): string {
  if (headingContext.length === 0) {
    return parts.join(DOUBLE_NEWLINE);
  }

  return [headingContext, ...parts].join(DOUBLE_NEWLINE);
}

function measuredChunkLength(
  headingContextLength: number,
  currentPartsLength: number,
  currentPartCount: number,
  nextPart: string
): number {
  const partCount = currentPartCount + 1;
  const partLength = currentPartsLength + nextPart.length;
  const headingSeparatorLength =
    headingContextLength > 0 && partCount > 0 ? DOUBLE_NEWLINE.length : 0;
  const partSeparatorLength = Math.max(0, partCount - 1) * DOUBLE_NEWLINE.length;
  return headingContextLength + headingSeparatorLength + partLength + partSeparatorLength;
}

function pathSegments(path: PathLink): string[] {
  const segments: string[] = [];
  let cursor: PathLink | undefined = path;

  while (cursor !== undefined) {
    segments.push(cursor.segment);
    cursor = cursor.parent;
  }

  return segments.reverse();
}

function pathTitles(path: PathLink): string[] {
  const titles: string[] = [];
  let cursor: PathLink | undefined = path;

  while (cursor !== undefined) {
    titles.push(cursor.title);
    cursor = cursor.parent;
  }

  return titles.reverse();
}

function sha256(content: string): string {
  return sha256Hex(content);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.floor(value));
}

function createWarning(
  code: SemanticChunkWarningCode,
  nodePath: string[],
  message: string
): SemanticChunkWarning {
  return {
    code,
    nodePath,
    message,
  };
}

function withChunkId(warning: SemanticChunkWarning, chunkId: string): SemanticChunkWarning {
  return {
    ...warning,
    chunkId,
  };
}