import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isObjectRecord, errorMessage } from '../utils/guards.js';

const HASH_PREFIX = 'sha256:';
const SEMANTIC_CHUNK_INDEX_HASH_CONTEXT =
  'llm-docs-generator:source-docs-semantic-chunks-jsonl-index:v1';
const SEMANTIC_CHUNK_JSONL_FORMAT = 'jsonl';

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
  return (
    JSON.stringify(canonicalSemanticChunkManifestIndex(left)) ===
    JSON.stringify(canonicalSemanticChunkManifestIndex(right))
  );
}

export function hashSemanticChunkManifestIndex(
  index: SemanticChunkManifestIndexWithoutHash
): string {
  const hash = createHash('sha256');
  hash.update(`${SEMANTIC_CHUNK_INDEX_HASH_CONTEXT}\n`);
  hash.update(JSON.stringify(canonicalSemanticChunkManifestIndexForHash(index)));
  hash.update('\n');

  return `${HASH_PREFIX}${hash.digest('hex')}`;
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

      return canonicalChunk;
    }),
  };
}

function canonicalSemanticChunkManifestIndex(
  index: SemanticChunkManifestIndex
): SemanticChunkManifestIndex {
  return {
    path: index.path,
    format: index.format,
    chunkCount: index.chunkCount,
    aggregateHash: index.aggregateHash,
    warningCount: index.warningCount,
    chunks: canonicalSemanticChunkManifestIndexForHash(index).chunks,
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

  const actualContentHash = createHash('sha256').update(content).digest('hex');
  if (contentHash !== actualContentHash) {
    throw new Error(`${outputPath}: line ${lineNumber} contentHash does not match content`);
  }

  if (characterCount !== content.length) {
    throw new Error(`${outputPath}: line ${lineNumber} characterCount does not match content`);
  }

  const actualEstimatedTokenCount = estimateSemanticChunkTokenCount(content);
  if (estimatedTokenCount !== actualEstimatedTokenCount) {
    throw new Error(
      `${outputPath}: line ${lineNumber} estimatedTokenCount does not match content`
    );
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
    warningCount: warnings.length,
  };
}

function estimateSemanticChunkTokenCount(content: string): number {
  return Math.ceil(content.length / 4);
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
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${outputPath}: line ${lineNumber} ${field} must be a sha256 hex digest`);
  }

  return value;
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
