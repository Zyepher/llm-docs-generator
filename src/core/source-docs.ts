import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { chunkDocNode, type SemanticChunk, type SemanticChunkWarning } from './chunker.js';
import { detectFormat, getParserForFormat } from './detector.js';
import { describeGeneratedTextOutput } from './generated-output-metadata.js';
import { createDocNode, DocNodeType, type DocNode } from './models.js';
import { formatDocNode } from './universal-formatter.js';
import { isUrlLikeInput } from './discovery.js';
import { FormatType, type Parser } from '../parsers/base.js';

const HASH_PREFIX = 'sha256:';
const SOURCE_DOCS_FORMATTER_FORMAT = 'universal-llm-docs';
const SOURCE_DOCS_OUTPUT_DIR = 'llm-docs';
const SOURCE_DOCS_CHUNKS_OUTPUT_DIR = 'chunks';
const SOURCE_DOCS_CHUNKS_JSONL = 'semantic-chunks.jsonl';
const SOURCE_DOCS_MANIFEST = 'manifest.json';
const DEFAULT_SOURCE_DOCS_MAX_DEPTH = 16;
const DEFAULT_SOURCE_DOCS_MAX_ENTRIES = 20000;
const DEFAULT_SOURCE_DOCS_MAX_FILES = 5000;

export const SOURCE_DOCS_SCHEMA_VERSION = '0.1.0';
export const SOURCE_DOCS_MODE = 'local-source-docs';

const SOURCE_DOCS_FORMAT_HINTS = new Set([
  'auto',
  'markdown',
  'mdx',
  'openapi',
  'openref',
  'rst',
  'html',
]);

const DISCOVERY_REPORT_MODES = new Set([
  'local-bounded-inspection',
  'repo-bounded-inspection',
  'website-bounded-inspection',
]);

type SourceDocsSourceType = 'file' | 'directory';
export type SourceDocsChunksFormat = 'jsonl';
type SourceDocsResolvedFormat =
  | FormatType.MARKDOWN
  | FormatType.OPENAPI
  | FormatType.OPENREF
  | FormatType.RST
  | FormatType.HTML;

export interface SourceDocsGeneratorMetadata {
  name: string;
  version: string;
  cliName?: string;
}

export interface SourceDocsPresetMetadata {
  name: string;
  configPath: string;
  displayName: string;
  description?: string;
  defaults: {
    format: string;
    filenamePrefix: string;
    title: string;
    systemPrompt: string;
    outputFormats?: string[];
  };
  metadata?: Record<string, unknown>;
  limitations: string[];
}

export interface SourceDocsOutputDefaults {
  filenamePrefix?: string;
  title?: string;
  systemPrompt?: string;
}

export interface GenerateSourceDocsOptions {
  source: string;
  outputDir: string;
  format?: string;
  chunks?: string;
  output?: SourceDocsOutputDefaults;
  preset?: SourceDocsPresetMetadata;
  generator: SourceDocsGeneratorMetadata;
}

interface SourceDocsBaseFileManifestEntry {
  path: string;
  resolvedPath: string;
  byteSize: number;
  hash: string;
}

export interface SourceDocsFileManifestEntry extends SourceDocsBaseFileManifestEntry {
  format: SourceDocsResolvedFormat;
}

export interface SourceDocsGeneratedOutput {
  path: string;
  kind: 'llm-docs' | 'semantic-chunks-jsonl';
  name: string;
  byteSize: number;
  hash: string;
  lineCount: number;
  estimatedTokenCount: number;
}

export interface SourceDocsManifest {
  schemaVersion: typeof SOURCE_DOCS_SCHEMA_VERSION;
  generatedAt: string;
  generator: SourceDocsGeneratorMetadata;
  mode: typeof SOURCE_DOCS_MODE;
  source: {
    input: string;
    resolvedPath: string;
    type: SourceDocsSourceType;
    formatHint: string;
    resolvedFormat: SourceDocsResolvedFormat;
    byteSize?: number;
    hash?: string;
    fileCount?: number;
    aggregateHash?: string;
  };
  sourceFiles: SourceDocsFileManifestEntry[];
  parser: {
    name: string;
    version: string;
    format: SourceDocsResolvedFormat;
  };
  formatter: {
    name: 'UniversalFormatter';
    version: string;
    format: typeof SOURCE_DOCS_FORMATTER_FORMAT;
  };
  generatedOutputs: SourceDocsGeneratedOutput[];
  preset?: SourceDocsPresetMetadata;
  warnings: string[];
}

export interface GenerateSourceDocsResult {
  outputDir: string;
  manifestPath: string;
  llmDocsDir: string;
  manifest: SourceDocsManifest;
}

export interface CleanupSourceDocsArtifactsOptions {
  protectedSourcePath?: string;
}

interface ResolvedSourceDocsInput {
  input: string;
  resolvedPath: string;
  type: SourceDocsSourceType;
}

interface ParsedFormatHint {
  manifestValue: string;
  parserHint: FormatType;
}

interface SourceFileCollection {
  files: BoundedSourceFile[];
  warnings: string[];
}

interface BoundedSourceFile extends SourceDocsBaseFileManifestEntry {
  format: SourceFileFormat;
}

interface PreparedSourceDocsInput {
  resolvedFormat: SourceDocsResolvedFormat;
  parser: Parser;
  sourceFiles: BoundedSourceFile[];
  warnings: string[];
}

type SourceFileFormat = SourceDocsResolvedFormat | 'structured-spec';

export async function generateSourceDocs(
  options: GenerateSourceDocsOptions
): Promise<GenerateSourceDocsResult> {
  const outputDir = resolve(options.outputDir);
  const manifestPath = join(outputDir, SOURCE_DOCS_MANIFEST);
  const llmDocsDir = join(outputDir, SOURCE_DOCS_OUTPUT_DIR);
  let outputWorkStarted = false;

  try {
    const formatHint = parseSourceDocsFormatHint(options.format);
    const chunksFormat = parseSourceDocsChunksFormat(options.chunks);
    const source = await resolveSourceInput(options.source);

    assertFileSourceOutsideSourceDocsArtifacts(source, outputDir);
    await assertOutputDirOutsideSource(source, outputDir);
    await assertNotDiscoveryReport(source);

    const preparedSource = await prepareSourceDocsInput(source, formatHint);

    await mkdir(outputDir, { recursive: true });
    await clearSourceDocsArtifacts(outputDir);
    outputWorkStarted = true;

    const root = await parsePreparedSource(source, preparedSource);
    const warnings = [...preparedSource.warnings, ...collectDocNodeWarnings(root)];
    const outputPaths = await formatDocNode(root, {
      outputDir: llmDocsDir,
      filenamePrefix:
        options.output?.filenamePrefix ?? filenamePrefixForSource(source.resolvedPath, source.type),
      title: options.output?.title ?? root.title,
      systemPrompt:
        options.output?.systemPrompt ??
        `This is a local source documentation pack generated from ${source.resolvedPath}.`,
      includeMetadata: false,
    });
    const generatedOutputs = await describeGeneratedOutputs(outputDir, outputPaths);
    const chunkOutput =
      chunksFormat === 'jsonl' ? await writeSemanticChunksJsonl(outputDir, root) : undefined;
    if (chunkOutput !== undefined) {
      generatedOutputs.push(chunkOutput);
      generatedOutputs.sort((a, b) => compareStringsByCodeUnit(a.path, b.path));
    }
    const manifest = buildSourceDocsManifest({
      source,
      formatHint: formatHint.manifestValue,
      resolvedFormat: preparedSource.resolvedFormat,
      parser: preparedSource.parser,
      generator: options.generator,
      sourceFiles: preparedSource.sourceFiles,
      generatedOutputs,
      ...(options.preset === undefined ? {} : { preset: options.preset }),
      warnings,
    });

    await writeJsonFile(manifestPath, manifest);

    return {
      outputDir,
      manifestPath,
      llmDocsDir,
      manifest,
    };
  } catch (error) {
    if (outputWorkStarted) {
      await clearSourceDocsArtifacts(outputDir);
    } else {
      await cleanupStaleSourceDocsArtifacts(outputDir, {
        protectedSourcePath: options.source,
      });
    }

    throw error;
  }
}

export async function cleanupStaleSourceDocsArtifacts(
  outputDir: string,
  options: CleanupSourceDocsArtifactsOptions = {}
): Promise<void> {
  const resolvedOutputDir = resolve(outputDir);

  if (isSourceDocsArtifactPath(options.protectedSourcePath, resolvedOutputDir)) {
    return;
  }

  const manifestPath = join(resolvedOutputDir, SOURCE_DOCS_MANIFEST);
  let manifest: unknown;

  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as unknown;
  } catch (error) {
    if (isNotFoundError(error) || error instanceof SyntaxError) {
      return;
    }

    throw error;
  }

  if (!isRecord(manifest) || manifest.mode !== SOURCE_DOCS_MODE) {
    return;
  }

  await clearSourceDocsArtifacts(resolvedOutputDir);
}

function parseSourceDocsFormatHint(format: string | undefined): ParsedFormatHint {
  const normalizedFormat = (format ?? 'auto').trim().toLowerCase();
  const manifestValue = normalizedFormat.length === 0 ? 'auto' : normalizedFormat;

  if (!SOURCE_DOCS_FORMAT_HINTS.has(manifestValue)) {
    throw new Error(
      `--format ${format ?? ''} is not supported for generate --source; supported source formats are auto, markdown, mdx, openapi, openref, rst, html`
    );
  }

  if (manifestValue === 'auto') {
    return { manifestValue, parserHint: FormatType.AUTO };
  }

  if (manifestValue === 'mdx') {
    return { manifestValue, parserHint: FormatType.MARKDOWN };
  }

  return { manifestValue, parserHint: manifestValue as FormatType };
}

function parseSourceDocsChunksFormat(
  chunks: string | undefined
): SourceDocsChunksFormat | undefined {
  if (chunks === undefined) {
    return undefined;
  }

  const normalizedChunks = chunks.trim().toLowerCase();

  if (normalizedChunks !== 'jsonl') {
    throw new Error(
      `--chunks ${chunks} is not supported for generate --source; supported chunk export formats are jsonl`
    );
  }

  return normalizedChunks;
}

async function resolveSourceInput(sourceInput: string): Promise<ResolvedSourceDocsInput> {
  const trimmedSource = sourceInput.trim();

  if (trimmedSource.length === 0) {
    throw new Error('generate --source requires a non-empty local file or directory path');
  }

  if (isUrlLikeInput(trimmedSource)) {
    throw new Error(
      'generate --source accepts explicit local file or directory paths only; URL-like and git inputs are not supported'
    );
  }

  const resolvedPath = resolve(trimmedSource);

  try {
    const sourceStats = await lstat(resolvedPath);

    if (sourceStats.isSymbolicLink()) {
      throw new Error(`generate --source input must not be a symbolic link: ${resolvedPath}`);
    }

    if (sourceStats.isFile()) {
      return {
        input: sourceInput,
        resolvedPath,
        type: 'file',
      };
    }

    if (sourceStats.isDirectory()) {
      return {
        input: sourceInput,
        resolvedPath,
        type: 'directory',
      };
    }

    throw new Error(`generate --source input must be a local file or directory: ${resolvedPath}`);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(`generate --source path not found: ${resolvedPath}`);
    }

    throw error;
  }
}

async function assertNotDiscoveryReport(source: ResolvedSourceDocsInput): Promise<void> {
  if (source.type !== 'file') {
    return;
  }

  if (basename(source.resolvedPath) === 'discovery-report.json') {
    throw new Error(
      'generate --source requires an explicit local documentation source; discovery reports are candidate evidence for agent review and are not consumed automatically'
    );
  }

  if (extname(source.resolvedPath).toLowerCase() !== '.json') {
    return;
  }

  try {
    const parsed = JSON.parse(await readFile(source.resolvedPath, 'utf-8')) as unknown;

    if (!isRecord(parsed)) {
      return;
    }

    const mode = parsed.mode;
    const looksLikeDiscoveryReport = typeof mode === 'string' && DISCOVERY_REPORT_MODES.has(mode);

    if (looksLikeDiscoveryReport || isCandidateEvidenceReportShape(parsed)) {
      throw new Error(
        'generate --source requires an explicit local documentation source; discovery reports are candidate evidence for agent review and are not consumed automatically'
      );
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      return;
    }

    throw error;
  }
}

async function prepareSourceDocsInput(
  source: ResolvedSourceDocsInput,
  formatHint: ParsedFormatHint
): Promise<PreparedSourceDocsInput> {
  if (source.type === 'file') {
    const resolvedFormat = await resolveSourceDocsFormat(
      source.resolvedPath,
      formatHint.parserHint
    );
    const parser = getSourceDocsParser(resolvedFormat);
    const sourceFile = await describeSourceFile(
      source.resolvedPath,
      basename(source.resolvedPath),
      resolvedFormat
    );

    return {
      resolvedFormat,
      parser,
      sourceFiles: [sourceFile],
      warnings: [],
    };
  }

  if (
    formatHint.parserHint !== FormatType.AUTO &&
    !formatSupportsDirectory(formatHint.parserHint)
  ) {
    throw new Error(
      `generate --source format ${formatHint.parserHint} supports explicit local files only; directory inputs are not supported for this parser`
    );
  }

  const sourceFiles = await describeDirectorySourceFiles(source);
  const resolvedFormat =
    formatHint.parserHint === FormatType.AUTO
      ? resolveDirectoryAutoFormat(sourceFiles.files, source.resolvedPath)
      : (formatHint.parserHint as SourceDocsResolvedFormat);
  const selectedFiles = sourceFiles.files.filter((file) => file.format === resolvedFormat);

  if (selectedFiles.length === 0) {
    throw new Error(
      `No ${resolvedFormat} source files found under local directory: ${source.resolvedPath}`
    );
  }

  return {
    resolvedFormat,
    parser: getSourceDocsParser(resolvedFormat),
    sourceFiles: selectedFiles,
    warnings: sourceFiles.warnings,
  };
}

function getSourceDocsParser(format: SourceDocsResolvedFormat): Parser {
  const parser = getParserForFormat(format);

  if (parser === undefined) {
    throw new Error(`No parser is registered for source format: ${format}`);
  }

  return parser;
}

async function resolveSourceDocsFormat(
  sourcePath: string,
  parserHint: FormatType
): Promise<SourceDocsResolvedFormat> {
  const resolvedFormat = await detectFormat(sourcePath, parserHint);

  if (resolvedFormat === FormatType.AUTO) {
    throw new Error(`Unable to resolve source format for: ${sourcePath}`);
  }

  return resolvedFormat as SourceDocsResolvedFormat;
}

function formatSupportsDirectory(
  format: FormatType
): format is FormatType.MARKDOWN | FormatType.RST | FormatType.HTML {
  return format === FormatType.MARKDOWN || format === FormatType.RST || format === FormatType.HTML;
}

async function describeDirectorySourceFiles(
  source: ResolvedSourceDocsInput
): Promise<SourceFileCollection> {
  const state = {
    entries: 0,
    files: 0,
    warnings: [] as string[],
  };
  const files = await collectDirectorySourceFiles({
    rootPath: source.resolvedPath,
    currentPath: source.resolvedPath,
    depth: 0,
    state,
  });

  if (files.length === 0) {
    throw new Error(
      `No supported source files found under local directory: ${source.resolvedPath}`
    );
  }

  return {
    files: files.sort((a, b) => compareStringsByCodeUnit(a.path, b.path)),
    warnings: state.warnings,
  };
}

async function collectDirectorySourceFiles(options: {
  rootPath: string;
  currentPath: string;
  depth: number;
  state: { entries: number; files: number; warnings: string[] };
}): Promise<BoundedSourceFile[]> {
  const { rootPath, currentPath, depth, state } = options;

  if (depth > DEFAULT_SOURCE_DOCS_MAX_DEPTH) {
    throw new Error(
      `generate --source directory exceeds max traversal depth ${DEFAULT_SOURCE_DOCS_MAX_DEPTH}: ${currentPath}`
    );
  }

  const entries = (await readdir(currentPath, { withFileTypes: true })).sort((a, b) =>
    compareStringsByCodeUnit(a.name, b.name)
  );
  const files: BoundedSourceFile[] = [];

  for (const entry of entries) {
    state.entries++;

    if (state.entries > DEFAULT_SOURCE_DOCS_MAX_ENTRIES) {
      throw new Error(
        `generate --source directory exceeds max traversal entries ${DEFAULT_SOURCE_DOCS_MAX_ENTRIES}`
      );
    }

    const entryPath = join(currentPath, entry.name);

    if (entry.isSymbolicLink()) {
      state.warnings.push(
        `Skipped symlinked source entry: ${relativeSourcePath(rootPath, entryPath)}`
      );
      continue;
    }

    if (entry.isDirectory()) {
      files.push(
        ...(await collectDirectorySourceFiles({
          rootPath,
          currentPath: entryPath,
          depth: depth + 1,
          state,
        }))
      );
      continue;
    }

    const fileFormat = formatForDirectorySourceFile(entry.name);

    if (!entry.isFile() || fileFormat === undefined) {
      continue;
    }

    state.files++;

    if (state.files > DEFAULT_SOURCE_DOCS_MAX_FILES) {
      throw new Error(
        `generate --source directory exceeds max source files ${DEFAULT_SOURCE_DOCS_MAX_FILES}`
      );
    }

    files.push(
      await describeSourceFile(entryPath, relativeSourcePath(rootPath, entryPath), fileFormat)
    );
  }

  return files;
}

async function describeSourceFile(
  resolvedPath: string,
  manifestPath: string,
  format: SourceFileFormat
): Promise<BoundedSourceFile> {
  const [fileStats, hash] = await Promise.all([lstat(resolvedPath), sha256File(resolvedPath)]);

  return {
    path: normalizeManifestPath(manifestPath),
    resolvedPath,
    byteSize: fileStats.size,
    hash,
    format,
  };
}

function formatForDirectorySourceFile(fileName: string): SourceFileFormat | undefined {
  const extension = extname(fileName).toLowerCase();

  if (extension === '.md' || extension === '.mdx' || extension === '.markdown') {
    return FormatType.MARKDOWN;
  }

  if (extension === '.rst') {
    return FormatType.RST;
  }

  if (extension === '.html' || extension === '.htm') {
    return FormatType.HTML;
  }

  if (extension === '.json' || extension === '.yaml' || extension === '.yml') {
    return 'structured-spec';
  }

  return undefined;
}

function resolveDirectoryAutoFormat(
  files: BoundedSourceFile[],
  sourcePath: string
): SourceDocsResolvedFormat {
  const formats = [...new Set(files.map((file) => file.format))].sort(compareStringsByCodeUnit);
  const directoryFormats = formats.filter((format) =>
    formatSupportsDirectory(format as FormatType)
  );
  const structuredSpecOnly = formats.length === 1 && formats[0] === 'structured-spec';

  if (directoryFormats.length === 1 && formats.length === 1) {
    return directoryFormats[0] as SourceDocsResolvedFormat;
  }

  if (structuredSpecOnly) {
    throw new Error(
      `Directory auto-detection for generate --source found only structured spec files under ${sourcePath}; pass an explicit local OpenAPI/OpenRef file instead`
    );
  }

  throw new Error(
    `Directory auto-detection for generate --source is ambiguous for ${sourcePath}; found source formats: ${formats.join(
      ', '
    )}. Specify --format markdown, rst, or html for directory generation.`
  );
}

async function parsePreparedSource(
  source: ResolvedSourceDocsInput,
  preparedSource: PreparedSourceDocsInput
): Promise<DocNode> {
  if (source.type === 'file') {
    return await preparedSource.parser.parse(source.resolvedPath);
  }

  const children: DocNode[] = [];

  for (const file of preparedSource.sourceFiles) {
    children.push(await preparedSource.parser.parse(file.resolvedPath));
  }

  const title = basename(source.resolvedPath) || 'Documentation';
  const metadata = new Map<string, unknown>([
    ['format', preparedSource.resolvedFormat],
    ['sourcePath', source.resolvedPath],
    ['count', children.length],
  ]);
  const root = createDocNode(DocNodeType.ROOT, sanitizeFileSegment(title.toLowerCase()), title, {
    metadata,
  });
  root.children = children;

  return root;
}

async function describeGeneratedOutputs(
  outputDir: string,
  outputPaths: string[]
): Promise<SourceDocsGeneratedOutput[]> {
  const generatedOutputs = await Promise.all(
    outputPaths.map(async (outputPath) => {
      const file = await describeGeneratedTextOutput(outputPath);

      return {
        path: relativeOutputPath(outputDir, outputPath),
        kind: 'llm-docs' as const,
        name: 'agent-readable docs text',
        byteSize: file.byteSize,
        hash: file.hash,
        lineCount: file.lineCount,
        estimatedTokenCount: file.estimatedTokenCount,
      };
    })
  );

  return generatedOutputs.sort((a, b) => compareStringsByCodeUnit(a.path, b.path));
}

async function writeSemanticChunksJsonl(
  outputDir: string,
  root: DocNode
): Promise<SourceDocsGeneratedOutput> {
  const chunksDir = join(outputDir, SOURCE_DOCS_CHUNKS_OUTPUT_DIR);
  const chunksPath = join(chunksDir, SOURCE_DOCS_CHUNKS_JSONL);
  const chunkResult = chunkDocNode(root);
  const lines = chunkResult.chunks.map((chunk) =>
    JSON.stringify(toSemanticChunkJsonlRecord(chunk, chunkResult.warnings))
  );
  const jsonl = lines.length === 0 ? '' : `${lines.join('\n')}\n`;

  await mkdir(chunksDir, { recursive: true });
  await writeFile(chunksPath, jsonl, 'utf-8');

  const file = await describeGeneratedTextOutput(chunksPath);

  return {
    path: relativeOutputPath(outputDir, chunksPath),
    kind: 'semantic-chunks-jsonl',
    name: 'semantic chunks JSONL export',
    byteSize: file.byteSize,
    hash: file.hash,
    lineCount: file.lineCount,
    estimatedTokenCount: file.estimatedTokenCount,
  };
}

function toSemanticChunkJsonlRecord(
  chunk: SemanticChunk,
  globalWarnings: SemanticChunkWarning[]
): SemanticChunk {
  const warnings = semanticChunkWarningsForRecord(chunk, globalWarnings);
  const record: SemanticChunk = {
    id: chunk.id,
    ordinal: chunk.ordinal,
    title: chunk.title,
    path: chunk.path,
    nodePath: chunk.nodePath,
    content: chunk.content,
    contentHash: chunk.contentHash,
    characterCount: chunk.characterCount,
    estimatedTokenCount: chunk.estimatedTokenCount,
    warnings,
    metadata: chunk.metadata,
  };

  if (chunk.sourceFormat !== undefined) {
    record.sourceFormat = chunk.sourceFormat;
  }
  if (chunk.sourcePath !== undefined) {
    record.sourcePath = chunk.sourcePath;
  }

  return record;
}

function semanticChunkWarningsForRecord(
  chunk: SemanticChunk,
  globalWarnings: SemanticChunkWarning[]
): SemanticChunkWarning[] {
  const warnings = [...chunk.warnings];

  for (const warning of globalWarnings) {
    if (!sameStringArray(warning.nodePath, chunk.nodePath)) {
      continue;
    }

    if (warnings.some((existingWarning) => sameSemanticChunkWarning(existingWarning, warning))) {
      continue;
    }

    warnings.push({ ...warning, chunkId: chunk.id });
  }

  return warnings;
}

function sameSemanticChunkWarning(
  left: SemanticChunkWarning,
  right: SemanticChunkWarning
): boolean {
  return (
    left.code === right.code &&
    left.message === right.message &&
    sameStringArray(left.nodePath, right.nodePath)
  );
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function buildSourceDocsManifest(options: {
  source: ResolvedSourceDocsInput;
  formatHint: string;
  resolvedFormat: SourceDocsResolvedFormat;
  parser: Parser;
  generator: SourceDocsGeneratorMetadata;
  sourceFiles: BoundedSourceFile[];
  generatedOutputs: SourceDocsGeneratedOutput[];
  preset?: SourceDocsPresetMetadata;
  warnings: string[];
}): SourceDocsManifest {
  const sourceFiles: SourceDocsFileManifestEntry[] = options.sourceFiles.map((file) => ({
    path: file.path,
    resolvedPath: file.resolvedPath,
    byteSize: file.byteSize,
    hash: file.hash,
    format: options.resolvedFormat,
  }));
  const sourceFile = options.source.type === 'file' ? sourceFiles[0] : undefined;

  return {
    schemaVersion: SOURCE_DOCS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generator: options.generator,
    mode: SOURCE_DOCS_MODE,
    source: {
      input: options.source.input,
      resolvedPath: options.source.resolvedPath,
      type: options.source.type,
      formatHint: options.formatHint,
      resolvedFormat: options.resolvedFormat,
      ...(sourceFile === undefined
        ? {
            fileCount: sourceFiles.length,
            aggregateHash: aggregateSourceFilesHash(sourceFiles),
          }
        : {
            byteSize: sourceFile.byteSize,
            hash: sourceFile.hash,
          }),
    },
    sourceFiles,
    parser: {
      name: options.parser.name,
      version: options.generator.version,
      format: options.resolvedFormat,
    },
    formatter: {
      name: 'UniversalFormatter',
      version: options.generator.version,
      format: SOURCE_DOCS_FORMATTER_FORMAT,
    },
    generatedOutputs: options.generatedOutputs,
    ...(options.preset === undefined ? {} : { preset: options.preset }),
    warnings: [...new Set(options.warnings)].sort(compareStringsByCodeUnit),
  };
}

function isCandidateEvidenceReportShape(value: Record<string, unknown>): boolean {
  const candidates = value.candidates;

  if (!Array.isArray(candidates)) {
    return false;
  }

  if (
    isRecord(value.source) ||
    isRecord(value.repo) ||
    isRecord(value.website) ||
    isRecord(value.traversal) ||
    isRecord(value.crawlPolicy) ||
    Array.isArray(value.inspectedResources)
  ) {
    return true;
  }

  return candidates.some(
    (candidate) =>
      isRecord(candidate) &&
      (isRecord(candidate.evidence) ||
        Array.isArray(candidate.sourceResources) ||
        Array.isArray(candidate.formatHints) ||
        Array.isArray(candidate.hints))
  );
}

function aggregateSourceFilesHash(files: SourceDocsFileManifestEntry[]): string {
  const hash = createHash('sha256');
  hash.update('llm-docs-generator:source-docs-directory:v1\n');

  for (const file of files) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(String(file.byteSize));
    hash.update('\0');
    hash.update(file.hash);
    hash.update('\n');
  }

  return `${HASH_PREFIX}${hash.digest('hex')}`;
}

function collectDocNodeWarnings(root: {
  metadata?: Map<string, unknown>;
  children?: unknown[];
}): string[] {
  const warnings: string[] = [];
  const stack: unknown[] = [root];

  while (stack.length > 0) {
    const current = stack.pop();

    if (!isDocNodeLike(current)) {
      continue;
    }

    const metadataWarnings = current.metadata.get('warnings');

    if (Array.isArray(metadataWarnings)) {
      for (const warning of metadataWarnings) {
        warnings.push(formatWarning(warning));
      }
    }

    for (const child of current.children) {
      stack.push(child);
    }
  }

  return warnings.filter((warning) => warning.length > 0);
}

function formatWarning(warning: unknown): string {
  if (typeof warning === 'string') {
    return warning;
  }

  if (isRecord(warning) && typeof warning.message === 'string') {
    return warning.message;
  }

  return '';
}

function filenamePrefixForSource(sourcePath: string, type: SourceDocsSourceType): string {
  const sourceBasename = basename(sourcePath);
  const rawPrefix =
    type === 'file'
      ? sourceBasename.slice(0, sourceBasename.length - extname(sourceBasename).length)
      : sourceBasename;

  return sanitizeFileSegment(rawPrefix.toLowerCase());
}

function sanitizeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'source';
}

async function clearSourceDocsArtifacts(outputDir: string): Promise<void> {
  await Promise.all([
    rm(join(outputDir, SOURCE_DOCS_MANIFEST), { force: true }),
    rm(join(outputDir, SOURCE_DOCS_OUTPUT_DIR), { recursive: true, force: true }),
    rm(join(outputDir, SOURCE_DOCS_CHUNKS_OUTPUT_DIR), { recursive: true, force: true }),
  ]);
}

function assertFileSourceOutsideSourceDocsArtifacts(
  source: ResolvedSourceDocsInput,
  outputDir: string
): void {
  if (source.type !== 'file') {
    return;
  }

  const resolvedOutputDir = resolve(outputDir);
  const manifestPath = join(resolvedOutputDir, SOURCE_DOCS_MANIFEST);
  const llmDocsDir = join(resolvedOutputDir, SOURCE_DOCS_OUTPUT_DIR);
  const chunksDir = join(resolvedOutputDir, SOURCE_DOCS_CHUNKS_OUTPUT_DIR);

  if (source.resolvedPath === manifestPath) {
    throw new Error(
      'generate --source file input must not be the source-mode manifest path for --output-dir'
    );
  }

  if (isSameOrDescendant(llmDocsDir, source.resolvedPath)) {
    throw new Error(
      'generate --source file input must not be inside the source-mode generated docs directory for --output-dir'
    );
  }

  if (isSameOrDescendant(chunksDir, source.resolvedPath)) {
    throw new Error(
      'generate --source file input must not be inside the source-mode generated chunks directory for --output-dir'
    );
  }
}

function isSourceDocsArtifactPath(
  sourcePath: string | undefined,
  resolvedOutputDir: string
): boolean {
  if (sourcePath === undefined) {
    return false;
  }

  const trimmedSourcePath = sourcePath.trim();

  if (trimmedSourcePath.length === 0) {
    return false;
  }

  const resolvedSourcePath = resolve(trimmedSourcePath);
  const manifestPath = join(resolvedOutputDir, SOURCE_DOCS_MANIFEST);
  const llmDocsDir = join(resolvedOutputDir, SOURCE_DOCS_OUTPUT_DIR);
  const chunksDir = join(resolvedOutputDir, SOURCE_DOCS_CHUNKS_OUTPUT_DIR);

  return (
    resolvedSourcePath === manifestPath ||
    isSameOrDescendant(llmDocsDir, resolvedSourcePath) ||
    isSameOrDescendant(chunksDir, resolvedSourcePath)
  );
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);

  await new Promise<void>((resolvePromise, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });

  return `${HASH_PREFIX}${hash.digest('hex')}`;
}

async function assertOutputDirOutsideSource(
  source: ResolvedSourceDocsInput,
  outputDir: string
): Promise<void> {
  const canonicalSourcePath = await realpath(source.resolvedPath);
  const effectiveOutputPath = await resolveEffectiveOutputPath(outputDir);

  if (source.type === 'file') {
    if (canonicalSourcePath === effectiveOutputPath || source.resolvedPath === outputDir) {
      throw new Error('generate --source --output-dir must not be the same as the source file');
    }

    return;
  }

  if (
    isSameOrDescendant(canonicalSourcePath, effectiveOutputPath) ||
    isSameOrDescendant(source.resolvedPath, outputDir)
  ) {
    throw new Error(
      'generate --source --output-dir must not be the same as, or inside, the explicit --source directory'
    );
  }
}

async function resolveEffectiveOutputPath(outputDir: string): Promise<string> {
  const resolvedOutputDir = resolve(outputDir);
  const missingSegments: string[] = [];
  let currentPath = resolvedOutputDir;

  while (true) {
    try {
      const canonicalExistingPath = await realpath(currentPath);

      return missingSegments.length === 0
        ? canonicalExistingPath
        : join(canonicalExistingPath, ...missingSegments.reverse());
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    const parentPath = dirname(currentPath);

    if (parentPath === currentPath) {
      return resolvedOutputDir;
    }

    missingSegments.push(basename(currentPath));
    currentPath = parentPath;
  }
}

function relativeSourcePath(rootPath: string, filePath: string): string {
  return normalizeManifestPath(relative(rootPath, filePath));
}

function relativeOutputPath(outputDir: string, outputPath: string): string {
  const relativePath = normalizeManifestPath(relative(outputDir, outputPath));

  if (relativePath.length === 0 || relativePath.startsWith('../') || isAbsolute(relativePath)) {
    throw new Error(`generated output path escapes output directory: ${outputPath}`);
  }

  return relativePath;
}

function normalizeManifestPath(path: string): string {
  return path.split(sep).join('/');
}

function isSameOrDescendant(parentPath: string, candidatePath: string): boolean {
  const relativePath = relative(parentPath, candidatePath);

  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function compareStringsByCodeUnit(a: string, b: string): number {
  const length = Math.min(a.length, b.length);

  for (let index = 0; index < length; index++) {
    const difference = a.charCodeAt(index) - b.charCodeAt(index);

    if (difference !== 0) {
      return difference;
    }
  }

  return a.length - b.length;
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
      (error as NodeJS.ErrnoException).code === 'ENOTDIR')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDocNodeLike(value: unknown): value is {
  metadata: Map<string, unknown>;
  children: unknown[];
} {
  return isRecord(value) && value.metadata instanceof Map && Array.isArray(value.children);
}
