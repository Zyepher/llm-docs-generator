import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isObjectRecord, errorMessage } from '../utils/guards.js';
import { sha256Hex, sha256Prefixed, isUnprefixedSha256Hash } from '../utils/hash.js';
import { estimateTokenCount } from '../utils/text-metrics.js';

const SEMANTIC_CHUNK_INDEX_HASH_CONTEXT =
  'llm-docs-generator:source-docs-semantic-chunks-jsonl-index:v1';
const SEMANTIC_CHUNK_JSONL_FORMAT = 'jsonl';

export interface SemanticChunkManifestIndexChunkSourceLines {
  start: number;
  end: number;
}

export interface SemanticChunkManifestIndexChunk {
  id: string;
  order: number;
  title: string;
  path: string[];
  nodePath: string[];
  contentHash: string;
  characterCount: number;
  estimatedTokenCount: number;
  sourceFormat?: string;
  sourcePath?: string;
  /** 1-indexed inclusive line range into the original file at sourcePath. */
  sourceLines?: SemanticChunkManifestIndexChunkSourceLines;
  warningCount: number;
}

export interface SemanticChunkManifestIndex {
  path: string;
  format: typeof SEMANTIC_CHUNK_JSONL_FORMAT;
  chunkCount: number;
  aggregateHash: string;
  warningCount: number;
  chunks: SemanticChunkManifestIndexChunk[];
}

type SemanticChunkManifestIndexWithoutHash = Omit<SemanticChunkManifestIndex, 'aggregateHash'>;

export async function buildSemanticChunkJsonlManifestIndex(options: {
  manifestDir: string;
  outputPath: string;
}): Promise<SemanticChunkManifestIndex> {
  const jsonlPath = resolve(options.manifestDir, options.outputPath);
  const jsonl = await readFile(jsonlPath, 'utf-8');
  const chunks = parseSemanticChunkJsonl(jsonl, options.outputPath);
  const warningCount = chunks.reduce((total, chunk) => total + chunk.warningCount, 0);
  const indexWithoutHash: SemanticChunkManifestIndexWithoutHash = {
    path: options.outputPath,
    format: SEMANTIC_CHUNK_JSONL_FORMAT,
    chunkCount: chunks.length,
    warningCount,
    chunks,
  };

  return {
    path: indexWithoutHash.path,
    format: indexWithoutHash.format,
    chunkCount: indexWithoutHash.chunkCount,
    aggregateHash: hashSemanticChunkManifestIndex(indexWithoutHash),
    warningCount: indexWithoutHash.warningCount,
    chunks: indexWithoutHash.chunks,
  };
}

export function semanticChunkManifestIndexesEqual(
  left: SemanticChunkManifestIndex,
  right: SemanticChunkManifestIndex
): boolean {
  return left.aggregateHash === right.aggregateHash;
}

export function hashSemanticChunkManifestIndex(
  index: SemanticChunkManifestIndexWithoutHash
): string {
  return sha256Prefixed(
    `${SEMANTIC_CHUNK_INDEX_HASH_CONTEXT}\n${JSON.stringify(canonicalSemanticChunkManifestIndexForHash(index))}\n`
  );
}

function canonicalSemanticChunkManifestIndexForHash(
  index: SemanticChunkManifestIndexWithoutHash
): SemanticChunkManifestIndexWithoutHash {
  return {
    path: index.path,
    format: index.format,
    chunkCount: index.chunkCount,
    warningCount: index.warningCount,
    chunks: index.chunks.map((chunk) => {
      const canonicalChunk: SemanticChunkManifestIndexChunk = {
        id: chunk.id,
        order: chunk.order,
        title: chunk.title,
        path: chunk.path,
        nodePath: chunk.nodePath,
        contentHash: chunk.contentHash,
        characterCount: chunk.characterCount,
        estimatedTokenCount: chunk.estimatedTokenCount,
        warningCount: chunk.warningCount,
      };

      if (chunk.sourceFormat !== undefined) {
        canonicalChunk.sourceFormat = chunk.sourceFormat;
      }

      if (chunk.sourcePath !== undefined) {
        canonicalChunk.sourcePath = chunk.sourcePath;
      }

      if (chunk.sourceLines !== undefined) {
        canonicalChunk.sourceLines = {
          start: chunk.sourceLines.start,
          end: chunk.sourceLines.end,
        };
      }

      return canonicalChunk;
    }),
  };
}

function parseSemanticChunkJsonl(
  jsonl: string,
  outputPath: string
): SemanticChunkManifestIndexChunk[] {
  if (jsonl.length === 0) {
    return [];
  }

  if (!jsonl.endsWith('\n')) {
    throw new Error(`${outputPath}: semantic chunk JSONL must end with a newline`);
  }

  const lines = jsonl.slice(0, -1).split('\n');

  return lines.map((line, index) => parseSemanticChunkJsonlLine(line, index + 1, outputPath));
}

function parseSemanticChunkJsonlLine(
  line: string,
  lineNumber: number,
  outputPath: string
): SemanticChunkManifestIndexChunk {
  if (line.length === 0) {
    throw new Error(`${outputPath}: line ${lineNumber} is empty`);
  }

  let record: unknown;

  try {
    record = JSON.parse(line) as unknown;
  } catch (error) {
    throw new Error(`${outputPath}: line ${lineNumber} has malformed JSON: ${errorMessage(error)}`);
  }

  if (!isObjectRecord(record)) {
    throw new Error(`${outputPath}: line ${lineNumber} must be a JSON object`);
  }

  const id = requiredNonEmptyString(record.id, outputPath, lineNumber, 'id');
  const order = requiredPositiveInteger(record.ordinal, outputPath, lineNumber, 'ordinal');
  const title = requiredNonEmptyString(record.title, outputPath, lineNumber, 'title');
  const path = requiredStringArray(record.path, outputPath, lineNumber, 'path');
  const nodePath = requiredStringArray(record.nodePath, outputPath, lineNumber, 'nodePath');
  const content = requiredString(record.content, outputPath, lineNumber, 'content');
  const contentHash = requiredSha256Hex(record.contentHash, outputPath, lineNumber, 'contentHash');
  const characterCount = requiredNonNegativeInteger(
    record.characterCount,
    outputPath,
    lineNumber,
    'characterCount'
  );
  const estimatedTokenCount = requiredNonNegativeInteger(
    record.estimatedTokenCount,
    outputPath,
    lineNumber,
    'estimatedTokenCount'
  );
  const warnings = requiredArray(record.warnings, outputPath, lineNumber, 'warnings');

  if (order !== lineNumber) {
    throw new Error(
      `${outputPath}: line ${lineNumber} ordinal must match JSONL order (actual ${order})`
    );
  }

  const actualContentHash = sha256Hex(content);
  if (contentHash !== actualContentHash) {
    throw new Error(`${outputPath}: line ${lineNumber} contentHash does not match content`);
  }

  if (characterCount !== content.length) {
    throw new Error(`${outputPath}: line ${lineNumber} characterCount does not match content`);
  }

  const actualEstimatedTokenCount = estimateTokenCount(content);
  if (estimatedTokenCount !== actualEstimatedTokenCount) {
    throw new Error(`${outputPath}: line ${lineNumber} estimatedTokenCount does not match content`);
  }

  return {
    id,
    order,
    title,
    path,
    nodePath,
    contentHash,
    characterCount,
    estimatedTokenCount,
    ...optionalStringField(record, 'sourceFormat', outputPath, lineNumber),
    ...optionalStringField(record, 'sourcePath', outputPath, lineNumber),
    ...optionalSourceLinesField(record, outputPath, lineNumber),
    warningCount: warnings.length,
  };
}

function requiredString(
  value: unknown,
  outputPath: string,
  lineNumber: number,
  field: string
): string {
  if (typeof value !== 'string') {
    throw new Error(`${outputPath}: line ${lineNumber} ${field} must be a string`);
  }

  return value;
}

function requiredNonEmptyString(
  value: unknown,
  outputPath: string,
  lineNumber: number,
  field: string
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${outputPath}: line ${lineNumber} ${field} must be a non-empty string`);
  }

  return value;
}

function requiredStringArray(
  value: unknown,
  outputPath: string,
  lineNumber: number,
  field: string
): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`${outputPath}: line ${lineNumber} ${field} must be a string array`);
  }

  return value;
}

function requiredArray(
  value: unknown,
  outputPath: string,
  lineNumber: number,
  field: string
): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${outputPath}: line ${lineNumber} ${field} must be an array`);
  }

  return value;
}

function requiredPositiveInteger(
  value: unknown,
  outputPath: string,
  lineNumber: number,
  field: string
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${outputPath}: line ${lineNumber} ${field} must be a positive integer`);
  }

  return value;
}

function requiredNonNegativeInteger(
  value: unknown,
  outputPath: string,
  lineNumber: number,
  field: string
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${outputPath}: line ${lineNumber} ${field} must be a non-negative integer`);
  }

  return value;
}

function requiredSha256Hex(
  value: unknown,
  outputPath: string,
  lineNumber: number,
  field: string
): string {
  if (typeof value !== 'string' || !isUnprefixedSha256Hash(value)) {
    throw new Error(`${outputPath}: line ${lineNumber} ${field} must be a sha256 hex digest`);
  }

  return value;
}

/**
 * Optional per-chunk source line range. Old records without the field pass
 * untouched; when present the shape is enforced (1-indexed integers with
 * start <= end) so a tampered or fabricated range fails re-verification.
 */
function optionalSourceLinesField(
  record: Record<string, unknown>,
  outputPath: string,
  lineNumber: number
): Partial<Pick<SemanticChunkManifestIndexChunk, 'sourceLines'>> {
  if (!('sourceLines' in record)) {
    return {};
  }

  const value = record.sourceLines;

  if (isObjectRecord(value)) {
    const start = value.start;
    const end = value.end;
    if (
      typeof start === 'number' &&
      typeof end === 'number' &&
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start >= 1 &&
      end >= start
    ) {
      return { sourceLines: { start, end } };
    }
  }

  throw new Error(
    `${outputPath}: line ${lineNumber} sourceLines must be an object with 1-indexed integer start <= end`
  );
}

function optionalStringField(
  record: Record<string, unknown>,
  field: 'sourceFormat' | 'sourcePath',
  outputPath: string,
  lineNumber: number
): Partial<Pick<SemanticChunkManifestIndexChunk, 'sourceFormat' | 'sourcePath'>> {
  if (!(field in record)) {
    return {};
  }

  const value = record[field];

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${outputPath}: line ${lineNumber} ${field} must be a non-empty string`);
  }

  return { [field]: value };
}
